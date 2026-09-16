import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { compare, hash } from "bcryptjs";
import { z } from "zod";
import type {
  DataStore,
  LoginFailureReason,
  SessionUser,
} from "../domain/types.js";
import { ApiError } from "../utils/http.js";
import { randomToken, sha256 } from "../utils/crypto.js";
import {
  enforceRateLimitBudget,
  opaqueRateLimitKey,
  opaqueSecurityEventKey,
} from "../utils/rate-limit.js";

// Cost-12 bcrypt hash used only to equalize failed-login work when the account
// does not exist. It is not a credential for any ScreenGoblin account.
const DUMMY_PASSWORD_HASH =
  "$2b$12$C6UzMDM.H6dfI/f/IKcEe.82jG7y4g4AY8I8HibLFSWafVkx8S4hS";
const SESSION_LIFETIME_SECONDS = 60 * 60;
const BOOTSTRAP_ROTATION_SESSION_LIFETIME_SECONDS = 10 * 60;
const PASSWORD_HASH_ROUNDS = 12;

type PasswordComparator = (
  password: string,
  passwordHash: string,
) => Promise<boolean>;

export const verifyLoginCredentials = async (
  store: Pick<DataStore, "findUserByEmail">,
  email: string,
  password: string,
  comparePassword: PasswordComparator = compare,
): Promise<SessionUser | null> => {
  const user = await store.findUserByEmail(email);
  const passwordValid = await comparePassword(
    password,
    user?.passwordHash ?? DUMMY_PASSWORD_HASH,
  );
  return user && passwordValid ? user : null;
};

const loginSchema = z
  .object({
    email: z
      .string()
      .transform((value) => value.trim().toLowerCase())
      .pipe(z.email().max(254)),
    password: z.string().min(8).max(200),
  })
  .strict();
const strongPassword = z.string().superRefine((value, context) => {
  if ([...value].length < 16)
    context.addIssue({
      code: "too_small",
      origin: "string",
      minimum: 16,
      inclusive: true,
      message: "Password must contain at least 16 characters",
    });
  if (Buffer.byteLength(value, "utf8") > 72)
    context.addIssue({
      code: "too_big",
      origin: "string",
      maximum: 72,
      inclusive: true,
      message: "Password must contain at most 72 UTF-8 bytes",
    });
});
const bootstrapPasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: strongPassword,
  })
  .strict()
  .refine((input) => input.currentPassword !== input.newPassword, {
    path: ["newPassword"],
    message: "New password must differ from the bootstrap password",
  });
