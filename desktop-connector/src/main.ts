import fs from "node:fs/promises";
import path from "node:path";
import {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  session,
  type IpcMainInvokeEvent,
} from "electron";
import started from "electron-squirrel-startup";
import { z } from "zod";
import {
  DESKTOP_CONNECTOR_HEARTBEAT_SECONDS,
  DESKTOP_CONNECTOR_PROTOCOL_VERSION,
  desktopConnectorPlatformSchema,
  type DesktopConnectorProfileReport,
} from "../../src/connector/protocol";
import {
  FileDesktopDeviceVault,
  toDesktopDeviceCredentials,
} from "../../src/connector/desktop/device-vault";
import {
  createDesktopConnectorIdentity,
} from "../../src/connector/desktop/identity";
import {
  DesktopKeychainUnavailableError,
  FileDesktopMasterKeyStore,
  assertProtectedDesktopKeychain,
} from "../../src/connector/desktop/master-key-store";
import {
  FileDesktopProfileVault,
} from "../../src/connector/desktop/profile-vault";
import {
  FileDesktopCommandReceiptCache,
} from "../../src/connector/desktop/receipt-cache";
import {
  MockDesktopPlatformDriver,
} from "../../src/connector/desktop/mock-driver";
import {
  DesktopConnectorRuntime,
} from "../../src/connector/desktop/runtime";
import type {
  DesktopConnectorMockProfileInput,
  DesktopConnectorPairInput,
  DesktopConnectorPublicStatus,
} from "./contracts";
import { ElectronSafeStorageProtector } from "./electron-secret-protector";
import {
  DesktopConnectorTransportError,
  HttpDesktopCrmTransport,
  pairDesktopConnector,
} from "./http-transport";
import {
  FileDesktopConnectorState,
  type LocalConnectorState,
} from "./state";
import { resetLocalDesktopConnectorData } from "./local-reset";

const APP_SCHEME = "secure-connector";
const APP_HOST = "app";
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'none'",
  "font-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const pairInputSchema = z
  .object({
    crmBaseUrl: z.string().trim().min(1).max(2_048),
    pairingCode: z.string().trim().min(32).max(128),
    label: z.string().trim().min(1).max(80),
  })
  .strict();

const mockProfileInputSchema = z
  .object({
    profileId: z.string().trim().min(1).max(128),
    platform: desktopConnectorPlatformSchema,
    accountRef: z.string().trim().min(1).max(128),
  })
  .strict();

function publicErrorCode(error: unknown): string {
  if (error instanceof DesktopConnectorTransportError) return error.code;
  if (error instanceof DesktopKeychainUnavailableError) return error.code;
  if (error instanceof z.ZodError) return "DESKTOP_CONNECTOR_INPUT_INVALID";
  if (
    error instanceof Error &&
    /^[A-Z0-9_]{1,80}$/.test(error.message)
  ) {
    return error.message;
  }
  return "DESKTOP_CONNECTOR_OPERATION_FAILED";
}

class DesktopConnectorService {
  private readonly dataRoot: string;
  private readonly stateStore: FileDesktopConnectorState;
  private readonly protector = new ElectronSafeStorageProtector();
  private readonly masterKeyStore: FileDesktopMasterKeyStore;
  private running = false;
  private resetting = false;
  private lastRunAt: string | null = null;
  private lastOutcome: "idle" | "processed" | null = null;
  private lastErrorCode: string | null = null;

  constructor() {
    this.dataRoot = path.join(app.getPath("userData"), "connector-data");
    this.stateStore = new FileDesktopConnectorState(
      path.join(this.dataRoot, "state")
    );
    this.masterKeyStore = new FileDesktopMasterKeyStore(
      path.join(this.dataRoot, "keychain"),
      this.protector
    );
  }

  async getStatus(): Promise<DesktopConnectorPublicStatus> {
    const [state, keychainStatus] = await Promise.all([
      this.stateStore.load(),
      this.protector.status(),
    ]);
    let keychainAvailable = true;
    try {
      assertProtectedDesktopKeychain(keychainStatus);
    } catch {
      keychainAvailable = false;
    }
    return {
      appVersion: app.getVersion(),
      keychain: {
        available: keychainAvailable,
        backend: keychainStatus.backend,
      },
      paired: Boolean(state.pairedDevice),
      deviceId: state.pairedDevice?.deviceId ?? null,
      label: state.pairedDevice?.label ?? null,
      crmBaseUrl: state.pairedDevice?.crmBaseUrl ?? null,
      profiles: state.profiles.map((profile) => ({
        ...profile,
        status: "READY" as const,
      })),
      running: this.running,
      lastRunAt: this.lastRunAt,
      lastOutcome: this.lastOutcome,
      lastErrorCode: this.lastErrorCode,
    };
  }

