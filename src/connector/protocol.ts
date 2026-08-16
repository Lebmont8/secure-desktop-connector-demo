import crypto from "node:crypto";
import { z } from "zod";

export const DESKTOP_CONNECTOR_PROTOCOL_VERSION = 1 as const;
export const DESKTOP_CONNECTOR_MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
export const DESKTOP_CONNECTOR_HEARTBEAT_SECONDS = 30;
export const DESKTOP_CONNECTOR_REQUEST_TTL_MS = 24 * 60 * 60 * 1_000;
export const DESKTOP_CONNECTOR_COMMAND_LEASE_MS = 30 * 1_000;

export const desktopConnectorPlatformSchema = z.literal("demo");
export type DesktopConnectorPlatform = z.infer<
  typeof desktopConnectorPlatformSchema
>;

const boundedVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-zA-Z0-9._+-]+$/);

export const desktopConnectorPairRequestSchema = z
  .object({
    pairingCode: z.string().min(32).max(128),
    label: z.string().trim().min(1).max(80),
    appVersion: boundedVersionSchema,
    protocolVersion: z.literal(DESKTOP_CONNECTOR_PROTOCOL_VERSION),
    publicKeySpki: z.string().min(40).max(512),
  })
  .strict();

export type DesktopConnectorPairRequest = z.infer<
  typeof desktopConnectorPairRequestSchema
>;

export const desktopConnectorPairingIssueSchema = z
  .object({
    label: z.string().trim().min(1).max(80).default("Desktop connector"),
  })
  .strict();

export const desktopConnectorProfileReportSchema = z
  .object({
    profileId: z.string().min(1).max(128),
    status: z.enum(["LOCKED", "READY", "REAUTH_REQUIRED", "ERROR"]),
    errorCode: z
      .string()
      .regex(/^[A-Z0-9_]{1,64}$/)
      .nullable()
      .default(null),
  })
  .strict();

export type DesktopConnectorProfileReport = z.infer<
  typeof desktopConnectorProfileReportSchema
>;

export const desktopConnectorHeartbeatSchema = z
  .object({
    protocolVersion: z.literal(DESKTOP_CONNECTOR_PROTOCOL_VERSION),
    appVersion: boundedVersionSchema,
    profiles: z.array(desktopConnectorProfileReportSchema).max(100).default([]),
  })
  .strict();

export type DesktopConnectorHeartbeat = z.infer<
  typeof desktopConnectorHeartbeatSchema
>;

export const desktopConnectorInboundMessageSchema = z
  .object({
    protocolVersion: z.literal(DESKTOP_CONNECTOR_PROTOCOL_VERSION),
    profileId: z.string().min(1).max(128),
    providerEventId: z.string().trim().min(1).max(256),
    externalMessageRef: z.string().trim().min(1).max(256),
    externalFanRef: z.string().trim().min(1).max(256),
    body: z.string().trim().min(1).max(4_000),
    sentAt: z.string().datetime(),
  })
  .strict();

export type DesktopConnectorInboundMessage = z.infer<
  typeof desktopConnectorInboundMessageSchema
>;

export const desktopConnectorPollSchema = z
  .object({
    protocolVersion: z.literal(DESKTOP_CONNECTOR_PROTOCOL_VERSION),
  })
  .strict();

export const desktopConnectorCommandKindSchema = z.enum([
  "VERIFY_PROFILE",
  "SYNC_SNAPSHOT",
  "SEND_TEXT",
]);

export type DesktopConnectorCommandKind = z.infer<
  typeof desktopConnectorCommandKindSchema
>;

export const desktopConnectorFailureKindSchema = z.enum([
  "RETRYABLE",
  "PERMANENT",
  "AMBIGUOUS",
]);

export const desktopConnectorSendTextSchema = z
  .object({
    outboundDeliveryId: z.string().min(1).max(128),
    outboundAttemptNumber: z.number().int().positive().max(100),
    externalFanRef: z.string().trim().min(1).max(256),
    body: z.string().trim().min(1).max(4_000),
    clientRequestId: z.string().trim().min(1).max(240),
  })
  .strict();

export type DesktopConnectorSendText = z.infer<
  typeof desktopConnectorSendTextSchema
>;

