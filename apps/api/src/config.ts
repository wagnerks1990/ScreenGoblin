import { z } from "zod";
import { isIP } from "node:net";

const loopbackHostname = (hostname: string) =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname === "127.0.0.1" ||
  hostname === "[::1]";

const obviouslyPrivateDnsName = (hostname: string) => {
  const normalized = hostname.toLowerCase();
  return (
    !normalized.includes(".") ||
    [".local", ".internal", ".lan", ".home.arpa"].some(
      (suffix) => normalized === suffix.slice(1) || normalized.endsWith(suffix),
    )
  );
};

const unsafeProductionSecrets = new Set([
  "jwt-secret-that-is-at-least-thirty-two-characters",
  "pairing-pepper-that-is-at-least-thirty-two-characters",
  "ci-only-jwt-secret-at-least-32-characters",
  "ci-only-pairing-pepper-at-least-32-characters",
  "e2e-only-jwt-secret-at-least-32-characters",
  "e2e-only-pairing-pepper-at-least-32-characters",
  "rate-limit-test-secret-that-is-long-enough",
  "test-secret-that-is-longer-than-thirty-two-characters",
]);

const isUnsafeProductionSecret = (value: string) =>
  /replace-with|change-?me/i.test(value) || unsafeProductionSecrets.has(value);

const isAllZeroSeed = (value: string) =>
  Buffer.from(value, "base64url").every((byte) => byte === 0);

export function parsePublicApiUrl(
  raw: string,
  environment: "development" | "test" | "production",
): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("must be a valid URL");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  )
    throw new Error(
      "must be an origin without credentials, path, query, or fragment",
    );
  const localHttp =
    environment !== "production" &&
    parsed.protocol === "http:" &&
    loopbackHostname(parsed.hostname);
  if (parsed.protocol !== "https:" && !localHttp)
    throw new Error("must use HTTPS (HTTP is limited to loopback development)");
  return parsed.origin;
}

export function parseMediaAllowedOrigins(
  raw: string,
  environment: "development" | "test" | "production",
): string[] {
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (environment === "production" && entries.length === 0)
    throw new Error("must contain at least one explicit HTTPS origin");

  const origins = entries.map((entry) => {
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      throw new Error(`${JSON.stringify(entry)} is not a valid origin`);
    }
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    )
      throw new Error(
        `${JSON.stringify(entry)} must be an origin without credentials, path, query, or fragment`,
      );
    const localHttp =
      environment !== "production" &&
      parsed.protocol === "http:" &&
      loopbackHostname(parsed.hostname);
    if (parsed.protocol !== "https:" && !localHttp)
      throw new Error(
        `${JSON.stringify(entry)} must use HTTPS (HTTP is limited to loopback development)`,
      );
    const ipHostname = parsed.hostname.replace(/^\[|\]$/g, "");
    if (
      environment === "production" &&
      (loopbackHostname(parsed.hostname) ||
        obviouslyPrivateDnsName(parsed.hostname) ||
        parsed.hostname.endsWith(".") ||
        isIP(ipHostname) !== 0)
    )
      throw new Error(
        `${JSON.stringify(entry)} must use a non-local DNS hostname in production`,
      );
    return parsed.origin;
  });
  return [...new Set(origins)];
}

const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().default(""),
    JWT_SECRET: z.string().min(32),
    PAIRING_CODE_PEPPER: z.string().min(32),
    MANIFEST_SIGNING_PRIVATE_KEY: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/, "must be a base64url-encoded 32-byte seed"),
    CORS_ORIGINS: z.string().default("http://localhost:5173"),
    PUBLIC_API_URL: z.url(),
    MEDIA_ALLOWED_ORIGINS: z.string().default(""),
    LOG_LEVEL: z.string().default("info"),
    TRUST_PROXY_RANGES: z.string().default(""),
    DEVICE_AUTH_MODE: z.enum(["proof-v1", "development-bearer"]),
    EMERGENCY_FEATURE_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  })
  .superRefine((value, context) => {
    try {
      parsePublicApiUrl(value.PUBLIC_API_URL, value.NODE_ENV);
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["PUBLIC_API_URL"],
        message: error instanceof Error ? error.message : "is invalid",
      });
    }
    try {
      parseMediaAllowedOrigins(value.MEDIA_ALLOWED_ORIGINS, value.NODE_ENV);
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["MEDIA_ALLOWED_ORIGINS"],
        message: error instanceof Error ? error.message : "is invalid",
      });
    }
    if (value.NODE_ENV !== "production") return;
    if (value.EMERGENCY_FEATURE_ENABLED)
      context.addIssue({
        code: "custom",
        path: ["EMERGENCY_FEATURE_ENABLED"],
        message:
          "must remain false in production until the emergency safety gates are implemented",
      });
    if (value.DEVICE_AUTH_MODE !== "proof-v1")
      context.addIssue({
        code: "custom",
        path: ["DEVICE_AUTH_MODE"],
        message: "must be proof-v1 in production",
      });
    if (!/^rediss?:\/\//.test(value.REDIS_URL))
      context.addIssue({
        code: "custom",
        path: ["REDIS_URL"],
        message: "must be a redis:// or rediss:// URL in production",
      });
    if (isUnsafeProductionSecret(value.JWT_SECRET))
      context.addIssue({
        code: "custom",
        path: ["JWT_SECRET"],
        message: "must not be a documented placeholder or test secret",
      });
    if (isUnsafeProductionSecret(value.PAIRING_CODE_PEPPER))
      context.addIssue({
        code: "custom",
        path: ["PAIRING_CODE_PEPPER"],
        message: "must not be a documented placeholder or test secret",
      });
    if (value.JWT_SECRET === value.PAIRING_CODE_PEPPER)
      context.addIssue({
        code: "custom",
        path: ["PAIRING_CODE_PEPPER"],
        message: "must be distinct from JWT_SECRET",
      });
    if (isAllZeroSeed(value.MANIFEST_SIGNING_PRIVATE_KEY))
      context.addIssue({
        code: "custom",
        path: ["MANIFEST_SIGNING_PRIVATE_KEY"],
        message: "must not use the all-zero test seed",
      });
  });
export type Config = z.infer<typeof schema>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const parsed = schema.parse(env);
  return {
    ...parsed,
    PUBLIC_API_URL: parsePublicApiUrl(parsed.PUBLIC_API_URL, parsed.NODE_ENV),
  };
};