  async pair(
    rawInput: DesktopConnectorPairInput
  ): Promise<DesktopConnectorPublicStatus> {
    const input = pairInputSchema.parse(rawInput);
    const current = await this.stateStore.load();
    if (current.pairedDevice) {
      throw new Error("DESKTOP_CONNECTOR_ALREADY_PAIRED");
    }
    const key = await this.masterKeyStore.loadOrCreate();
    try {
      const identity = createDesktopConnectorIdentity();
      const paired = await pairDesktopConnector({
        ...input,
        appVersion: app.getVersion(),
        identity,
      });
      const deviceVault = new FileDesktopDeviceVault(
        path.join(this.dataRoot, "vault", "devices"),
        key
      );
      await deviceVault.save(
        toDesktopDeviceCredentials({
          deviceId: paired.deviceId,
          deviceToken: paired.deviceToken,
          identity,
        })
      );
      await this.stateStore.save({
        version: 1,
        pairedDevice: {
          deviceId: paired.deviceId,
          label: input.label,
          crmBaseUrl: paired.baseUrl,
          pairedAt: new Date().toISOString(),
        },
        profiles: [],
      });
      this.lastErrorCode = null;
    } finally {
      key.fill(0);
    }
    return this.getStatus();
  }

  async addMockProfile(
    rawInput: DesktopConnectorMockProfileInput
  ): Promise<DesktopConnectorPublicStatus> {
    const input = mockProfileInputSchema.parse(rawInput);
    const state = await this.stateStore.load();
    const paired = this.requirePaired(state);
    const key = await this.masterKeyStore.loadOrCreate();
    try {
      const vault = new FileDesktopProfileVault(
        path.join(this.dataRoot, "vault", "profiles"),
        paired.deviceId,
        key
      );
      await vault.save(input.profileId, input.platform, {
        transport: "mock",
        accountRef: input.accountRef,
        fixtureRevision: 1,
      });
      const profiles = state.profiles.filter(
        (profile) => profile.profileId !== input.profileId
      );
      profiles.push({
        profileId: input.profileId,
        platform: input.platform,
      });
      await this.stateStore.save({ ...state, profiles });
      this.lastErrorCode = null;
    } finally {
      key.fill(0);
    }
    return this.getStatus();
  }

  async removeMockProfile(
    rawProfileId: string
  ): Promise<DesktopConnectorPublicStatus> {
    const profileId = z.string().trim().min(1).max(128).parse(rawProfileId);
    const state = await this.stateStore.load();
    const paired = this.requirePaired(state);
    const key = await this.masterKeyStore.loadOrCreate();
    try {
      const vault = new FileDesktopProfileVault(
        path.join(this.dataRoot, "vault", "profiles"),
        paired.deviceId,
        key
      );
      await vault.remove(profileId);
      await this.stateStore.save({
        ...state,
        profiles: state.profiles.filter(
          (profile) => profile.profileId !== profileId
        ),
      });
    } finally {
      key.fill(0);
    }
    return this.getStatus();
  }

  async forgetPairing(): Promise<DesktopConnectorPublicStatus> {
    if (this.running || this.resetting) {
      throw new Error("DESKTOP_CONNECTOR_RESET_BUSY");
    }
    this.resetting = true;
    try {
      await resetLocalDesktopConnectorData(this.dataRoot);
      this.lastRunAt = null;
      this.lastOutcome = null;
      this.lastErrorCode = null;
    } finally {
      this.resetting = false;
    }
    return this.getStatus();
  }

  async runOnce(): Promise<DesktopConnectorPublicStatus> {
    if (this.resetting) return this.getStatus();
    if (this.running) return this.getStatus();
    const state = await this.stateStore.load();
    if (!state.pairedDevice) return this.getStatus();

    this.running = true;
    let key: Buffer | null = null;
    try {
      key = await this.masterKeyStore.loadOrCreate();
      const paired = state.pairedDevice;
      const deviceVault = new FileDesktopDeviceVault(
        path.join(this.dataRoot, "vault", "devices"),
        key
      );
      const profileVault = new FileDesktopProfileVault(
        path.join(this.dataRoot, "vault", "profiles"),
        paired.deviceId,
        key
      );
      const credentials = await deviceVault.load(paired.deviceId);
      const reports = await this.profileReports(state, profileVault);
      const transport = new HttpDesktopCrmTransport(paired.crmBaseUrl, {
        deviceId: paired.deviceId,
        deviceToken: credentials.deviceToken,
        identity: {
          publicKeySpki: credentials.publicKeySpki,
          privateKeyPkcs8: credentials.privateKeyPkcs8,
        },
      });
      const runtime = new DesktopConnectorRuntime(
        transport,
        profileVault,
        new MockDesktopPlatformDriver(),
        new FileDesktopCommandReceiptCache(
          path.join(this.dataRoot, "receipts")
        ),
        () => ({
          protocolVersion: DESKTOP_CONNECTOR_PROTOCOL_VERSION,
          appVersion: app.getVersion(),
          profiles: reports,
        }),
        () => state.profiles
      );
      this.lastOutcome = await runtime.runCycleWithReconnect({
        maxAttempts: 3,
      });
      this.lastRunAt = new Date().toISOString();
      this.lastErrorCode = null;
    } catch (error) {
      this.lastRunAt = new Date().toISOString();
      this.lastErrorCode = publicErrorCode(error);
      throw new Error(this.lastErrorCode);
    } finally {
      key?.fill(0);
      this.running = false;
    }
    return this.getStatus();
  }

