import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://example.invalid/screengoblin",
  REDIS_URL: "redis://redis.example.test:6379/0",
  JWT_SECRET: "jwt-secret-that-is-at-least-thirty-two-characters",
  PAIRING_CODE_PEPPER: "pairing-pepper-that-is-at-least-thirty-two-characters",
  DEVICE_AUTH_MODE: "proof-v1",
  MANIFEST_SIGNING_PRIVATE_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
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

  it("accepts a production configuration with separate trust roots", () => {
    expect(loadConfig(base).PUBLIC_API_URL).toBe(
      "https://signage.example.test",
    );
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

  it("requires a Redis request-protection backend in production", () => {
    expect(() => loadConfig({ ...base, REDIS_URL: "" })).toThrow();
    expect(() =>
      loadConfig({ ...base, REDIS_URL: "https://example.test" }),
    ).toThrow();
  });
});
