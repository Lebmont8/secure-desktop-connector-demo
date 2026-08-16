import { safeStorage } from "electron";
import type {
  DesktopSecretDecryption,
  DesktopSecretProtector,
  DesktopSecretProtectorStatus,
} from "../../src/connector/desktop/master-key-store";

function selectedBackend(): string {
  if (process.platform === "linux") {
    return safeStorage.getSelectedStorageBackend();
  }
  if (process.platform === "darwin") return "macos-keychain";
  if (process.platform === "win32") return "windows-dpapi";
  return process.platform;
}

export class ElectronSafeStorageProtector
  implements DesktopSecretProtector
{
  async status(): Promise<DesktopSecretProtectorStatus> {
    return {
      available: await safeStorage.isAsyncEncryptionAvailable(),
      backend: selectedBackend(),
      platform: process.platform,
    };
  }

  async encrypt(plaintext: string): Promise<Buffer> {
    return safeStorage.encryptStringAsync(plaintext);
  }

  async decrypt(ciphertext: Buffer): Promise<DesktopSecretDecryption> {
    const decrypted = await safeStorage.decryptStringAsync(ciphertext);
    return {
      plaintext: decrypted.result,
      shouldReEncrypt: decrypted.shouldReEncrypt,
    };
  }
}
