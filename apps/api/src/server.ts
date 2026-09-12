import "dotenv/config";
import { buildApp } from "./app.js";
import { loadConfig, parseMediaAllowedOrigins } from "./config.js";
import { Redis } from "ioredis";
import { S3MediaObjectStore } from "./media/delivery.js";
const config = loadConfig();
const mediaObjectStore = new S3MediaObjectStore(
  config.S3_ENDPOINT,
  config.S3_REGION,
  config.S3_BUCKET,
  config.S3_ACCESS_KEY_ID,
  config.S3_SIGNING_KEY,
);
const redis = config.REDIS_URL
  ? new Redis(config.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 2_000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    })
  : undefined;
if (redis) {
  redis.on("error", () => {
    console.error("Redis request-protection connection error");
  });
  try {
    await redis.connect();
    await redis.ping();
  } catch {
    redis.disconnect();
    throw new Error("Redis request-protection backend is unavailable");
  }
}
const app = await buildApp({
  jwtSecret: config.JWT_SECRET,
  manifestSigningPrivateKey: config.MANIFEST_SIGNING_PRIVATE_KEY,
  pairingCodePepper: config.PAIRING_CODE_PEPPER,
  mediaDeliverySecret: config.MEDIA_DELIVERY_SECRET,
  mediaObjectStore,
  deviceAuthMode: config.DEVICE_AUTH_MODE,
  emergencyPublishingEnabled: config.EMERGENCY_FEATURE_ENABLED,
  corsOrigins: config.CORS_ORIGINS.split(",")
    .map((x) => x.trim())
    .filter(Boolean),
  mediaAllowedOrigins: parseMediaAllowedOrigins(
    config.MEDIA_ALLOWED_ORIGINS,
    config.NODE_ENV,
  ),
  publicApiUrl: config.PUBLIC_API_URL,
  logger: config.LOG_LEVEL,
  trustProxy:
    config.TRUST_PROXY_RANGES.trim() === ""
      ? false
      : config.TRUST_PROXY_RANGES.split(",")
          .map((value) => value.trim())
          .filter(Boolean),
  ...(redis ? { redis } : {}),
  requireRedis: config.NODE_ENV === "production",
  closeRedisOnClose: true,
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
