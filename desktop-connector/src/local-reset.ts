import fs from "node:fs/promises";
import path from "node:path";

const CONNECTOR_DATA_ROOT_NAME = "connector-data";

function scopedConnectorDataRoot(rawRoot: string): string {
  const root = path.resolve(rawRoot);
  const parsed = path.parse(root);
  if (
    path.basename(root) !== CONNECTOR_DATA_ROOT_NAME ||
    path.dirname(root) === parsed.root
  ) {
    throw new Error("DESKTOP_CONNECTOR_RESET_PATH_INVALID");
  }
  return root;
}

export async function resetLocalDesktopConnectorData(
  rawRoot: string
): Promise<void> {
  const root = scopedConnectorDataRoot(rawRoot);

  // Remove the protected master-key record first. If a later filesystem
  // operation fails, any remaining vault ciphertext is no longer usable by the
  // application and the user can safely retry the reset.
  await fs.rm(path.join(root, "keychain"), {
    recursive: true,
    force: true,
  });
  await fs.rm(path.join(root, "vault"), {
    recursive: true,
    force: true,
  });
  await fs.rm(path.join(root, "receipts"), {
    recursive: true,
    force: true,
  });
  await fs.rm(path.join(root, "state"), {
    recursive: true,
    force: true,
  });
  await fs.rm(root, { recursive: true, force: true });
}
