import { z } from "zod";

const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().min(1),
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
    EMERGENCY_FEATURE_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV !== "production") return;
    if (new URL(value.PUBLIC_API_URL).protocol !== "https:")
      context.addIssue({
        code: "custom",
        path: ["PUBLIC_API_URL"],
        message: "must use HTTPS in production",
      });
    if (/replace-with|change-?me/i.test(value.JWT_SECRET))
      context.addIssue({
        code: "custom",
        path: ["JWT_SECRET"],
        message: "must not be a documented placeholder",
      });
    if (value.JWT_SECRET === value.PAIRING_CODE_PEPPER)
      context.addIssue({
        code: "custom",
        path: ["PAIRING_CODE_PEPPER"],
        message: "must be distinct from JWT_SECRET",
      });
  });
export type Config = z.infer<typeof schema>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config =>
  schema.parse(env);
