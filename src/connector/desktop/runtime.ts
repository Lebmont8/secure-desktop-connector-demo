import {
  DESKTOP_CONNECTOR_PROTOCOL_VERSION,
  type DesktopConnectorCommandEnvelope,
  type DesktopConnectorCommandResult,
  type DesktopConnectorHeartbeat,
  type DesktopConnectorInboundMessage,
  type DesktopConnectorPlatform,
  desktopConnectorInboundMessageSchema,
} from "@/connector/protocol";
import {
  desktopConnectorSnapshotPageSchema,
  type DesktopConnectorSnapshotPage,
} from "@/connector/snapshot";
import {
  executeDesktopCommand,
  type DesktopCommandOutcome,
  type DesktopPlatformDriver,
} from "@/connector/desktop/mock-driver";
import type { FileDesktopProfileVault } from "@/connector/desktop/profile-vault";

export interface DesktopCrmTransport {
  heartbeat(payload: DesktopConnectorHeartbeat): Promise<void>;
  poll(): Promise<DesktopConnectorCommandEnvelope | null>;
  inbound(message: DesktopConnectorInboundMessage): Promise<void>;
  snapshot(page: DesktopConnectorSnapshotPage): Promise<void>;
  complete(result: DesktopConnectorCommandResult): Promise<void>;
}

export interface DesktopCommandReceiptCache {
  get(commandId: string): Promise<DesktopCommandOutcome | null>;
  set(commandId: string, outcome: DesktopCommandOutcome): Promise<void>;
}

export class MemoryDesktopCommandReceiptCache
  implements DesktopCommandReceiptCache
{
  private readonly outcomes = new Map<string, DesktopCommandOutcome>();

  constructor(private readonly maxEntries = 1_000) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error("Desktop command receipt cache limit must be positive");
    }
  }

  async get(commandId: string): Promise<DesktopCommandOutcome | null> {
    return this.outcomes.get(commandId) ?? null;
  }

  async set(
    commandId: string,
    outcome: DesktopCommandOutcome
  ): Promise<void> {
    if (!this.outcomes.has(commandId) && this.outcomes.size >= this.maxEntries) {
      const oldest = this.outcomes.keys().next().value as string | undefined;
      if (oldest) this.outcomes.delete(oldest);
    }
    this.outcomes.set(commandId, { ...outcome });
  }
}

export class DesktopConnectorRuntime {
  constructor(
    private readonly transport: DesktopCrmTransport,
    private readonly vault: FileDesktopProfileVault,
    private readonly driver: DesktopPlatformDriver,
    private readonly receipts: DesktopCommandReceiptCache,
    private readonly heartbeatPayload: () => DesktopConnectorHeartbeat,
    private readonly profileBindings: () => ReadonlyArray<{
      profileId: string;
      platform: DesktopConnectorPlatform;
    }> = () => []
  ) {}

  async runCycle(): Promise<"idle" | "processed"> {
    await this.transport.heartbeat(this.heartbeatPayload());
    let inboundProcessed = false;
    if (this.driver.pollInbound) {
      for (const profile of this.profileBindings()) {
        let localProfile: unknown;
        try {
          localProfile = await this.vault.load(
            profile.profileId,
            profile.platform
          );
        } catch {
          continue;
        }
        await this.driver.pollInbound(
          profile,
          localProfile,
          async (message) => {
            const parsed = desktopConnectorInboundMessageSchema.parse(message);
            if (parsed.profileId !== profile.profileId) {
              throw new Error(
                "DESKTOP_CONNECTOR_INBOUND_PROFILE_MISMATCH"
              );
            }
            await this.transport.inbound(parsed);
            inboundProcessed = true;
          }
        );
      }
    }
    const command = await this.transport.poll();
    if (!command) return inboundProcessed ? "processed" : "idle";

    let outcome = await this.receipts.get(command.id);
    if (!outcome) {
      outcome = await executeDesktopCommand(
        command,
        this.vault,
        this.driver,
        async (page) => {
          const parsed = desktopConnectorSnapshotPageSchema.parse(page);
          if (
            parsed.commandId !== command.id ||
            parsed.deliveryId !== command.deliveryId
          ) {
            throw new Error("DESKTOP_CONNECTOR_SNAPSHOT_COMMAND_MISMATCH");
          }
          await this.transport.snapshot(parsed);
        }
      );
      await this.receipts.set(command.id, outcome);
    }
    await this.transport.complete({
      protocolVersion: DESKTOP_CONNECTOR_PROTOCOL_VERSION,
      commandId: command.id,
      deliveryId: command.deliveryId,
      ...outcome,
    });
    return "processed";
  }

  async runCycleWithReconnect(options: {
    maxAttempts?: number;
    wait?: (milliseconds: number) => Promise<void>;
  } = {}): Promise<"idle" | "processed"> {
    const maxAttempts = options.maxAttempts ?? 5;
    const wait =
      options.wait ??
      ((milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await this.runCycle();
      } catch (error) {
        lastError = error;
        if (attempt + 1 >= maxAttempts) break;
        await wait(Math.min(1_000 * 2 ** attempt, 30_000));
      }
    }
    throw lastError;
  }
}
