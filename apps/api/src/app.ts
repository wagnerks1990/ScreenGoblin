import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
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

export interface BuildOptions {
  store?: DataStore;
  jwtSecret: string;
  manifestSigningSecret: string;
  emergencyPublishingEnabled?: boolean;
  corsOrigins?: string[];
  logger?: boolean;
}
export async function buildApp(
  options: BuildOptions,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger
      ? {
          redact: [
            "req.headers.authorization",
            "req.headers.x-device-token",
            "body.password",
          ],
        }
      : false,
    bodyLimit: 10 * 1024 * 1024,
    trustProxy: true,
    requestIdHeader: "x-request-id",
  });
  app.decorate("store", options.store ?? new PrismaStore());
  app.decorate("config", {
    manifestSigningSecret: options.manifestSigningSecret,
    emergencyPublishingEnabled: options.emergencyPublishingEnabled ?? false,
  });
  app.addHook("onClose", async () => {
    await app.store.close?.();
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: options.corsOrigins ?? ["http://localhost:5173"],
    credentials: true,
  });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  await app.register(jwt, { secret: options.jwtSecret });
  await app.register(authPlugin);
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
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      await app.store.ping();
      return { status: "ready" };
    } catch {
      app.log.error("Database readiness check failed");
      return reply.code(503).send({ status: "not_ready" });
    }
  });
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
