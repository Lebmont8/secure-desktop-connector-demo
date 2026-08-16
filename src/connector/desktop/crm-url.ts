const LOCAL_DEVELOPMENT_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
]);

export function normalizeDesktopCrmBaseUrl(rawValue: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawValue.trim());
  } catch {
    throw new Error("DESKTOP_CONNECTOR_CRM_URL_INVALID");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new Error("DESKTOP_CONNECTOR_CRM_URL_INVALID");
  }
  if (
    parsed.protocol !== "https:" &&
    !(
      parsed.protocol === "http:" &&
      LOCAL_DEVELOPMENT_HOSTS.has(parsed.hostname)
    )
  ) {
    throw new Error("DESKTOP_CONNECTOR_CRM_URL_INSECURE");
  }
  return parsed.origin;
}
