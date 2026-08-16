import crypto from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import {
  DESKTOP_CONNECTOR_MAX_CLOCK_SKEW_MS,
  DESKTOP_CONNECTOR_PROTOCOL_VERSION,
  canonicalDesktopConnectorRequest,
  desktopConnectorCommandResultSchema,
  desktopConnectorHeartbeatSchema,
  desktopConnectorPairRequestSchema,
  desktopConnectorPollSchema,
  sha256Hex,
  verifyDesktopConnectorSignature,
  type DesktopConnectorCommandEnvelope,
} from "../../src/connector/protocol";

const MAX_BODY_BYTES = 64 * 1024;

type Device = {
  id: string;
  tokenHash: string;
  publicKeySpki: string;
};

function boundedJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    total += value.length;
    if (total > MAX_BODY_BYTES) throw new Error("BODY_TOO_LARGE");
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export class DemoControlPlane {
  readonly pairingCode = crypto.randomBytes(24).toString("base64url");
  readonly server = http.createServer((request, response) => {
    void this.handle(request, response);
  });

  private device: Device | null = null;
  private pairingUsed = false;
  private queuedCommand: DesktopConnectorCommandEnvelope | null = null;
  private readonly requestIds = new Set<string>();
  private readonly completedCommands = new Set<string>();

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method === "GET" && request.url === "/health") {
        boundedJson(response, 200, { ok: true, paired: Boolean(this.device) });
        return;
      }
      if (request.method !== "POST" || !request.url) {
        boundedJson(response, 404, { ok: false, error: "NOT_FOUND" });
        return;
      }
      const body = await readBody(request);
      if (request.url === "/api/connectors/desktop/pair") {
        this.pair(body, response);
        return;
      }
      if (!this.authenticate(request, body)) {
        boundedJson(response, 401, { ok: false, error: "DESKTOP_CONNECTOR_AUTH_FAILED" });
        return;
      }
      if (request.url === "/api/connectors/desktop/heartbeat") {
        const heartbeat = desktopConnectorHeartbeatSchema.parse(JSON.parse(body));
        const profile = heartbeat.profiles.find((item) => item.status === "READY");
        if (profile && !this.queuedCommand && this.completedCommands.size === 0) {
          this.queuedCommand = {
            id: crypto.randomUUID(),
            deliveryId: crypto.randomUUID(),
            profileId: profile.profileId,
            platform: "demo",
            kind: "VERIFY_PROFILE",
            attempt: 1,
            issuedAt: new Date().toISOString(),
          };
        }
        boundedJson(response, 200, { ok: true });
        return;
      }
      if (request.url === "/api/connectors/desktop/commands/poll") {
        desktopConnectorPollSchema.parse(JSON.parse(body));
        boundedJson(response, 200, {
          ok: true,
          duplicate: false,
          command: this.queuedCommand,
        });
        return;
      }
      if (request.url === "/api/connectors/desktop/commands/result") {
        const result = desktopConnectorCommandResultSchema.parse(JSON.parse(body));
        if (!this.queuedCommand || result.commandId !== this.queuedCommand.id) {
          boundedJson(response, 409, { ok: false, error: "DESKTOP_CONNECTOR_COMMAND_MISMATCH" });
          return;
        }
        this.completedCommands.add(result.commandId);
        this.queuedCommand = null;
        boundedJson(response, 200, { ok: true });
        return;
      }
      boundedJson(response, 404, { ok: false, error: "NOT_FOUND" });
    } catch (error) {
      const code = error instanceof Error && error.message === "BODY_TOO_LARGE"
        ? "BODY_TOO_LARGE"
        : "INVALID_REQUEST";
      boundedJson(response, code === "BODY_TOO_LARGE" ? 413 : 400, { ok: false, error: code });
    }
  }

  private pair(body: string, response: ServerResponse): void {
    const value = desktopConnectorPairRequestSchema.parse(JSON.parse(body));
    if (this.pairingUsed || !safeEqual(value.pairingCode, this.pairingCode)) {
      boundedJson(response, 401, { ok: false, error: "DESKTOP_CONNECTOR_PAIRING_INVALID" });
      return;
    }
    const deviceToken = crypto.randomBytes(32).toString("base64url");
    this.device = {
      id: crypto.randomUUID(),
      tokenHash: sha256Hex(deviceToken),
      publicKeySpki: value.publicKeySpki,
    };
    this.pairingUsed = true;
    boundedJson(response, 200, {
      ok: true,
      deviceId: this.device.id,
      deviceToken,
      protocolVersion: DESKTOP_CONNECTOR_PROTOCOL_VERSION,
      heartbeatIntervalSeconds: 30,
    });
  }

  private authenticate(request: IncomingMessage, body: string): boolean {
    if (!this.device) return false;
    const authorization = request.headers.authorization ?? "";
    const token = authorization.startsWith("Connector ")
      ? authorization.slice("Connector ".length)
      : "";
    const deviceId = String(request.headers["x-connector-device-id"] ?? "");
    const requestId = String(request.headers["x-connector-request-id"] ?? "");
    const timestampRaw = String(request.headers["x-connector-timestamp"] ?? "");
    const signature = String(request.headers["x-connector-signature"] ?? "");
    const timestamp = Number(timestampRaw);
    if (
      !token ||
      !safeEqual(sha256Hex(token), this.device.tokenHash) ||
      deviceId !== this.device.id ||
      !requestId ||
      this.requestIds.has(requestId) ||
      !Number.isSafeInteger(timestamp) ||
      Math.abs(Date.now() - timestamp) > DESKTOP_CONNECTOR_MAX_CLOCK_SKEW_MS
    ) {
      return false;
    }
    const valid = verifyDesktopConnectorSignature(
      {
        method: "POST",
        path: request.url ?? "",
        deviceId,
        requestId,
        timestamp,
        body,
      },
      signature,
      this.device.publicKeySpki
    );
    if (valid) this.requestIds.add(requestId);
    return valid;
  }
}
