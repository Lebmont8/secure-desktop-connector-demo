import crypto from "node:crypto";
import { z } from "zod";
import {
  DESKTOP_CONNECTOR_PROTOCOL_VERSION,
  desktopConnectorCommandEnvelopeSchema,
  desktopConnectorPairRequestSchema,
  desktopConnectorCommandResultSchema,
  desktopConnectorHeartbeatSchema,
  type DesktopConnectorCommandEnvelope,
  type DesktopConnectorCommandResult,
  type DesktopConnectorHeartbeat,
  type DesktopConnectorInboundMessage,
  desktopConnectorInboundMessageSchema,
} from "../../src/connector/protocol";
import {
  desktopConnectorSnapshotPageSchema,
  type DesktopConnectorSnapshotPage,
} from "../../src/connector/snapshot";
import { normalizeDesktopCrmBaseUrl } from "../../src/connector/desktop/crm-url";
import {
  signedDesktopConnectorHeaders,
  type DesktopConnectorIdentity,
} from "../../src/connector/desktop/identity";
import type { DesktopCrmTransport } from "../../src/connector/desktop/runtime";

const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

const pairResponseSchema = z
  .object({
    ok: z.literal(true),
    deviceId: z.string().min(1).max(128),
    deviceToken: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
    protocolVersion: z.literal(DESKTOP_CONNECTOR_PROTOCOL_VERSION),
    heartbeatIntervalSeconds: z.number().int().positive().max(300),
  })
  .strict();

const okResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .passthrough();

const pollResponseSchema = z
  .object({
    ok: z.literal(true),
    duplicate: z.boolean(),
    command: desktopConnectorCommandEnvelopeSchema.nullable(),
  })
  .strict();

const errorResponseSchema = z
  .object({
    ok: z.literal(false),
    error: z.string().regex(/^[A-Z0-9_]{1,80}$/),
  })
  .strict();

export class DesktopConnectorTransportError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code);
    this.name = "DesktopConnectorTransportError";
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_RESPONSE_BYTES
  ) {
    throw new DesktopConnectorTransportError(
      "DESKTOP_CONNECTOR_RESPONSE_TOO_LARGE",
      502
    );
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new DesktopConnectorTransportError(
      "DESKTOP_CONNECTOR_RESPONSE_INVALID",
      502
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new DesktopConnectorTransportError(
        "DESKTOP_CONNECTOR_RESPONSE_TOO_LARGE",
        502
      );
    }
    chunks.push(Buffer.from(chunk.value));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new DesktopConnectorTransportError(
      "DESKTOP_CONNECTOR_RESPONSE_INVALID",
      502
    );
  }
}

async function postJson(
  baseUrl: string,
  path: string,
  body: string,
  headers: Record<string, string> = {
    "content-type": "application/json",
  }
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers,
      body,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new DesktopConnectorTransportError(
      "DESKTOP_CONNECTOR_CRM_UNREACHABLE",
      503
    );
  }
  const value = await readBoundedJson(response);
  if (!response.ok) {
    const error = errorResponseSchema.safeParse(value);
    throw new DesktopConnectorTransportError(
      error.success ? error.data.error : "DESKTOP_CONNECTOR_REQUEST_FAILED",
      response.status
    );
  }
  return value;
}

export async function pairDesktopConnector(input: {
  crmBaseUrl: string;
  pairingCode: string;
  label: string;
  appVersion: string;
  identity: DesktopConnectorIdentity;
}) {
  const baseUrl = normalizeDesktopCrmBaseUrl(input.crmBaseUrl);
  const request = desktopConnectorPairRequestSchema.parse({
    pairingCode: input.pairingCode.trim(),
    label: input.label.trim(),
    appVersion: input.appVersion,
    protocolVersion: DESKTOP_CONNECTOR_PROTOCOL_VERSION,
    publicKeySpki: input.identity.publicKeySpki,
  });
  const response = await postJson(
    baseUrl,
    "/api/connectors/desktop/pair",
    JSON.stringify(request)
  );
  return {
    baseUrl,
    ...pairResponseSchema.parse(response),
  };
}

export class HttpDesktopCrmTransport implements DesktopCrmTransport {
  private readonly baseUrl: string;

  constructor(
    crmBaseUrl: string,
    private readonly credentials: {
      deviceId: string;
      deviceToken: string;
      identity: DesktopConnectorIdentity;
    }
  ) {
    this.baseUrl = normalizeDesktopCrmBaseUrl(crmBaseUrl);
  }

  async heartbeat(payload: DesktopConnectorHeartbeat): Promise<void> {
    const body = JSON.stringify(desktopConnectorHeartbeatSchema.parse(payload));
    okResponseSchema.parse(
      await this.signedPost("/api/connectors/desktop/heartbeat", body)
    );
  }

  async poll(): Promise<DesktopConnectorCommandEnvelope | null> {
    const body = JSON.stringify({
      protocolVersion: DESKTOP_CONNECTOR_PROTOCOL_VERSION,
    });
    const response = pollResponseSchema.parse(
      await this.signedPost(
        "/api/connectors/desktop/commands/poll",
        body
      )
    );
    return response.command;
  }

  async complete(result: DesktopConnectorCommandResult): Promise<void> {
    const body = JSON.stringify(
      desktopConnectorCommandResultSchema.parse(result)
    );
    okResponseSchema.parse(
      await this.signedPost(
        "/api/connectors/desktop/commands/result",
        body
      )
    );
  }

  async inbound(message: DesktopConnectorInboundMessage): Promise<void> {
    const body = JSON.stringify(
      desktopConnectorInboundMessageSchema.parse(message)
    );
    okResponseSchema.parse(
      await this.signedPost(
        "/api/connectors/desktop/events/message",
        body
      )
    );
  }

  async snapshot(page: DesktopConnectorSnapshotPage): Promise<void> {
    const body = JSON.stringify(
      desktopConnectorSnapshotPageSchema.parse(page)
    );
    okResponseSchema.parse(
      await this.signedPost(
        "/api/connectors/desktop/snapshots/page",
        body
      )
    );
  }

  private async signedPost(path: string, body: string): Promise<unknown> {
    const canonical = {
      method: "POST" as const,
      path,
      deviceId: this.credentials.deviceId,
      requestId: crypto.randomUUID(),
      timestamp: Date.now(),
      body,
    };
    return postJson(
      this.baseUrl,
      path,
      body,
      signedDesktopConnectorHeaders(
        this.credentials.identity,
        this.credentials.deviceToken,
        canonical
      )
    );
  }
}
