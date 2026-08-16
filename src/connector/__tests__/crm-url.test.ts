import { describe, expect, it } from "vitest";
import { normalizeDesktopCrmBaseUrl } from "@/connector/desktop/crm-url";

describe("desktop connector CRM origin policy", () => {
  it("accepts HTTPS origins and strips the trailing slash", () => {
    expect(normalizeDesktopCrmBaseUrl("https://crm.example.com/")).toBe(
      "https://crm.example.com"
    );
  });

  it("allows plain HTTP only for local development", () => {
    expect(normalizeDesktopCrmBaseUrl("http://127.0.0.1:3000")).toBe(
      "http://127.0.0.1:3000"
    );
    expect(() =>
      normalizeDesktopCrmBaseUrl("http://crm.example.com")
    ).toThrow("DESKTOP_CONNECTOR_CRM_URL_INSECURE");
  });

  it("rejects credentials, paths, query strings and fragments", () => {
    for (const value of [
      "https://user:pass@crm.example.com",
      "https://crm.example.com/tenant",
      "https://crm.example.com?token=secret",
      "https://crm.example.com#fragment",
    ]) {
      expect(() => normalizeDesktopCrmBaseUrl(value)).toThrow(
        "DESKTOP_CONNECTOR_CRM_URL_INVALID"
      );
    }
  });
});
