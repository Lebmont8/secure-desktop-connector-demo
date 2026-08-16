import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  desktopConnectorPlatformSchema,
  sha256Hex,
  type DesktopConnectorPlatform,
} from "@/connector/protocol";

const PROFILE_VAULT_VERSION = 1 as const;
const MAX_PROFILE_PLAINTEXT_BYTES = 128 * 1024;

const encryptedDesktopProfileSchema = z
  .object({
    version: z.literal(PROFILE_VAULT_VERSION),
    profileId: z.string().min(1).max(128),
    platform: desktopConnectorPlatformSchema,
    ciphertext: z.string().min(1),
    iv: z.string().min(1),
    authTag: z.string().min(1),
    updatedAt: z.string().datetime(),
  })
  .strict();

type EncryptedDesktopProfile = z.infer<
  typeof encryptedDesktopProfileSchema
>;

function assertVaultKey(key: Buffer): void {
  if (key.length !== 32) {
    throw new Error("Desktop profile vault requires a 32-byte key");
  }
}

function profileAad(
  deviceId: string,
  profileId: string,
  platform: DesktopConnectorPlatform
): string {
  return [
    "secure-desktop-profile",
    `v${PROFILE_VAULT_VERSION}`,
    deviceId,
    profileId,
    platform,
  ].join(":");
}

function sealProfile(
  deviceId: string,
  profileId: string,
  platform: DesktopConnectorPlatform,
  payload: unknown,
  key: Buffer,
  now: Date
): EncryptedDesktopProfile {
  assertVaultKey(key);
  const plaintext = JSON.stringify(payload);
  if (Buffer.byteLength(plaintext, "utf8") > MAX_PROFILE_PLAINTEXT_BYTES) {
    throw new Error("Desktop profile payload exceeds the local vault limit");
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(profileAad(deviceId, profileId, platform), "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    version: PROFILE_VAULT_VERSION,
    profileId,
    platform,
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    updatedAt: now.toISOString(),
  };
}

function openProfile(
  deviceId: string,
  expectedProfileId: string,
  expectedPlatform: DesktopConnectorPlatform,
  record: EncryptedDesktopProfile,
  key: Buffer
): unknown {
  assertVaultKey(key);
  if (
    record.profileId !== expectedProfileId ||
    record.platform !== expectedPlatform
  ) {
    throw new Error("Desktop profile binding does not match the local vault");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(record.iv, "base64")
  );
  decipher.setAAD(
    Buffer.from(
      profileAad(deviceId, expectedProfileId, expectedPlatform),
      "utf8"
    )
  );
  decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as unknown;
}

export function createDesktopProfileVaultKey(): Buffer {
  return crypto.randomBytes(32);
}

export class FileDesktopProfileVault {
  private readonly rootDir: string;
  private readonly key: Buffer;

  constructor(
    rootDir: string,
    private readonly deviceId: string,
    key: Buffer
  ) {
    if (!deviceId || deviceId.length > 128) {
      throw new Error("Desktop connector device id is invalid");
    }
    assertVaultKey(key);
    this.rootDir = path.resolve(rootDir);
    this.key = Buffer.from(key);
  }

  private profilePath(profileId: string): string {
    if (!profileId || profileId.length > 128) {
      throw new Error("Desktop connector profile id is invalid");
    }
    return path.join(this.rootDir, `${sha256Hex(profileId)}.profile.json`);
  }

  async save(
    profileId: string,
    platform: DesktopConnectorPlatform,
    payload: unknown,
    now = new Date()
  ): Promise<void> {
    const parsedPlatform = desktopConnectorPlatformSchema.parse(platform);
    const record = sealProfile(
      this.deviceId,
      profileId,
      parsedPlatform,
      payload,
      this.key,
      now
    );
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.rootDir, 0o700);

    const destination = this.profilePath(profileId);
    const temporary = `${destination}.tmp-${crypto.randomUUID()}`;
    try {
      await fs.writeFile(temporary, JSON.stringify(record), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(temporary, destination);
      await fs.chmod(destination, 0o600);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async load(
    profileId: string,
    platform: DesktopConnectorPlatform
  ): Promise<unknown> {
    const parsedPlatform = desktopConnectorPlatformSchema.parse(platform);
    const raw = await fs.readFile(this.profilePath(profileId), "utf8");
    const record = encryptedDesktopProfileSchema.parse(JSON.parse(raw));
    return openProfile(
      this.deviceId,
      profileId,
      parsedPlatform,
      record,
      this.key
    );
  }

  async remove(profileId: string): Promise<boolean> {
    try {
      await fs.unlink(this.profilePath(profileId));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}
