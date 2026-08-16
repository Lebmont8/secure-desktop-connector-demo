import { afterEach, describe, expect, it } from "vitest";
import { createDesktopConnectorIdentity } from "@/connector/desktop/identity";
import {
  HttpDesktopCrmTransport,
  pairDesktopConnector,
} from "../../../desktop-connector/src/http-transport";
import { DemoControlPlane } from "../../../desktop-connector/src/demo-server-core";

const openServers: DemoControlPlane[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (controlPlane) =>
        new Promise<void>((resolve) => controlPlane.server.close(() => resolve()))
    )
  );
});

describe("demo control plane", () => {
  it("pairs once and completes an Ed25519-signed mock command", async () => {
    const controlPlane = new DemoControlPlane();
    openServers.push(controlPlane);
    await new Promise<void>((resolve) => controlPlane.server.listen(0, "127.0.0.1", resolve));
    const address = controlPlane.server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const identity = createDesktopConnectorIdentity();
    const paired = await pairDesktopConnector({
      crmBaseUrl: baseUrl,
      pairingCode: controlPlane.pairingCode,
      label: "Test desktop",
      appVersion: "0.1.0",
      identity,
    });
    const transport = new HttpDesktopCrmTransport(baseUrl, {
      deviceId: paired.deviceId,
      deviceToken: paired.deviceToken,
      identity,
    });

    await transport.heartbeat({
      protocolVersion: 1,
      appVersion: "0.1.0",
      profiles: [{ profileId: "demo-profile", status: "READY", errorCode: null }],
    });
    const command = await transport.poll();
    expect(command?.kind).toBe("VERIFY_PROFILE");
    expect(command?.platform).toBe("demo");
    await transport.complete({
      protocolVersion: 1,
      commandId: command!.id,
      deliveryId: command!.deliveryId,
      ok: true,
      resultCode: "OK",
      outputDigest: "a".repeat(64),
    });
    expect(await transport.poll()).toBeNull();
  });

  it("rejects reuse of the one-time pairing code", async () => {
    const controlPlane = new DemoControlPlane();
    openServers.push(controlPlane);
    await new Promise<void>((resolve) => controlPlane.server.listen(0, "127.0.0.1", resolve));
    const address = controlPlane.server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const pair = () => pairDesktopConnector({
      crmBaseUrl: baseUrl,
      pairingCode: controlPlane.pairingCode,
      label: "Test desktop",
      appVersion: "0.1.0",
      identity: createDesktopConnectorIdentity(),
    });
    await pair();
    await expect(pair()).rejects.toMatchObject({ code: "DESKTOP_CONNECTOR_PAIRING_INVALID" });
  });
});
