import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDesktopProfileVaultKey,
  FileDesktopProfileVault,
} from "@/connector/desktop/profile-vault";
import {
  FileDesktopDeviceVault,
  toDesktopDeviceCredentials,
} from "@/connector/desktop/device-vault";
import { createDesktopConnectorIdentity } from "@/connector/desktop/identity";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secure-profile-vault-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true })
    )
  );
});

describe("desktop connector local profile vault", () => {
  it("persists only AES-GCM ciphertext in a private local file", async () => {
    const root = await temporaryRoot();
    const vault = new FileDesktopProfileVault(
      root,
      "device-a",
      createDesktopProfileVaultKey()
    );
    const payload = {
      transport: "mock",
      accountRef: "raw-secret-marker",
      fixtureRevision: 1,
    };

    await vault.save("profile-a", "demo", payload);
    await expect(vault.load("profile-a", "demo")).resolves.toEqual(payload);

    const files = await fs.readdir(root);
    expect(files).toHaveLength(1);
    const stored = await fs.readFile(path.join(root, files[0]!), "utf8");
    expect(stored).not.toContain("raw-secret-marker");
    expect(stored).not.toContain("accountRef");
    expect((await fs.stat(path.join(root, files[0]!))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
  });

  it("cryptographically isolates the same profile id between devices", async () => {
    const root = await temporaryRoot();
    const key = createDesktopProfileVaultKey();
    const first = new FileDesktopProfileVault(root, "device-a", key);
    const otherDevice = new FileDesktopProfileVault(root, "device-b", key);
    await first.save("profile-a", "demo", {
      transport: "mock",
      accountRef: "fixture-a",
    });

    await expect(
      otherDevice.load("profile-a", "demo")
    ).rejects.toThrow();
  });

  it("hashes profile ids before using them as filenames", async () => {
    const root = await temporaryRoot();
    const vault = new FileDesktopProfileVault(
      root,
      "device-a",
      createDesktopProfileVaultKey()
    );
    await vault.save("../../outside", "demo", {
      transport: "mock",
      accountRef: "fixture-a",
    });

    const files = await fs.readdir(root);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.profile\.json$/);
    await expect(fs.stat(path.join(root, "..", "outside"))).rejects.toMatchObject(
      { code: "ENOENT" }
    );
  });

  it("encrypts the device bearer token and private signing key at rest", async () => {
    const root = await temporaryRoot();
    const key = createDesktopProfileVaultKey();
    const vault = new FileDesktopDeviceVault(root, key);
    const credentials = toDesktopDeviceCredentials({
      deviceId: "device-a",
      deviceToken: "t".repeat(43),
      identity: createDesktopConnectorIdentity(),
    });

    await vault.save(credentials);
    await expect(vault.load("device-a")).resolves.toEqual(credentials);

    const file = (await fs.readdir(root))[0]!;
    const stored = await fs.readFile(path.join(root, file), "utf8");
    expect(stored).not.toContain(credentials.deviceToken);
    expect(stored).not.toContain(credentials.privateKeyPkcs8);
    expect((await fs.stat(path.join(root, file))).mode & 0o777).toBe(0o600);
  });
});
