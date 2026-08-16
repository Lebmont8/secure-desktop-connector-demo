import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileDesktopCommandReceiptCache } from "@/connector/desktop/receipt-cache";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secure-receipts-"));
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

describe("desktop connector durable command receipts", () => {
  it("deduplicates commands across cache instances and keeps private modes", async () => {
    const root = await temporaryRoot();
    const outcome = {
      ok: true,
      resultCode: "OK",
      outputDigest: "a".repeat(64),
    };
    await new FileDesktopCommandReceiptCache(root).set("command-a", outcome);

    await expect(
      new FileDesktopCommandReceiptCache(root).get("command-a")
    ).resolves.toEqual(outcome);
    const receiptPath = path.join(root, "receipts.v1.json");
    expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(receiptPath)).mode & 0o777).toBe(0o600);
  });

  it("retains only the newest bounded outcomes", async () => {
    const root = await temporaryRoot();
    const cache = new FileDesktopCommandReceiptCache(root, 2);
    const outcome = {
      ok: false,
      resultCode: "LOCAL_PROFILE_LOCKED",
      outputDigest: null,
    };
    await cache.set("command-a", outcome);
    await cache.set("command-b", outcome);
    await cache.set("command-c", outcome);

    await expect(cache.get("command-a")).resolves.toBeNull();
    await expect(cache.get("command-b")).resolves.toEqual(outcome);
    await expect(cache.get("command-c")).resolves.toEqual(outcome);
  });
});
