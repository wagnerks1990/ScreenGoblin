import type { FastifyPluginAsync } from "fastify";
import { compare } from "bcryptjs";
import { z } from "zod";
import { ApiError } from "../utils/http.js";

// Cost-12 bcrypt hash used only to equalize failed-login work when the account
// does not exist. It is not a credential for any ScreenGoblin account.
const DUMMY_PASSWORD_HASH =
  "$2b$12$C6UzMDM.H6dfI/f/IKcEe.82jG7y4g4AY8I8HibLFSWafVkx8S4hS";

const loginSchema = z
  .object({ email: z.email().max(254), password: z.string().min(8).max(200) })
  .strict();
export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
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
      const accessToken = await request.server.jwt.sign(
        {
          sub: user.id,
          email: user.email,
          organizationId: user.organizationId,
          role: user.role,
        },
        { expiresIn: "8h" },
      );
      await app.store.audit({
        organizationId: user.organizationId,
        actorUserId: user.id,
        actorType: "user",
        action: "auth.login_succeeded",
        entityType: "session",
        ipAddress: request.ip,
        requestId: request.id,
        metadata: {},
      });
      return {
        accessToken,
        tokenType: "Bearer",
        expiresIn: 28800,
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
    user: request.user,
  }));
};
