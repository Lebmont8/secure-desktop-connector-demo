import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DesktopKeychainUnavailableError,
  FileDesktopMasterKeyStore,
  assertProtectedDesktopKeychain,
  type DesktopSecretProtector,
  type DesktopSecretProtectorStatus,
} from "@/connector/desktop/master-key-store";

const temporaryRoots: string[] = [];

function xorFakeCipher(value: Buffer): Buffer {
  const result = Buffer.alloc(value.length);
  for (let index = 0; index < value.length; index += 1) {
    result[index] = value[index]! ^ 0xa5;
  }
  return result;
}

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secure-master-key-"));
  temporaryRoots.push(root);
  return root;
}

class FakeSecretProtector implements DesktopSecretProtector {
  encryptions = 0;
  shouldReEncrypt = false;

  constructor(
    private readonly protectorStatus: DesktopSecretProtectorStatus = {
      available: true,
      backend: "dpapi",
      platform: "win32",
    }
  ) {}

  async status(): Promise<DesktopSecretProtectorStatus> {
    return this.protectorStatus;
  }

  async encrypt(plaintext: string): Promise<Buffer> {
    this.encryptions += 1;
    return xorFakeCipher(Buffer.from(plaintext, "utf8"));
  }

  async decrypt(ciphertext: Buffer) {
    return {
      plaintext: xorFakeCipher(Buffer.from(ciphertext)).toString("utf8"),
      shouldReEncrypt: this.shouldReEncrypt,
    };
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true })
    )
  );
});

describe("desktop connector OS-keychain master key store", () => {
  it("creates one stable 32-byte key and persists only protected ciphertext", async () => {
    const root = await temporaryRoot();
    const protector = new FakeSecretProtector();
    const store = new FileDesktopMasterKeyStore(root, protector);

    const first = await store.loadOrCreate(
      new Date("2026-07-26T16:00:00.000Z")
    );
    const second = await store.loadOrCreate(
      new Date("2026-07-26T16:01:00.000Z")
    );

    expect(first).toHaveLength(32);
    expect(second).toEqual(first);
    expect(protector.encryptions).toBe(1);
    const recordPath = path.join(root, "master-key.v1.json");
    const stored = await fs.readFile(recordPath, "utf8");
    expect(stored).not.toContain(first.toString("base64"));
    expect(stored).not.toContain(first.toString("hex"));
    expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(recordPath)).mode & 0o777).toBe(0o600);
  });

  it("rotates the protected record when the keychain requests re-encryption", async () => {
    const root = await temporaryRoot();
    const protector = new FakeSecretProtector();
    const store = new FileDesktopMasterKeyStore(root, protector);
    const first = await store.loadOrCreate();
    protector.shouldReEncrypt = true;

    const loaded = await store.loadOrCreate(
      new Date("2026-07-26T16:05:00.000Z")
    );

    expect(loaded).toEqual(first);
    expect(protector.encryptions).toBe(2);
    expect(
      JSON.parse(
        await fs.readFile(path.join(root, "master-key.v1.json"), "utf8")
      ).updatedAt
    ).toBe("2026-07-26T16:05:00.000Z");
  });

  it("fails closed when Linux falls back to basic plaintext storage", () => {
    expect(() =>
      assertProtectedDesktopKeychain({
        available: true,
        backend: "basic_text",
        platform: "linux",
      })
    ).toThrow(DesktopKeychainUnavailableError);
    expect(() =>
      assertProtectedDesktopKeychain({
        available: true,
        backend: "gnome_libsecret",
        platform: "linux",
      })
    ).not.toThrow();
  });
});
