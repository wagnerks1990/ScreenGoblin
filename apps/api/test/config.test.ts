import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://example.invalid/screengoblin",
  REDIS_URL: "redis://redis.example.test:6379/0",
  JWT_SECRET: "jwt-secret-that-is-at-least-thirty-two-characters",
  PAIRING_CODE_PEPPER: "pairing-pepper-that-is-at-least-thirty-two-characters",
  MANIFEST_SIGNING_PRIVATE_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  PUBLIC_API_URL: "https://signage.example.test",
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

  it("requires a Redis request-protection backend in production", () => {
    expect(() => loadConfig({ ...base, REDIS_URL: "" })).toThrow();
    expect(() =>
      loadConfig({ ...base, REDIS_URL: "https://example.test" }),
    ).toThrow();
  });
});
