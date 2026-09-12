import type { FastifyPluginAsync } from "fastify";
import { compare } from "bcryptjs";
import { z } from "zod";
import { ApiError } from "../utils/http.js";
import { randomToken, sha256 } from "../utils/crypto.js";
import {
  enforceRateLimitBudget,
  opaqueRateLimitKey,
} from "../utils/rate-limit.js";

// Cost-12 bcrypt hash used only to equalize failed-login work when the account
// does not exist. It is not a credential for any ScreenGoblin account.
const DUMMY_PASSWORD_HASH =
  "$2b$12$C6UzMDM.H6dfI/f/IKcEe.82jG7y4g4AY8I8HibLFSWafVkx8S4hS";
const SESSION_LIFETIME_SECONDS = 60 * 60;

const loginSchema = z
  .object({
    email: z
      .string()
      .transform((value) => value.trim().toLowerCase())
      .pipe(z.email().max(254)),
    password: z.string().min(8).max(200),
  })
  .strict();
export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/auth/login",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
          keyGenerator: (request) =>
            opaqueRateLimitKey(
              app.config.pairingCodePepper,
              "login-source",
              request.ip,
            ),
        },
      },
      preHandler: async (request) => {
        const email =
          typeof request.body === "object" &&
          request.body !== null &&
          "email" in request.body &&
          typeof request.body.email === "string"
            ? request.body.email.trim().toLowerCase()
            : "invalid";
        await enforceRateLimitBudget(
          app.rateLimitBudget,
          opaqueRateLimitKey(
            app.config.pairingCodePepper,
            "login-account",
            email,
          ),
          10,
        );
      },
    },
    async (request) => {
      const input = loginSchema.parse(request.body);
      const user = await app.store.findUserByEmail(input.email);
      const passwordValid = await compare(
        input.password,
        user?.passwordHash ?? DUMMY_PASSWORD_HASH,
      );
      if (!user || !passwordValid)
        throw new ApiError(
          401,
          "INVALID_CREDENTIALS",
          "Email or password is incorrect",
        );
      const sessionId = randomToken();
      const expiresAt = new Date(
        Date.now() + SESSION_LIFETIME_SECONDS * 1000,
      ).toISOString();
      const accessToken = await request.server.jwt.sign(
        {
          sub: user.id,
          email: user.email,
          organizationId: user.organizationId,
          role: user.role,
          sessionId,
        },
        { expiresIn: SESSION_LIFETIME_SECONDS },
      );
      const created = await app.store.createUserSessionAndAudit(
        user.organizationId,
        {
          tokenHash: sha256(sessionId),
          expiresAt,
          expectedPasswordHash: user.passwordHash,
          expectedRole: user.role,
        },
        {
          actorUserId: user.id,
          ipAddress: request.ip,
          requestId: request.id,
        },
      );
      if (!created.created)
        throw new ApiError(
          401,
          "INVALID_CREDENTIALS",
          "Email or password is incorrect",
        );
      return {
        accessToken,
        tokenType: "Bearer",
        expiresIn: SESSION_LIFETIME_SECONDS,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          organizationId: user.organizationId,
          role: user.role,
        },
      };
    },
  );
  app.get("/auth/me", { onRequest: [app.authenticate] }, async (request) => ({
    user: {
      sub: request.user.sub,
      email: request.user.email,
      organizationId: request.user.organizationId,
      role: request.user.role,
    },
  }));
  app.post(
    "/auth/logout",
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      await app.store.revokeUserSessionAndAudit(
        request.user.sub,
        request.user.organizationId,
        sha256(request.user.sessionId),
        {
          actorUserId: request.user.sub,
          ipAddress: request.ip,
          requestId: request.id,
        },
      );
      return reply.code(204).send();
    },
  );
};
