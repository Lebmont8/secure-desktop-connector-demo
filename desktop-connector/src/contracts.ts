import type { DesktopConnectorPlatform } from "../../src/connector/protocol";

export type DesktopConnectorPublicProfile = {
  profileId: string;
  platform: DesktopConnectorPlatform;
  status: "READY";
};

export type DesktopConnectorPublicStatus = {
  appVersion: string;
  keychain: {
    available: boolean;
    backend: string;
  };
  paired: boolean;
  deviceId: string | null;
  label: string | null;
  crmBaseUrl: string | null;
  profiles: DesktopConnectorPublicProfile[];
  running: boolean;
  lastRunAt: string | null;
  lastOutcome: "idle" | "processed" | null;
  lastErrorCode: string | null;
};

export type DesktopConnectorPairInput = {
  crmBaseUrl: string;
  pairingCode: string;
  label: string;
};

export type DesktopConnectorMockProfileInput = {
  profileId: string;
  platform: DesktopConnectorPlatform;
  accountRef: string;
};

export type DesktopConnectorRendererApi = {
  getStatus(): Promise<DesktopConnectorPublicStatus>;
  pair(
    input: DesktopConnectorPairInput
  ): Promise<DesktopConnectorPublicStatus>;
  forgetPairing(): Promise<DesktopConnectorPublicStatus>;
  addMockProfile(
    input: DesktopConnectorMockProfileInput
  ): Promise<DesktopConnectorPublicStatus>;
  removeMockProfile(profileId: string): Promise<DesktopConnectorPublicStatus>;
  runOnce(): Promise<DesktopConnectorPublicStatus>;
};

declare global {
  interface Window {
    secureConnector: DesktopConnectorRendererApi;
  }
}
