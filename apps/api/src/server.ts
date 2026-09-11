import "dotenv/config";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
const config = loadConfig();
const app = await buildApp({
  jwtSecret: config.JWT_SECRET,
  manifestSigningPrivateKey: config.MANIFEST_SIGNING_PRIVATE_KEY,
  pairingCodePepper: config.PAIRING_CODE_PEPPER,
  emergencyPublishingEnabled: config.EMERGENCY_FEATURE_ENABLED,
  corsOrigins: config.CORS_ORIGINS.split(",")
    .map((x) => x.trim())
    .filter(Boolean),
  mediaAllowedOrigins: config.MEDIA_ALLOWED_ORIGINS.split(",")
    .map((x) => x.trim())
    .filter(Boolean),
  publicApiUrl: config.PUBLIC_API_URL,
  logger: config.LOG_LEVEL,
  trustProxy:
    config.TRUST_PROXY_RANGES.trim() === ""
      ? false
      : config.TRUST_PROXY_RANGES.split(",")
          .map((value) => value.trim())
          .filter(Boolean),
});
const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.fatal(error);
  process.exit(1);
}
