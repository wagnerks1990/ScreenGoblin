import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError, requireRole } from "../utils/http.js";
import {
  enforceRateLimitBudget,
  opaqueRateLimitKey,
} from "../utils/rate-limit.js";
import { sha256 } from "../utils/crypto.js";
import { verifyMailWebhook } from "../mail/webhook.js";
import type { MailApi, MailPrincipal } from "../mail/service.js";
const address = z
  .object({ email: z.string().trim().toLowerCase().pipe(z.email().max(254)) })
  .strict();
const confirmation = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    newPassword: z
      .string()
      .refine(
        (value) =>
          Array.from(value).length >= 16 &&
          Buffer.byteLength(value, "utf8") <= 72,
        "Use at least 16 characters and at most 72 UTF-8 bytes",
      ),
  })
  .strict();
const principal = (request: FastifyRequest): MailPrincipal => ({
  userId: request.user.sub,
  organizationId: request.user.organizationId,
  tokenHash: sha256(request.user.sessionId),
});
const missing = () =>
  new ApiError(503, "MAIL_UNAVAILABLE", "Email is temporarily unavailable");
const protect = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw missing();
  }
};
export const createMailRoutes =
  (mail: MailApi | undefined): FastifyPluginAsync =>
  async (app) => {
    app.get("/auth/recovery-options", async () => ({
      passwordResetEnabled: Boolean(mail),
    }));
    app.post(
      "/auth/password-reset/request",
      { bodyLimit: 4096 },
      async (request, reply) => {
        const input = address.parse(request.body);
        for (const [dimension, value, maximum] of [
          ["reset-source", request.ip, 10],
          ["reset-account", input.email, 3],
        ] as const)
          await enforceRateLimitBudget(
            app.rateLimitBudget,
            opaqueRateLimitKey(app.config.pairingCodePepper, dimension, value),
            maximum,
            15 * 60_000,
          );
        if (mail) {
          try {
            await mail.requestReset(input.email);
          } catch {
            request.log.error("Email reset request could not be queued");
          }
        }
        return reply.code(202).send({
          message:
            "If an eligible account exists, password-reset instructions will be emailed. If no email arrives, contact your administrator.",
        });
      },
    );
    app.post(
      "/auth/password-reset/confirm",
      { bodyLimit: 4096 },
      async (request, reply) => {
        await enforceRateLimitBudget(
          app.rateLimitBudget,
          opaqueRateLimitKey(
            app.config.pairingCodePepper,
            "reset-confirm",
            request.ip,
          ),
          10,
          15 * 60_000,
        );
        const input = confirmation.parse(request.body);
        if (!mail) throw missing();
        await protect(() => mail.confirmReset(input.token, input.newPassword));
        return reply.code(204).send();
      },
    );
    await app.register(async (management) => {
      management.addHook("onRequest", app.authenticate);
      management.addHook("preHandler", async (request) => {
        requireRole(request, ["OWNER", "ADMIN"]);
      });
      management.get("/mail", async (request) =>
        mail
          ? protect(() => mail.overview(principal(request)))
          : {
              configured: false,
              receivingConfigured: false,
              workerHealthy: false,
              offlineMinutes: 10,
              offlineAlertsEnabled: false,
              jobs: [],
              received: [],
            },
      );
      management.patch("/mail/preferences", async (request, reply) => {
        const input = z
          .object({ offlineAlertsEnabled: z.boolean() })
          .strict()
          .parse(request.body);
        if (!mail) throw missing();
        await protect(() =>
          mail.preferences(principal(request), input.offlineAlertsEnabled),
        );
        return reply.code(204).send();
      });
      management.patch("/mail/inbox", async (request, reply) => {
        const input = z
          .object({
            localPart: z
              .string()
              .trim()
              .toLowerCase()
              .regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
            enabled: z.boolean(),
          })
          .strict()
          .parse(request.body);
        if (!mail) throw missing();
        await protect(() =>
          mail.inbox(principal(request), input.localPart, input.enabled),
        );
        return reply.code(204).send();
      });
      management.post("/mail/test", async (request, reply) => {
        const key = z
          .uuid({ version: "v4" })
          .parse(request.headers["idempotency-key"]);
        await enforceRateLimitBudget(
          app.rateLimitBudget,
          opaqueRateLimitKey(
            app.config.pairingCodePepper,
            "mail-test",
            request.user.organizationId + ":" + request.user.sub,
          ),
          3,
          60 * 60_000,
        );
        if (!mail) throw missing();
        const result = await protect(() => mail.test(principal(request), key));
        return reply.code(202).send(result);
      });
    });
    await app.register(async (webhook) => {
      webhook.removeContentTypeParser("application/json");
      webhook.addContentTypeParser(
        "application/json",
        { parseAs: "buffer" },
        (_request, body, done) => done(null, body),
      );
      webhook.post(
        "/webhooks/resend",
        { bodyLimit: 65536 },
        async (request, reply) => {
          if (!mail)
            return reply.code(404).send({
              error: { code: "NOT_FOUND", message: "Route not found" },
            });
          if (!Buffer.isBuffer(request.body))
            throw new ApiError(
              400,
              "INVALID_WEBHOOK",
              "Webhook body is invalid",
            );
          const result = verifyMailWebhook(
            request.body,
            request.headers,
            mail.webhookSecret,
          );
          await protect(() => mail.webhook(result.id, result.event));
          return reply.code(204).send();
        },
      );
    });
  };
