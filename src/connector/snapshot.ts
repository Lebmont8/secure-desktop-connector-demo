import { z } from "zod";
import {
  DESKTOP_CONNECTOR_PROTOCOL_VERSION,
  sha256Hex,
} from "@/connector/protocol";

export const DESKTOP_CONNECTOR_MAX_SNAPSHOT_PAGES = 1_000;

const boundedReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^(?!(?:https?|data|file):)[^\u0000-\u001f\u007f]+$/i);

const boundedTextSchema = z.string().trim().min(1).max(4_000);
const optionalBoundedTextSchema = z.string().trim().max(256).nullable();
const nonNegativeCentsSchema = z.number().int().min(0).max(100_000_000);

const snapshotPageBase = z
  .object({
    protocolVersion: z.literal(DESKTOP_CONNECTOR_PROTOCOL_VERSION),
    commandId: z.string().min(1).max(128),
    deliveryId: z.string().uuid(),
    pageIndex: z
      .number()
      .int()
      .min(0)
      .max(DESKTOP_CONNECTOR_MAX_SNAPSHOT_PAGES),
    isLastPage: z.boolean(),
    capturedAt: z.string().datetime(),
  })
  .strict();

export const identitySnapshotPageSchema = snapshotPageBase
  .extend({
    resource: z.literal("IDENTITY"),
    remoteAccountId: boundedReferenceSchema,
    displayName: optionalBoundedTextSchema.default(null),
  })
  .strict();

export const fanSnapshotItemSchema = z
  .object({
    externalFanRef: boundedReferenceSchema,
    username: z.string().trim().min(1).max(128),
    displayName: z.string().trim().min(1).max(256),
    subscribedAt: z.string().datetime(),
    lastActiveAt: z.string().datetime(),
    subscriptionStatus: z.enum(["ACTIVE", "EXPIRED"]),
  })
  .strict();

export const fansSnapshotPageSchema = snapshotPageBase
  .extend({
    resource: z.literal("FANS"),
    items: z.array(fanSnapshotItemSchema).max(100),
  })
  .strict();

export const messageSnapshotItemSchema = z
  .object({
    externalRef: boundedReferenceSchema,
    direction: z.enum(["IN", "OUT"]),
    body: boundedTextSchema,
    sentAt: z.string().datetime(),
    ppvPriceCents: nonNegativeCentsSchema.nullable().default(null),
  })
  .strict();

export const messagesSnapshotPageSchema = snapshotPageBase
  .extend({
    resource: z.literal("MESSAGES"),
    externalFanRef: boundedReferenceSchema,
    items: z.array(messageSnapshotItemSchema).max(50),
  })
  .strict();

export const transactionSnapshotItemSchema = z
  .object({
    externalRef: boundedReferenceSchema,
    externalFanRef: boundedReferenceSchema,
    type: z.enum(["SUBSCRIPTION", "PPV", "TIP"]),
    amountCents: nonNegativeCentsSchema,
    occurredAt: z.string().datetime(),
  })
  .strict();

export const transactionsSnapshotPageSchema = snapshotPageBase
  .extend({
    resource: z.literal("TRANSACTIONS"),
    items: z.array(transactionSnapshotItemSchema).max(100),
  })
  .strict();

export const vaultSnapshotItemSchema = z
  .object({
    externalRef: boundedReferenceSchema,
    title: z.string().trim().min(1).max(256),
    mediaType: z.enum(["PHOTO", "VIDEO", "AUDIO", "BUNDLE"]),
    defaultPriceCents: nonNegativeCentsSchema,
    tags: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
  })
  .strict();

export const vaultSnapshotPageSchema = snapshotPageBase
  .extend({
    resource: z.literal("VAULT"),
    items: z.array(vaultSnapshotItemSchema).max(100),
  })
  .strict();

export const snapshotManifestPageSchema = snapshotPageBase
  .extend({
    resource: z.literal("MANIFEST"),
    pageCount: z
      .number()
      .int()
      .min(1)
      .max(DESKTOP_CONNECTOR_MAX_SNAPSHOT_PAGES),
    itemCounts: z
      .object({
        fans: z.number().int().min(0).max(10_000_000),
        messages: z.number().int().min(0).max(10_000_000),
        transactions: z.number().int().min(0).max(10_000_000),
        vaultItems: z.number().int().min(0).max(10_000_000),
      })
      .strict(),
    snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const desktopConnectorSnapshotPageSchema = z.discriminatedUnion(
  "resource",
  [
    identitySnapshotPageSchema,
    fansSnapshotPageSchema,
    messagesSnapshotPageSchema,
    transactionsSnapshotPageSchema,
    vaultSnapshotPageSchema,
    snapshotManifestPageSchema,
  ]
);

export type DesktopConnectorSnapshotPage = z.infer<
  typeof desktopConnectorSnapshotPageSchema
>;

export type DesktopConnectorSnapshotEmitter = (
  page: DesktopConnectorSnapshotPage
) => Promise<void>;

export function desktopConnectorSnapshotPageDigest(
  page: DesktopConnectorSnapshotPage
): string {
  const parsed = desktopConnectorSnapshotPageSchema.parse(page);
  const stablePage = Object.fromEntries(
    Object.entries(parsed).filter(([key]) => key !== "deliveryId")
  );
  return sha256Hex(JSON.stringify(stablePage));
}

export function desktopConnectorSnapshotDigest(
  pages: DesktopConnectorSnapshotPage[]
): string {
  if (
    pages.length === 0 ||
    pages.some((page) => page.resource === "MANIFEST")
  ) {
    throw new Error("Snapshot digest requires non-manifest pages");
  }
  return desktopConnectorSnapshotDigestFromPageDigests(
    pages.map(desktopConnectorSnapshotPageDigest)
  );
}

export function desktopConnectorSnapshotDigestFromPageDigests(
  pageDigests: string[]
): string {
  if (
    pageDigests.length === 0 ||
    pageDigests.some((digest) => !/^[a-f0-9]{64}$/.test(digest))
  ) {
    throw new Error("Snapshot digest requires valid page digests");
  }
  return sha256Hex(pageDigests.join("\n"));
}
