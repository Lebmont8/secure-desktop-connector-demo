import crypto from "node:crypto";
import {
  canonicalDesktopConnectorRequest,
  type DesktopConnectorCanonicalRequest,
} from "@/connector/protocol";

export type DesktopConnectorIdentity = {
  publicKeySpki: string;
  privateKeyPkcs8: string;
};

export function createDesktopConnectorIdentity(): DesktopConnectorIdentity {
  const pair = crypto.generateKeyPairSync("ed25519");
  return {
    publicKeySpki: pair.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
    privateKeyPkcs8: pair.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
  };
}

export function signDesktopConnectorRequest(
  identity: DesktopConnectorIdentity,
  request: DesktopConnectorCanonicalRequest
): string {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(identity.privateKeyPkcs8, "base64"),
    format: "der",
    type: "pkcs8",
  });
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Desktop connector private key must be Ed25519");
  }
  return crypto
    .sign(
      null,
      Buffer.from(canonicalDesktopConnectorRequest(request), "utf8"),
      privateKey
    )
    .toString("base64url");
}

export function signedDesktopConnectorHeaders(
  identity: DesktopConnectorIdentity,
  deviceToken: string,
  request: DesktopConnectorCanonicalRequest
): Record<string, string> {
  return {
    authorization: `Connector ${deviceToken}`,
    "content-type": "application/json",
    "x-connector-device-id": request.deviceId,
    "x-connector-request-id": request.requestId,
    "x-connector-timestamp": String(request.timestamp),
    "x-connector-signature": signDesktopConnectorRequest(identity, request),
  };
}
