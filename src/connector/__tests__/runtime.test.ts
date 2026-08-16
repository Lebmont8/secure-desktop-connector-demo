import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_CONNECTOR_PROTOCOL_VERSION,
  type DesktopConnectorCommandEnvelope,
  type DesktopConnectorCommandResult,
} from "@/connector/protocol";
import {
  createDesktopProfileVaultKey,
  FileDesktopProfileVault,
} from "@/connector/desktop/profile-vault";
import {
  DesktopConnectorRuntime,
  MemoryDesktopCommandReceiptCache,
  type DesktopCrmTransport,
} from "@/connector/desktop/runtime";
import type { DesktopPlatformDriver } from "@/connector/desktop/mock-driver";

const temporaryRoots: string[] = [];

async function profileVault(): Promise<FileDesktopProfileVault> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secure-runtime-"));
  temporaryRoots.push(root);
  const vault = new FileDesktopProfileVault(
    root,
    "device-a",
    createDesktopProfileVaultKey()
  );
  await vault.save("profile-a", "demo", {
    transport: "mock",
    accountRef: "fixture-a",
  });
  return vault;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true })
    )
  );
});

describe("desktop connector reconnect and local dedupe", () => {
  it("reconnects after a dropped completion without executing the command twice", async () => {
    const command: DesktopConnectorCommandEnvelope = {
      id: "command-a",
      deliveryId: "4d6d3b0a-03be-46da-8611-7619b21a620f",
      profileId: "profile-a",
      platform: "demo",
      kind: "VERIFY_PROFILE",
      attempt: 1,
      issuedAt: "2026-07-26T14:00:00.000Z",
    };
    let completionAttempts = 0;
    const completed: DesktopConnectorCommandResult[] = [];
    const transport: DesktopCrmTransport = {
      heartbeat: vi.fn(async () => undefined),
      poll: vi.fn(async () => command),
      inbound: vi.fn(async () => undefined),
      snapshot: vi.fn(async () => undefined),
      complete: vi.fn(async (result) => {
        completionAttempts += 1;
        if (completionAttempts === 1) {
          throw new Error("MOCK_CRM_CONNECTION_DROPPED");
        }
        completed.push(result);
      }),
    };
    const execute = vi.fn(async () => ({
      ok: true as const,
      resultCode: "OK",
      outputDigest: "a".repeat(64),
    }));
    const driver: DesktopPlatformDriver = { execute };
    const waits: number[] = [];
    const runtime = new DesktopConnectorRuntime(
      transport,
      await profileVault(),
      driver,
      new MemoryDesktopCommandReceiptCache(),
      () => ({
        protocolVersion: DESKTOP_CONNECTOR_PROTOCOL_VERSION,
        appVersion: "0.1.0",
        profiles: [],
      })
    );

    await expect(
      runtime.runCycleWithReconnect({
        maxAttempts: 3,
        wait: async (milliseconds) => {
          waits.push(milliseconds);
        },
      })
    ).resolves.toBe("processed");

    expect(execute).toHaveBeenCalledTimes(1);
    expect(completionAttempts).toBe(2);
    expect(completed).toHaveLength(1);
    expect(waits).toEqual([1_000]);
  });

  it("uploads normalized snapshot pages before completing a command", async () => {
    const command: DesktopConnectorCommandEnvelope = {
      id: "command-snapshot",
      deliveryId: "4d6d3b0a-03be-46da-8611-7619b21a620f",
      profileId: "profile-a",
      platform: "demo",
      kind: "VERIFY_PROFILE",
      attempt: 1,
      issuedAt: "2026-07-26T14:00:00.000Z",
    };
    const events: string[] = [];
    const transport: DesktopCrmTransport = {
      heartbeat: vi.fn(async () => undefined),
      poll: vi.fn(async () => command),
      inbound: vi.fn(async () => undefined),
      snapshot: vi.fn(async () => {
        events.push("snapshot");
      }),
      complete: vi.fn(async () => {
        events.push("complete");
      }),
    };
    const driver: DesktopPlatformDriver = {
      execute: vi.fn(async (leased, _profile, emitSnapshotPage) => {
        await emitSnapshotPage({
          protocolVersion: DESKTOP_CONNECTOR_PROTOCOL_VERSION,
          commandId: leased.id,
          deliveryId: leased.deliveryId,
          resource: "IDENTITY",
          pageIndex: 0,
          isLastPage: true,
          capturedAt: "2026-07-26T14:00:00.000Z",
          remoteAccountId: "fixture-account-a",
          displayName: "Fixture creator",
        });
        return {
          ok: true as const,
          resultCode: "OK",
          outputDigest: "b".repeat(64),
        };
      }),
    };
    const runtime = new DesktopConnectorRuntime(
      transport,
      await profileVault(),
      driver,
      new MemoryDesktopCommandReceiptCache(),
      () => ({
        protocolVersion: DESKTOP_CONNECTOR_PROTOCOL_VERSION,
        appVersion: "0.2.0",
        profiles: [],
      })
    );

    await expect(runtime.runCycle()).resolves.toBe("processed");
    expect(events).toEqual(["snapshot", "complete"]);
  });

  it("bounds the in-memory receipt cache", async () => {
    const receipts = new MemoryDesktopCommandReceiptCache(2);
    const outcome = {
      ok: true as const,
      resultCode: "OK",
      outputDigest: "a".repeat(64),
    };
    await receipts.set("command-a", outcome);
    await receipts.set("command-b", outcome);
    await receipts.set("command-c", outcome);

    await expect(receipts.get("command-a")).resolves.toBeNull();
    await expect(receipts.get("command-b")).resolves.toEqual(outcome);
    await expect(receipts.get("command-c")).resolves.toEqual(outcome);
  });
});
