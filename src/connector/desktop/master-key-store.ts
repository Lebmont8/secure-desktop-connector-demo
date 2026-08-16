import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const MASTER_KEY_RECORD_VERSION = 1 as const;
const MASTER_KEY_BYTES = 32;

const desktopMasterKeyRecordSchema = z
  .object({
    version: z.literal(MASTER_KEY_RECORD_VERSION),
    backend: z.string().min(1).max(80),
    ciphertext: z.string().min(1),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type DesktopSecretProtectorStatus = {
  available: boolean;
  backend: string;
  platform: NodeJS.Platform;
};

export type DesktopSecretDecryption = {
  plaintext: string;
  shouldReEncrypt: boolean;
};

export interface DesktopSecretProtector {
  status(): Promise<DesktopSecretProtectorStatus>;
  encrypt(plaintext: string): Promise<Buffer>;
  decrypt(ciphertext: Buffer): Promise<DesktopSecretDecryption>;
}

export class DesktopKeychainUnavailableError extends Error {
  readonly code = "DESKTOP_KEYCHAIN_UNAVAILABLE";

  constructor() {
    super("A protected OS keychain is required");
    this.name = "DesktopKeychainUnavailableError";
  }
}

export function assertProtectedDesktopKeychain(
  status: DesktopSecretProtectorStatus
): void {
  const backend = status.backend.trim().toLowerCase();
  if (
    !status.available ||
    !backend ||
    (status.platform === "linux" &&
      ["basic_text", "unknown"].includes(backend))
  ) {
    throw new DesktopKeychainUnavailableError();
  }
}

function decodeMasterKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (
    key.length !== MASTER_KEY_BYTES ||
    key.toString("base64") !== value
  ) {
    throw new Error("Desktop master key record is invalid");
  }
  return key;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyPresent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

export class FileDesktopMasterKeyStore {
  private readonly rootDir: string;
  private readonly recordPath: string;

  constructor(
    rootDir: string,
    private readonly protector: DesktopSecretProtector
  ) {
    this.rootDir = path.resolve(rootDir);
    this.recordPath = path.join(this.rootDir, "master-key.v1.json");
  }

  async loadOrCreate(now = new Date()): Promise<Buffer> {
    const status = await this.protector.status();
    assertProtectedDesktopKeychain(status);
    try {
      return await this.loadExisting(status, now);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    const key = crypto.randomBytes(MASTER_KEY_BYTES);
    const ciphertext = await this.protector.encrypt(key.toString("base64"));
    const record = {
      version: MASTER_KEY_RECORD_VERSION,
      backend: status.backend,
      ciphertext: ciphertext.toString("base64"),
      updatedAt: now.toISOString(),
    };
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.rootDir, 0o700);
    try {
      await fs.writeFile(this.recordPath, JSON.stringify(record), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await fs.chmod(this.recordPath, 0o600);
      return Buffer.from(key);
    } catch (error) {
      key.fill(0);
      if (isAlreadyPresent(error)) {
        return this.loadExisting(status, now);
      }
      throw error;
    }
  }

  private async loadExisting(
    status: DesktopSecretProtectorStatus,
    now: Date
  ): Promise<Buffer> {
    const raw = await fs.readFile(this.recordPath, "utf8");
    const record = desktopMasterKeyRecordSchema.parse(JSON.parse(raw));
    const decrypted = await this.protector.decrypt(
      Buffer.from(record.ciphertext, "base64")
    );
    const key = decodeMasterKey(decrypted.plaintext);
    if (decrypted.shouldReEncrypt) {
      await this.replaceRecord(key, status.backend, now);
    }
    return key;
  }

  private async replaceRecord(
    key: Buffer,
    backend: string,
    now: Date
  ): Promise<void> {
    const ciphertext = await this.protector.encrypt(key.toString("base64"));
    const record = {
      version: MASTER_KEY_RECORD_VERSION,
      backend,
      ciphertext: ciphertext.toString("base64"),
      updatedAt: now.toISOString(),
    };
    const temporary = `${this.recordPath}.tmp-${crypto.randomUUID()}`;
    try {
      await fs.writeFile(temporary, JSON.stringify(record), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(temporary, this.recordPath);
      await fs.chmod(this.recordPath, 0o600);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
