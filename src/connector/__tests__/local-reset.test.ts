import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetLocalDesktopConnectorData } from "../../../desktop-connector/src/local-reset";

const temporaryRoots: string[] = [];

async function temporaryParent(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secure-local-reset-"));
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

describe("desktop connector local pairing reset", () => {
  it("removes all connector data while preserving its parent and siblings", async () => {
    const parent = await temporaryParent();
    const root = path.join(parent, "connector-data");
    const files = [
      ["keychain", "master-key.v1.json"],
      ["vault", "devices", "device.device.json"],
      ["vault", "profiles", "profile.profile.json"],
      ["receipts", "receipts.v1.json"],
      ["state", "state.v1.json"],
      ["future-secret-store", "opaque.bin"],
    ];
    for (const segments of files) {
      const destination = path.join(root, ...segments);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, "secret-marker");
    }
    const sibling = path.join(parent, "keep.txt");
    await fs.writeFile(sibling, "keep");

    await resetLocalDesktopConnectorData(root);

    await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(sibling, "utf8")).resolves.toBe("keep");
  });

  it("is idempotent for an already removed scoped data root", async () => {
    const parent = await temporaryParent();
    const root = path.join(parent, "connector-data");

    await expect(resetLocalDesktopConnectorData(root)).resolves.toBeUndefined();
    await expect(resetLocalDesktopConnectorData(root)).resolves.toBeUndefined();
  });

  it("rejects broad or unexpected deletion targets", async () => {
    const parent = await temporaryParent();

    await expect(
      resetLocalDesktopConnectorData(path.join(parent, "other-data"))
    ).rejects.toThrow("DESKTOP_CONNECTOR_RESET_PATH_INVALID");
    await expect(
      resetLocalDesktopConnectorData(path.parse(parent).root)
    ).rejects.toThrow("DESKTOP_CONNECTOR_RESET_PATH_INVALID");
  });
});
