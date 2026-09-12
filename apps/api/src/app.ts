import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import type { Redis } from "ioredis";
import { ZodError } from "zod";
import type { DataStore } from "./domain/types.js";
import { PrismaStore } from "./store/prisma.js";
import { authPlugin } from "./plugins/auth.js";
import { ApiError } from "./utils/http.js";
import { authRoutes } from "./routes/auth.js";
import { screenRoutes } from "./routes/screens.js";
import { mediaRoutes } from "./routes/media.js";
import { playlistRoutes } from "./routes/playlists.js";
import { scheduleRoutes } from "./routes/schedules.js";
import { emergencyRoutes } from "./routes/emergencies.js";
import { auditRoutes } from "./routes/audits.js";
import { deviceRoutes, pairingAdminRoutes } from "./routes/devices.js";
import {
  MemoryRateLimitBudget,
  opaqueRateLimitKey,
  RedisRateLimitBudget,
  type RateLimitBudget,
} from "./utils/rate-limit.js";

export interface BuildOptions {
  store?: DataStore;
  jwtSecret: string;
  manifestSigningPrivateKey: string;
  pairingCodePepper: string;
  deviceAuthMode: "proof-v1" | "development-bearer";
  emergencyPublishingEnabled?: boolean;
  corsOrigins?: string[];
  logger?: boolean | string;
  trustProxy?: boolean | string[];
  mediaAllowedOrigins?: string[];
  publicApiUrl?: string;
  redis?: Redis;
  rateLimitBudget?: RateLimitBudget;
  requireRedis?: boolean;
  closeRedisOnClose?: boolean;
}
export async function buildApp(
  options: BuildOptions,
): Promise<FastifyInstance> {
  if (options.requireRedis && !options.redis)
    throw new Error("Redis is required for production request protection");
  const app = Fastify({
    logger: options.logger
      ? {
          level: options.logger === true ? "info" : options.logger,
          redact: [
            "req.headers.authorization",
            "req.headers.x-device-token",
            "req.headers.x-device-challenge",
            "req.headers.x-device-signature",
            "body.password",
          ],
        }
      : false,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: options.trustProxy ?? false,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
  });
  app.decorate("store", options.store ?? new PrismaStore());
  app.decorate(
    "rateLimitBudget",
    options.rateLimitBudget ??
      (options.redis
        ? new RedisRateLimitBudget(options.redis)
        : new MemoryRateLimitBudget()),
  );
  app.decorate("config", {
    manifestSigningPrivateKey: options.manifestSigningPrivateKey,
    pairingCodePepper: options.pairingCodePepper,
    deviceAuthMode: options.deviceAuthMode,
    emergencyPublishingEnabled: options.emergencyPublishingEnabled ?? false,
    mediaAllowedOrigins: options.mediaAllowedOrigins ?? [],
    ...(options.publicApiUrl ? { publicApiUrl: options.publicApiUrl } : {}),
  });
  app.addHook("onClose", async () => {
    await app.store.close?.();
    if (options.redis && options.closeRedisOnClose) await options.redis.quit();
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: options.corsOrigins ?? ["http://localhost:5173"],
    credentials: true,
  });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    redis: options.redis,
    skipOnError: false,
    nameSpace: "screengoblin:request:",
    keyGenerator: (request) =>
      opaqueRateLimitKey(options.pairingCodePepper, "source", request.ip),
  });
  await app.register(jwt, { secret: options.jwtSecret });
  await app.register(authPlugin);
  app.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith("/api/") || request.url.startsWith("/health/"))
      reply.header("Cache-Control", "no-store");
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        requestId: request.id,
      });
    if (error instanceof ApiError)
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message },
        requestId: request.id,
      });
    const candidate = error as { statusCode?: unknown; message?: unknown };
    const status =
      typeof candidate.statusCode === "number" && candidate.statusCode < 500
        ? candidate.statusCode
        : 500;
    if (status >= 500)
      request.log.error({ err: error }, "Unhandled request error");
    return reply.code(status).send({
      error: {
        code:
          status === 429
            ? "RATE_LIMITED"
            : status === 500
              ? "INTERNAL_ERROR"
              : "REQUEST_ERROR",
        message:
          status === 500
            ? "An unexpected error occurred"
            : typeof candidate.message === "string"
              ? candidate.message
              : "Request failed",
      },
      requestId: request.id,
    });
  });
  app.get(
    "/health/live",
    { config: { rateLimit: false } },
    async (_request, reply) => reply.code(204).send(),
  );
  app.get(
    "/health/ready",
    { config: { rateLimit: false } },
    async (_request, reply) => {
      try {
        await app.store.ping();
        if (options.redis) await options.redis.ping();
        else if (options.requireRedis)
          throw new Error("Required request-protection store is unavailable");
        return reply.code(204).send();
      } catch {
        app.log.error("Readiness dependency check failed");
        return reply.code(503).send();
      }
    },
  );
  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(screenRoutes);
      await api.register(mediaRoutes);
      await api.register(playlistRoutes);
      await api.register(scheduleRoutes);
      await api.register(emergencyRoutes);
      await api.register(auditRoutes);
      await api.register(pairingAdminRoutes);
    },
    { prefix: "/api/v1" },
  );
  await app.register(deviceRoutes, { prefix: "/api/v1/device" });
  app.setNotFoundHandler((_request, reply) =>
    reply
      .code(404)
      .send({ error: { code: "NOT_FOUND", message: "Route not found" } }),
  );
  return app;
}