export const authRoutes: FastifyPluginAsync = async (app) => {
  const recordLoginFailure = async (
    request: FastifyRequest,
    email: string,
    reason: LoginFailureReason,
  ) => {
    try {
      await app.store.recordLoginFailure({
        accountKey: opaqueSecurityEventKey(
          app.config.pairingCodePepper,
          "login-failure-account",
          email,
        ),
        sourceKey: opaqueSecurityEventKey(
          app.config.pairingCodePepper,
          "login-failure-source",
          request.ip,
        ),
        reason,
      });
    } catch {
      throw new ApiError(
        503,
        "AUTH_TELEMETRY_UNAVAILABLE",
        "Sign-in is temporarily unavailable",
      );
    }
  };

  app.post(
    "/auth/login",
    {
      preHandler: async (request) => {
        const email =
          typeof request.body === "object" &&
          request.body !== null &&
          "email" in request.body &&
          typeof request.body.email === "string"
            ? request.body.email.trim().toLowerCase()
            : "invalid";
        try {
          await enforceRateLimitBudget(
            app.rateLimitBudget,
            opaqueRateLimitKey(
              app.config.pairingCodePepper,
              "login-source",
              request.ip,
            ),
            10,
          );
          await enforceRateLimitBudget(
            app.rateLimitBudget,
            opaqueRateLimitKey(
              app.config.pairingCodePepper,
              "login-account",
              email,
            ),
            10,
          );
        } catch (error) {
          if (error instanceof ApiError && error.code === "RATE_LIMITED")
            await recordLoginFailure(request, email, "RATE_LIMITED");
          throw error;
        }
      },
    },
    async (request) => {
      const input = loginSchema.parse(request.body);
      const user = await verifyLoginCredentials(
        app.store,
        input.email,
        input.password,
      );
      if (!user) {
        await recordLoginFailure(request, input.email, "INVALID_CREDENTIALS");
        throw new ApiError(
          401,
          "INVALID_CREDENTIALS",
          "Email or password is incorrect",
        );
      }
      const issueTime = Date.now();
      const bootstrapExpiry = user.bootstrapPasswordExpiresAt
        ? Date.parse(user.bootstrapPasswordExpiresAt)
        : null;
      const sessionPurpose = bootstrapExpiry
        ? ("BOOTSTRAP_PASSWORD_ROTATION" as const)
        : ("FULL" as const);
      const lifetimeSeconds = bootstrapExpiry
        ? Math.min(
            BOOTSTRAP_ROTATION_SESSION_LIFETIME_SECONDS,
            Math.floor((bootstrapExpiry - issueTime) / 1000),
          )
        : SESSION_LIFETIME_SECONDS;
      if (lifetimeSeconds < 1) {
        await recordLoginFailure(request, input.email, "INVALID_CREDENTIALS");
        throw new ApiError(
          401,
          "INVALID_CREDENTIALS",
          "Email or password is incorrect",
        );
      }
      const sessionId = randomToken();
      const expiresAt = new Date(
        issueTime + lifetimeSeconds * 1000,
      ).toISOString();
      const accessToken = await request.server.jwt.sign(
        {
          sub: user.id,
          email: user.email,
          organizationId: user.organizationId,
          role: user.role,
          sessionId,
        },
        { expiresIn: lifetimeSeconds },
      );
      const created = await app.store.createUserSessionAndAudit(
        user.organizationId,
        {
          tokenHash: sha256(sessionId),
          expiresAt,
          expectedPasswordHash: user.passwordHash,
          expectedRole: user.role,
          expectedAuthenticationEpoch: user.authenticationEpoch,
          expectedAuthorizationEpoch: user.authorizationEpoch,
          purpose: sessionPurpose,
          ...(user.bootstrapPasswordExpiresAt
            ? {
                expectedBootstrapPasswordExpiresAt:
                  user.bootstrapPasswordExpiresAt,
              }
            : {}),
        },
        {
          actorUserId: user.id,
          ipAddress: request.ip,
          requestId: request.id,
        },
      );
      if (!created.created) {
        await recordLoginFailure(request, input.email, "INVALID_CREDENTIALS");
        throw new ApiError(
          401,
          "INVALID_CREDENTIALS",
          "Email or password is incorrect",
        );
      }
      if (
        sessionPurpose === "BOOTSTRAP_PASSWORD_ROTATION" &&
        user.bootstrapPasswordExpiresAt
      )
        return {
          accessToken,
          nextAction: "CHANGE_BOOTSTRAP_PASSWORD" as const,
          changeBefore: user.bootstrapPasswordExpiresAt,
        };
      return {
        accessToken,
        tokenType: "Bearer",
        expiresIn: lifetimeSeconds,
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
    "/auth/bootstrap-password",
    {
      onRequest: [app.authenticateBootstrapRotation],
      preHandler: async (request) => {
        const email = request.sessionUser!.email.trim().toLowerCase();
        try {
          await enforceRateLimitBudget(
            app.rateLimitBudget,
            opaqueRateLimitKey(
              app.config.pairingCodePepper,
              "bootstrap-password-session",
              request.user.sessionId,
            ),
            10,
          );
          await enforceRateLimitBudget(
            app.rateLimitBudget,
            opaqueRateLimitKey(
              app.config.pairingCodePepper,
              "login-source",
              request.ip,
            ),
            10,
          );
          await enforceRateLimitBudget(
            app.rateLimitBudget,
            opaqueRateLimitKey(
              app.config.pairingCodePepper,
              "login-account",
              email,
            ),
            10,
          );
        } catch (error) {
          if (error instanceof ApiError && error.code === "RATE_LIMITED")
            await recordLoginFailure(request, email, "RATE_LIMITED");
          throw error;
        }
      },
    },
    async (request, reply) => {
      const input = bootstrapPasswordSchema.parse(request.body);
      const principal = request.sessionUser;
      if (!principal?.bootstrapPasswordExpiresAt)
        throw new ApiError(
          401,
          "SESSION_REVOKED",
          "This session is no longer valid",
        );
      const currentPasswordValid = await compare(
        input.currentPassword,
        principal.passwordHash,
      );
      if (!currentPasswordValid) {
        await recordLoginFailure(
          request,
          principal.email.trim().toLowerCase(),
          "INVALID_CREDENTIALS",
        );
        throw new ApiError(
          401,
          "INVALID_CREDENTIALS",
          "Email or password is incorrect",
        );
      }
      if (await compare(input.newPassword, principal.passwordHash))
        throw new ApiError(
          400,
          "NEW_PASSWORD_REUSES_BOOTSTRAP_CREDENTIAL",
          "New password must differ from the bootstrap password",
        );
      const passwordHash = await hash(input.newPassword, PASSWORD_HASH_ROUNDS);
      const rotated = await app.store.rotateBootstrapPasswordAndAudit(
        request.user.sub,
        request.user.organizationId,
        {
          tokenHash: sha256(request.user.sessionId),
          expectedPasswordHash: principal.passwordHash,
          expectedBootstrapPasswordExpiresAt:
            principal.bootstrapPasswordExpiresAt,
          expectedAuthenticationEpoch: principal.authenticationEpoch,
          expectedAuthorizationEpoch: principal.authorizationEpoch,
          passwordHash,
        },
        {
          actorUserId: request.user.sub,
          ipAddress: request.ip,
          requestId: request.id,
        },
      );
      if (!rotated.rotated)
        throw new ApiError(
          401,
          "SESSION_REVOKED",
          "This session is no longer valid",
        );
      return reply.code(204).send();
    },
  );
  app.post(
    "/auth/logout",
    { onRequest: [app.authenticateAnySession] },
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
