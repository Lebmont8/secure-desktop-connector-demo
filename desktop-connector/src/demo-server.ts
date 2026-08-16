import { DemoControlPlane } from "./demo-server-core";

const host = process.env.DEMO_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.DEMO_PORT || "8787");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("DEMO_PORT must be an integer from 1 to 65535");
}

const controlPlane = new DemoControlPlane();
controlPlane.server.listen(port, host, () => {
  console.log(`Demo control plane: http://${host}:${port}`);
  console.log(`One-time pairing code: ${controlPlane.pairingCode}`);
});