export const desktopConnectorCommandResultSchema = z
  .object({
    protocolVersion: z.literal(DESKTOP_CONNECTOR_PROTOCOL_VERSION),
    commandId: z.string().min(1).max(128),
    deliveryId: z.string().uuid(),
    ok: z.boolean(),
    resultCode: z.string().regex(/^[A-Z0-9_]{1,64}$/),
    outputDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .default(null),
    failureKind: desktopConnectorFailureKindSchema.nullable().optional(),
    providerExternalRef: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .nullable()
      .optional(),
    sentAt: z.string().datetime().nullable().optional(),
    verifiedCapabilities: z
      .array(z.literal("send_text"))
      .max(1)
      .refine((items) => new Set(items).size === items.length)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ok && value.resultCode !== "OK") {
      context.addIssue({
        code: "custom",
        path: ["resultCode"],
        message: "Successful commands must use resultCode OK",
      });
    }
    if (!value.ok && value.resultCode === "OK") {
      context.addIssue({
        code: "custom",
        path: ["resultCode"],
        message: "Failed commands require a bounded error code",
      });
    }
    if (value.ok && value.failureKind) {
      context.addIssue({
        code: "custom",
        path: ["failureKind"],
        message: "Successful commands cannot include a failure kind",
      });
    }
    if (
      !value.ok &&
      (value.providerExternalRef !== undefined ||
        value.sentAt !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["providerExternalRef"],
        message: "Failed commands cannot include a delivery receipt",
      });
    }
  });

export type DesktopConnectorCommandResult = z.infer<
  typeof desktopConnectorCommandResultSchema
>;

export const desktopConnectorProfileBindingSchema = z
  .object({
    deviceId: z.string().min(1).max(128),
    creatorAccountId: z.string().min(1).max(128),
  })
  .strict();

export const desktopConnectorCommandEnvelopeSchema = z
  .object({
    id: z.string().min(1).max(128),
    deliveryId: z.string().uuid(),
    profileId: z.string().min(1).max(128),
    platform: desktopConnectorPlatformSchema,
    kind: desktopConnectorCommandKindSchema,
    attempt: z.number().int().positive(),
    issuedAt: z.string().datetime(),
    sendText: desktopConnectorSendTextSchema.nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "SEND_TEXT" && !value.sendText) {
      context.addIssue({
        code: "custom",
        path: ["sendText"],
        message: "SEND_TEXT commands require a bounded payload",
      });
    }
    if (value.kind !== "SEND_TEXT" && value.sendText) {
      context.addIssue({
        code: "custom",
        path: ["sendText"],
        message: "Only SEND_TEXT commands may include a text payload",
      });
    }
  });

export type DesktopConnectorCommandEnvelope = z.infer<
  typeof desktopConnectorCommandEnvelopeSchema
>;

export type DesktopConnectorCanonicalRequest = {
  method: "POST";
  path: string;
  deviceId: string;
  requestId: string;
  timestamp: number;
  body: string;
};

export function sha256Hex(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function canonicalDesktopConnectorRequest(
  request: DesktopConnectorCanonicalRequest
): string {
  if (!request.path.startsWith("/api/connectors/desktop/")) {
    throw new Error("Desktop connector request path is outside the protocol");
  }
  return [
    `SECURE-DESKTOP-CONNECTOR/${DESKTOP_CONNECTOR_PROTOCOL_VERSION}`,
    request.method,
    request.path,
    request.deviceId,
    request.requestId,
    String(request.timestamp),
    sha256Hex(request.body),
  ].join("\n");
}

export function desktopConnectorRequestDigest(
  request: DesktopConnectorCanonicalRequest
): string {
  return sha256Hex(canonicalDesktopConnectorRequest(request));
}

export function normalizeEd25519PublicKey(publicKeySpki: string): string {
  const raw = Buffer.from(publicKeySpki, "base64");
  if (raw.length < 40 || raw.length > 256) {
    throw new Error("Desktop connector public key has an invalid size");
  }
  const key = crypto.createPublicKey({
    key: raw,
    format: "der",
    type: "spki",
  });
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Desktop connector public key must be Ed25519");
  }
  return key.export({ format: "der", type: "spki" }).toString("base64");
}

export function verifyDesktopConnectorSignature(
  request: DesktopConnectorCanonicalRequest,
  signature: string,
  publicKeySpki: string
): boolean {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(publicKeySpki, "base64"),
      format: "der",
      type: "spki",
    });
    if (key.asymmetricKeyType !== "ed25519") return false;
    return crypto.verify(
      null,
      Buffer.from(canonicalDesktopConnectorRequest(request), "utf8"),
      key,
      Buffer.from(signature, "base64url")
    );
  } catch {
    return false;
  }
}

export function desktopConnectorCommandResultDigest(
  result: DesktopConnectorCommandResult
): string {
  return sha256Hex(
    JSON.stringify({
      commandId: result.commandId,
      deliveryId: result.deliveryId,
      ok: result.ok,
      resultCode: result.resultCode,
      outputDigest: result.outputDigest,
      failureKind: result.failureKind ?? null,
      providerExternalRef: result.providerExternalRef ?? null,
      sentAt: result.sentAt ?? null,
      verifiedCapabilities: result.verifiedCapabilities ?? [],
    })
  );
}
