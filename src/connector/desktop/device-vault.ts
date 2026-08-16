import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  DESKTOP_CONNECTOR_PROTOCOL_VERSION,
  sha256Hex,
} from "@/connector/protocol";
import type { DesktopConnectorIdentity } from "@/connector/desktop/identity";

const DEVICE_VAULT_VERSION = 1 as const;

export const desktopDeviceCredentialsSchema = z
  .object({
    deviceId: z.string().min(1).max(128),
    deviceToken: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
    publicKeySpki: z.string().min(40).max(512),
    privateKeyPkcs8: z.string().min(40).max(512),
    protocolVersion: z.literal(DESKTOP_CONNECTOR_PROTOCOL_VERSION),
  })
  .strict();

export type DesktopDeviceCredentials = z.infer<
  typeof desktopDeviceCredentialsSchema
>;

const encryptedDeviceCredentialsSchema = z
  .object({
    version: z.literal(DEVICE_VAULT_VERSION),
    deviceId: z.string().min(1).max(128),
    ciphertext: z.string().min(1),
    iv: z.string().min(1),
    authTag: z.string().min(1),
    updatedAt: z.string().datetime(),
  })
  .strict();

function assertKey(key: Buffer): void {
  if (key.length !== 32) {
    throw new Error("Desktop device vault requires a 32-byte key");
  }
}

function deviceAad(deviceId: string): string {
  return `secure-desktop-device:v${DEVICE_VAULT_VERSION}:${deviceId}`;
}

export function toDesktopDeviceCredentials(input: {
  deviceId: string;
  deviceToken: string;
  identity: DesktopConnectorIdentity;
}): DesktopDeviceCredentials {
  return desktopDeviceCredentialsSchema.parse({
    deviceId: input.deviceId,
    deviceToken: input.deviceToken,
    publicKeySpki: input.identity.publicKeySpki,
    privateKeyPkcs8: input.identity.privateKeyPkcs8,
    protocolVersion: DESKTOP_CONNECTOR_PROTOCOL_VERSION,
  });
}

export class FileDesktopDeviceVault {
  private readonly rootDir: string;
  private readonly key: Buffer;

  constructor(rootDir: string, key: Buffer) {
    assertKey(key);
    this.rootDir = path.resolve(rootDir);
    this.key = Buffer.from(key);
  }

  private credentialPath(deviceId: string): string {
    if (!deviceId || deviceId.length > 128) {
      throw new Error("Desktop connector device id is invalid");
    }
    return path.join(this.rootDir, `${sha256Hex(deviceId)}.device.json`);
  }

  async save(
    rawCredentials: DesktopDeviceCredentials,
    now = new Date()
  ): Promise<void> {
    const credentials = desktopDeviceCredentialsSchema.parse(rawCredentials);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(deviceAad(credentials.deviceId), "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(credentials), "utf8"),
      cipher.final(),
    ]);
    const record = {
      version: DEVICE_VAULT_VERSION,
      deviceId: credentials.deviceId,
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      updatedAt: now.toISOString(),
    };

    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.rootDir, 0o700);
    const destination = this.credentialPath(credentials.deviceId);
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

  async load(deviceId: string): Promise<DesktopDeviceCredentials> {
    const raw = await fs.readFile(this.credentialPath(deviceId), "utf8");
    const record = encryptedDeviceCredentialsSchema.parse(JSON.parse(raw));
    if (record.deviceId !== deviceId) {
      throw new Error("Desktop device binding does not match the local vault");
    }
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(record.iv, "base64")
    );
    decipher.setAAD(Buffer.from(deviceAad(deviceId), "utf8"));
    decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, "base64")),
      decipher.final(),
    ]);
    return desktopDeviceCredentialsSchema.parse(
      JSON.parse(plaintext.toString("utf8"))
    );
  }
}
