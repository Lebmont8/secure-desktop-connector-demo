import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { DesktopCommandOutcome } from "@/connector/desktop/mock-driver";
import type { DesktopCommandReceiptCache } from "@/connector/desktop/runtime";

const RECEIPT_CACHE_VERSION = 1 as const;

const receiptOutcomeSchema = z
  .object({
    ok: z.boolean(),
    resultCode: z.string().regex(/^[A-Z0-9_]{1,64}$/),
    outputDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    failureKind: z
      .enum(["RETRYABLE", "PERMANENT", "AMBIGUOUS"])
      .nullable()
      .optional(),
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
      .optional(),
  })
  .strict();

const receiptCacheSchema = z
  .object({
    version: z.literal(RECEIPT_CACHE_VERSION),
    receipts: z.array(
      z
        .object({
          commandId: z.string().min(1).max(128),
          outcome: receiptOutcomeSchema,
          recordedAt: z.string().datetime(),
        })
        .strict()
    ),
  })
  .strict();

type ReceiptCacheRecord = z.infer<typeof receiptCacheSchema>;

export class FileDesktopCommandReceiptCache
  implements DesktopCommandReceiptCache
{
  private readonly filePath: string;

  constructor(
    rootDir: string,
    private readonly maxEntries = 1_000
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error("Desktop command receipt cache limit must be positive");
    }
    this.filePath = path.join(path.resolve(rootDir), "receipts.v1.json");
  }

  async get(commandId: string): Promise<DesktopCommandOutcome | null> {
    const cache = await this.read();
    const receipt = cache.receipts.find(
      (candidate) => candidate.commandId === commandId
    );
    return receipt ? { ...receipt.outcome } : null;
  }

  async set(
    commandId: string,
    outcome: DesktopCommandOutcome,
    now = new Date()
  ): Promise<void> {
    const parsedOutcome = receiptOutcomeSchema.parse(outcome);
    const cache = await this.read();
    const receipts = cache.receipts.filter(
      (candidate) => candidate.commandId !== commandId
    );
    receipts.push({
      commandId,
      outcome: parsedOutcome,
      recordedAt: now.toISOString(),
    });
    await this.write({
      version: RECEIPT_CACHE_VERSION,
      receipts: receipts.slice(-this.maxEntries),
    });
  }

  private async read(): Promise<ReceiptCacheRecord> {
    try {
      return receiptCacheSchema.parse(
        JSON.parse(await fs.readFile(this.filePath, "utf8"))
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: RECEIPT_CACHE_VERSION, receipts: [] };
      }
      throw error;
    }
  }

  private async write(record: ReceiptCacheRecord): Promise<void> {
    const rootDir = path.dirname(this.filePath);
    await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
    await fs.chmod(rootDir, 0o700);
    const temporary = `${this.filePath}.tmp-${crypto.randomUUID()}`;
    try {
      await fs.writeFile(temporary, JSON.stringify(record), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(temporary, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
