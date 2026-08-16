import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { desktopConnectorPlatformSchema } from "../../src/connector/protocol";

const LOCAL_STATE_VERSION = 1 as const;

const pairedDeviceSchema = z
  .object({
    deviceId: z.string().min(1).max(128),
    label: z.string().min(1).max(80),
    crmBaseUrl: z.string().url().max(2_048),
    pairedAt: z.string().datetime(),
  })
  .strict();

const localProfileSchema = z
  .object({
    profileId: z.string().min(1).max(128),
    platform: desktopConnectorPlatformSchema,
  })
  .strict();

const localConnectorStateSchema = z
  .object({
    version: z.literal(LOCAL_STATE_VERSION),
    pairedDevice: pairedDeviceSchema.nullable(),
    profiles: z.array(localProfileSchema).max(100),
  })
  .strict();

export type LocalConnectorState = z.infer<typeof localConnectorStateSchema>;
export type LocalConnectorProfile = z.infer<typeof localProfileSchema>;

const EMPTY_STATE: LocalConnectorState = {
  version: LOCAL_STATE_VERSION,
  pairedDevice: null,
  profiles: [],
};

export class FileDesktopConnectorState {
  private readonly rootDir: string;
  private readonly statePath: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
    this.statePath = path.join(this.rootDir, "state.v1.json");
  }

  async load(): Promise<LocalConnectorState> {
    try {
      return localConnectorStateSchema.parse(
        JSON.parse(await fs.readFile(this.statePath, "utf8"))
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return structuredClone(EMPTY_STATE);
      }
      throw error;
    }
  }

  async save(state: LocalConnectorState): Promise<void> {
    const parsed = localConnectorStateSchema.parse(state);
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.rootDir, 0o700);
    const temporary = `${this.statePath}.tmp-${crypto.randomUUID()}`;
    try {
      await fs.writeFile(temporary, JSON.stringify(parsed), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(temporary, this.statePath);
      await fs.chmod(this.statePath, 0o600);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