  private requirePaired(
    state: LocalConnectorState
  ): NonNullable<LocalConnectorState["pairedDevice"]> {
    if (!state.pairedDevice) {
      throw new Error("DESKTOP_CONNECTOR_NOT_PAIRED");
    }
    return state.pairedDevice;
  }

  private async profileReports(
    state: LocalConnectorState,
    vault: FileDesktopProfileVault
  ): Promise<DesktopConnectorProfileReport[]> {
    return Promise.all(
      state.profiles.map(async (profile) => {
        try {
          await vault.load(profile.profileId, profile.platform);
          return {
            profileId: profile.profileId,
            status: "READY" as const,
            errorCode: null,
          };
        } catch {
          return {
            profileId: profile.profileId,
            status: "LOCKED" as const,
            errorCode: "LOCAL_PROFILE_LOCKED",
          };
        }
      })
    );
  }
}

function trustedRenderer(event: IpcMainInvokeEvent): boolean {
  const frameUrl = event.senderFrame?.url;
  if (!frameUrl) return false;
  try {
    const parsed = new URL(frameUrl);
    return (
      parsed.protocol === `${APP_SCHEME}:` &&
      parsed.host === APP_HOST &&
      parsed.pathname === "/index.html"
    );
  } catch {
    return false;
  }
}

function registerIpc(service: DesktopConnectorService): void {
  const handle = <Result>(
    channel: string,
    operation: (input: unknown) => Promise<Result> | Result
  ) => {
    ipcMain.handle(channel, async (event, input) => {
      if (!trustedRenderer(event)) {
        throw new Error("DESKTOP_CONNECTOR_IPC_FORBIDDEN");
      }
      try {
        return await operation(input);
      } catch (error) {
        throw new Error(publicErrorCode(error));
      }
    });
  };
  handle("connector:get-status", () => service.getStatus());
  handle("connector:pair", (input) =>
    service.pair(input as DesktopConnectorPairInput)
  );
  handle("connector:forget-pairing", () => service.forgetPairing());
  handle("connector:add-mock-profile", (input) =>
    service.addMockProfile(input as DesktopConnectorMockProfileInput)
  );
  handle("connector:remove-mock-profile", (input) =>
    service.removeMockProfile(input as string)
  );
  handle("connector:run-once", () => service.runOnce());
}

async function registerLocalProtocol(): Promise<void> {
  const root = app.getAppPath();
  const assets = new Map<
    string,
    { path: string; contentType: string }
  >([
    [
      "/index.html",
      {
        path: path.join(root, "desktop-connector", "static", "index.html"),
        contentType: "text/html; charset=utf-8",
      },
    ],
    [
      "/styles.css",
      {
        path: path.join(root, "desktop-connector", "static", "styles.css"),
        contentType: "text/css; charset=utf-8",
      },
    ],
    [
      "/renderer.js",
      {
        path: path.join(root, "desktop-connector", "dist", "renderer.js"),
        contentType: "text/javascript; charset=utf-8",
      },
    ],
  ]);
  await protocol.handle(APP_SCHEME, async (request) => {
    const parsed = new URL(request.url);
    const asset = parsed.host === APP_HOST ? assets.get(parsed.pathname) : null;
    if (request.method !== "GET" || !asset) {
      return new Response("Not found", { status: 404 });
    }
    const content = await fs.readFile(asset.path);
    return new Response(new Uint8Array(content), {
      status: 200,
      headers: {
        "content-type": asset.contentType,
        "content-security-policy": CSP,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 920,
    height: 760,
    minWidth: 760,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#0b1020",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== `${APP_ORIGIN}/index.html`) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  void window.loadURL(`${APP_ORIGIN}/index.html`);
  window.once("ready-to-show", () => window.show());
  return window;
}

let mainWindow: BrowserWindow | null = null;
let runtimeTimer: NodeJS.Timeout | null = null;

if (started) {
  app.quit();
} else {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: false,
        corsEnabled: false,
      },
    },
  ]);
  app.enableSandbox();
  if (process.platform === "win32") {
    app.setAppUserModelId(
      "com.squirrel.SecureConnector.secure-connector"
    );
  }

  const acquiredSingleInstanceLock = app.requestSingleInstanceLock();
  if (!acquiredSingleInstanceLock) {
    app.quit();
  } else {
    app.on("second-instance", () => {
      if (!mainWindow) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    });

    void app.whenReady().then(async () => {
      await registerLocalProtocol();
      session.defaultSession.setPermissionCheckHandler(() => false);
      session.defaultSession.setPermissionRequestHandler(
        (_webContents, _permission, callback) => callback(false)
      );
      const service = new DesktopConnectorService();
      registerIpc(service);
      mainWindow = createWindow();
      runtimeTimer = setInterval(() => {
        void service.runOnce().catch(() => undefined);
      }, DESKTOP_CONNECTOR_HEARTBEAT_SECONDS * 1_000);

      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          mainWindow = createWindow();
        }
      });
    });
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (runtimeTimer) clearInterval(runtimeTimer);
});
