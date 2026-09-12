import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { ApiError } from "../utils/http.js";
import { secureHashEquals } from "../utils/crypto.js";

export const authPlugin: FastifyPluginAsync = fp(async (app) => {
  app.decorate("authenticate", async (request) => {
    try {
      await request.jwtVerify();
    } catch {
      throw new ApiError(
        401,
        "UNAUTHORIZED",
        "A valid access token is required",
      );
    }
    const session = await app.store.findSessionUser(
      request.user.sub,
      request.user.organizationId,
    );
    if (!session || session.role !== request.user.role)
      throw new ApiError(
        401,
        "SESSION_REVOKED",
        "This session is no longer valid",
      );
  });
  app.decorate("authenticateDevice", async (request) => {
    if (app.config.deviceAuthMode !== "development-bearer")
      throw new ApiError(
        401,
        "DEVICE_UNAUTHORIZED",
        "Device credentials are invalid or revoked",
      );
    const screenId = request.headers["x-screen-id"];
    const token = request.headers["x-device-token"];
    if (typeof screenId !== "string" || typeof token !== "string")
      throw new ApiError(
        401,
        "DEVICE_UNAUTHORIZED",
        "Device credentials are required",
      );
    const screen = await app.store.authenticateDevice(screenId);
    if (
      !screen?.deviceTokenHash ||
      !secureHashEquals(token, screen.deviceTokenHash)
    )
      throw new ApiError(
        401,
        "DEVICE_UNAUTHORIZED",
        "Device credentials are invalid or revoked",
      );
    request.device = screen;
  });
});
