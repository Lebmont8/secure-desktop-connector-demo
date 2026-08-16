import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopConnectorMockProfileInput,
  DesktopConnectorPairInput,
  DesktopConnectorPublicStatus,
  DesktopConnectorRendererApi,
} from "./contracts";

const api: DesktopConnectorRendererApi = {
  getStatus: () =>
    ipcRenderer.invoke("connector:get-status") as Promise<DesktopConnectorPublicStatus>,
  pair: (input: DesktopConnectorPairInput) =>
    ipcRenderer.invoke(
      "connector:pair",
      input
    ) as Promise<DesktopConnectorPublicStatus>,
  forgetPairing: () =>
    ipcRenderer.invoke(
      "connector:forget-pairing"
    ) as Promise<DesktopConnectorPublicStatus>,
  addMockProfile: (input: DesktopConnectorMockProfileInput) =>
    ipcRenderer.invoke(
      "connector:add-mock-profile",
      input
    ) as Promise<DesktopConnectorPublicStatus>,
  removeMockProfile: (profileId: string) =>
    ipcRenderer.invoke(
      "connector:remove-mock-profile",
      profileId
    ) as Promise<DesktopConnectorPublicStatus>,
  runOnce: () =>
    ipcRenderer.invoke("connector:run-once") as Promise<DesktopConnectorPublicStatus>,
};

contextBridge.exposeInMainWorld("secureConnector", Object.freeze(api));
