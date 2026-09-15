import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { loadConfig, parseMediaAllowedOrigins } from "../src/config.js";

const base = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://example.invalid/screengoblin",
  REDIS_URL: "redis://redis.example.test:6379/0",
  JWT_SECRET: randomBytes(48).toString("base64url"),
  PAIRING_CODE_PEPPER: randomBytes(48).toString("base64url"),
  MEDIA_DELIVERY_SECRET: randomBytes(48).toString("base64url"),
  S3_ACCESS_KEY_ID: "private-media-api",
  S3_SIGNING_KEY: randomBytes(48).toString("base64url"),
  DEVICE_AUTH_MODE: "proof-v1",
  MANIFEST_SIGNING_PRIVATE_KEY: randomBytes(32).toString("base64url"),
  PUBLIC_API_URL: "https://signage.example.test",
  MEDIA_ALLOWED_ORIGINS: "https://media.example.test",
};

describe("production configuration", () => {
  it("requires HTTPS and independent secrets", () => {
    expect(() =>
      loadConfig({
        ...base,
        PUBLIC_API_URL: "http://signage.example.test",
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...base,
        PAIRING_CODE_PEPPER: base.JWT_SECRET,
      }),
    ).toThrow();
  });

  it("requires a distinct private-media capability secret", () => {
    expect(() =>
      loadConfig({ ...base, MEDIA_DELIVERY_SECRET: base.JWT_SECRET }),
    ).toThrow(/MEDIA_DELIVERY_SECRET/);
  });

  it("normalizes the public API origin used by pairing responses", () => {
    expect(
      loadConfig({
        ...base,
        PUBLIC_API_URL: "https://SIGNAGE.EXAMPLE.TEST:443/",
      }).PUBLIC_API_URL,
    ).toBe("https://signage.example.test");
  });

  it.each([
    "https://user:password@signage.example.test",
    "https://signage.example.test/api",
    "https://signage.example.test?tenant=school",
    "https://signage.example.test#device",
  ])("rejects non-origin production PUBLIC_API_URL %s", (publicApiUrl) => {
    expect(() => loadConfig({ ...base, PUBLIC_API_URL: publicApiUrl })).toThrow(
      /PUBLIC_API_URL/,
    );
  });

  it.each([
    ["JWT_SECRET", "replace-with-at-least-32-random-characters"],
    ["JWT_SECRET", "ci-only-jwt-secret-at-least-32-characters"],
    ["JWT_SECRET", "e2e-only-jwt-secret-at-least-32-characters"],
    ["JWT_SECRET", "jwt-secret-that-is-at-least-thirty-two-characters"],
    ["JWT_SECRET", "test-secret-that-is-longer-than-thirty-two-characters"],
    [
      "PAIRING_CODE_PEPPER",
      "replace-with-a-separate-at-least-32-character-secret",
    ],
    ["PAIRING_CODE_PEPPER", "ci-only-pairing-pepper-at-least-32-characters"],
    ["PAIRING_CODE_PEPPER", "e2e-only-pairing-pepper-at-least-32-characters"],
    [
      "PAIRING_CODE_PEPPER",
      "pairing-pepper-that-is-at-least-thirty-two-characters",
    ],
    ["PAIRING_CODE_PEPPER", "rate-limit-test-secret-that-is-long-enough"],
  ] as const)("rejects checked-in production %s value", (name, secret) => {
    expect(() => loadConfig({ ...base, [name]: secret })).toThrow(name);
  });

  it("rejects the decoded all-zero manifest signing test seed", () => {
    expect(() =>
      loadConfig({
        ...base,
        MANIFEST_SIGNING_PRIVATE_KEY:
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    ).toThrow(/MANIFEST_SIGNING_PRIVATE_KEY/);
  });

  it("retains explicit test fixtures outside production", () => {
    expect(
      loadConfig({
        ...base,
        NODE_ENV: "test",
        JWT_SECRET: "ci-only-jwt-secret-at-least-32-characters",
        PAIRING_CODE_PEPPER: "ci-only-pairing-pepper-at-least-32-characters",
        MANIFEST_SIGNING_PRIVATE_KEY:
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    ).toMatchObject({ NODE_ENV: "test" });
  });

  it("refuses to enable the incomplete emergency workflow in production", () => {
    expect(() =>
      loadConfig({ ...base, EMERGENCY_FEATURE_ENABLED: "true" }),
    ).toThrow(/EMERGENCY_FEATURE_ENABLED/);
    expect(
      loadConfig({ ...base, EMERGENCY_FEATURE_ENABLED: "false" }),
    ).toMatchObject({ EMERGENCY_FEATURE_ENABLED: false });
  });

  it("retains the explicit emergency fixture path outside production", () => {
    expect(
      loadConfig({
        ...base,
        NODE_ENV: "test",
        EMERGENCY_FEATURE_ENABLED: "true",
      }).EMERGENCY_FEATURE_ENABLED,
    ).toBe(true);
  });

  it("requires proof-v1 device authentication in production", () => {
    expect(() =>
      loadConfig({ ...base, DEVICE_AUTH_MODE: "development-bearer" }),
    ).toThrow(/DEVICE_AUTH_MODE/);
    expect(() =>
      loadConfig(
        Object.fromEntries(
          Object.entries(base).filter(([key]) => key !== "DEVICE_AUTH_MODE"),
        ),
      ),
    ).toThrow(/DEVICE_AUTH_MODE/);
  });

  it("requires an explicit production media origin allowlist", () => {
    expect(() => loadConfig({ ...base, MEDIA_ALLOWED_ORIGINS: "" })).toThrow(
      /MEDIA_ALLOWED_ORIGINS/,
    );
    expect(() =>
      loadConfig({
        ...base,
        MEDIA_ALLOWED_ORIGINS: "http://media.example.test",
      }),
    ).toThrow(/MEDIA_ALLOWED_ORIGINS/);
  });

  it.each([
    "https://127.0.0.1",
    "https://[::1]",
    "https://localhost",
    "https://localhost.",
    "https://intranet",
    "https://storage.local",
    "https://storage.internal",
    "https://storage.lan",
    "https://storage.home.arpa",
    "https://user:password@media.example.test",
    "https://media.example.test/assets",
    "https://media.example.test?bucket=school",
  ])("rejects unsafe production media origin %s", (origin) => {
    expect(() =>
      loadConfig({ ...base, MEDIA_ALLOWED_ORIGINS: origin }),
    ).toThrow(/MEDIA_ALLOWED_ORIGINS/);
  });

  it.each([
    ["not-an-origin-SENTINEL_INVALID", "SENTINEL_INVALID"],
    [
      "https://SENTINEL_USER:SENTINEL_PASSWORD@media.example.test",
      "SENTINEL_PASSWORD",
    ],
    ["https://media.example.test?access=SENTINEL_QUERY", "SENTINEL_QUERY"],
    ["https://SENTINEL_PRIVATE.internal", "SENTINEL_PRIVATE"],
  ])(
    "does not echo rejected media-origin entry contents at startup",
    (origin, sentinel) => {
      let failure: unknown;
      try {
        loadConfig({ ...base, MEDIA_ALLOWED_ORIGINS: origin });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain("MEDIA_ALLOWED_ORIGINS");
      expect(String(failure)).toContain("entry 1");
      expect(String(failure)).not.toContain(sentinel);
      expect(() => parseMediaAllowedOrigins(origin, "production")).toThrow(
        "entry 1",
      );
    },
  );

  it("requires a Redis request-protection backend in production", () => {
    expect(() => loadConfig({ ...base, REDIS_URL: "" })).toThrow();
    expect(() =>
      loadConfig({ ...base, REDIS_URL: "https://example.test" }),
    ).toThrow();
  });
});
