import { z } from "zod";
import {
  sha256Hex,
  type DesktopConnectorCommandEnvelope,
  type DesktopConnectorCommandResult,
  type DesktopConnectorInboundMessage,
  type DesktopConnectorPlatform,
} from "@/connector/protocol";
import type { DesktopConnectorSnapshotEmitter } from "@/connector/snapshot";
import type { FileDesktopProfileVault } from "@/connector/desktop/profile-vault";

const mockDesktopProfileSchema = z
  .object({
    transport: z.literal("mock"),
    accountRef: z.string().min(1).max(128),
    fixtureRevision: z.number().int().positive().default(1),
  })
  .strict();

export type DesktopCommandOutcome = Pick<
  DesktopConnectorCommandResult,
  | "ok"
  | "resultCode"
  | "outputDigest"
  | "failureKind"
  | "providerExternalRef"
  | "sentAt"
  | "verifiedCapabilities"
>;

export interface DesktopPlatformDriver {
  execute(
    command: DesktopConnectorCommandEnvelope,
    localProfile: unknown,
    emitSnapshotPage: DesktopConnectorSnapshotEmitter
  ): Promise<DesktopCommandOutcome>;
  pollInbound?(
    profile: {
      profileId: string;
      platform: DesktopConnectorPlatform;
    },
    localProfile: unknown,
    emitInbound: (message: DesktopConnectorInboundMessage) => Promise<void>
  ): Promise<void>;
}

// Deterministic and network-free. It exercises the exact desktop protocol
// boundary without opening a browser or touching a real external platform.
export class MockDesktopPlatformDriver implements DesktopPlatformDriver {
  async execute(
    command: DesktopConnectorCommandEnvelope,
    localProfile: unknown
  ): Promise<DesktopCommandOutcome> {
    const profile = mockDesktopProfileSchema.safeParse(localProfile);
    if (!profile.success) {
      return {
        ok: false,
        resultCode: "MOCK_PROFILE_INVALID",
        outputDigest: null,
      };
    }
    const outputDigest = sha256Hex(
      JSON.stringify({
        commandId: command.id,
        kind: command.kind,
        accountRef: profile.data.accountRef,
        fixtureRevision: profile.data.fixtureRevision,
        ...(command.kind === "SEND_TEXT"
          ? {
              outboundDeliveryId: command.sendText?.outboundDeliveryId,
              bodyDigest: sha256Hex(command.sendText?.body ?? ""),
            }
          : {}),
      })
    );
    return command.kind === "SEND_TEXT"
      ? {
          ok: true,
          resultCode: "OK",
          outputDigest,
          providerExternalRef: `mock:${command.sendText?.outboundDeliveryId}`,
          sentAt: command.issuedAt,
        }
      : { ok: true, resultCode: "OK", outputDigest };
  }
}

export async function executeDesktopCommand(
  command: DesktopConnectorCommandEnvelope,
  vault: FileDesktopProfileVault,
  driver: DesktopPlatformDriver,
  emitSnapshotPage: DesktopConnectorSnapshotEmitter
): Promise<DesktopCommandOutcome> {
  let localProfile: unknown;
  try {
    localProfile = await vault.load(command.profileId, command.platform);
  } catch {
    return {
      ok: false,
      resultCode: "LOCAL_PROFILE_LOCKED",
      outputDigest: null,
    };
  }
  return driver.execute(command, localProfile, emitSnapshotPage);
}
