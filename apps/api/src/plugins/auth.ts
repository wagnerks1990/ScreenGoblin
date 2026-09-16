import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { ApiError } from "../utils/http.js";
import { secureHashEquals, sha256 } from "../utils/crypto.js";

export const authPlugin: FastifyPluginAsync = fp(async (app) => {
  app.decorate("authenticateAnySession", async (request) => {
    try {
      await request.jwtVerify();
    } catch {
      throw new ApiError(
        401,
        "UNAUTHORIZED",
        "A valid access token is required",
      );
    }
    const sessionId = request.user.sessionId;
    const session =
      typeof sessionId === "string"
        ? await app.store.findActiveUserSession(
            request.user.sub,
            request.user.organizationId,
            sha256(sessionId),
          )
        : null;
    if (!session || session.role !== request.user.role)
      throw new ApiError(
        401,
        "SESSION_REVOKED",
        "This session is no longer valid",
      );
    request.sessionUser = session;
  });
  app.decorate("authenticate", async (request, reply) => {
    await app.authenticateAnySession(request, reply);
    if (request.sessionUser?.sessionPurpose !== "FULL")
      throw new ApiError(
        403,
        "PASSWORD_ROTATION_REQUIRED",
        "The bootstrap password must be changed before continuing",
      );
  });
  app.decorate("authenticateBootstrapRotation", async (request, reply) => {
    await app.authenticateAnySession(request, reply);
    if (request.sessionUser?.sessionPurpose !== "BOOTSTRAP_PASSWORD_ROTATION")
      throw new ApiError(
        403,
        "BOOTSTRAP_PASSWORD_ROTATION_SESSION_REQUIRED",
        "A bootstrap password rotation session is required",
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
