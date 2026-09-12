import type { FastifyPluginAsync } from "fastify";
import { CAPABILITIES } from "@screengoblin/contracts";
import { z } from "zod";
import { ApiError, requireCapability, sendNotFound } from "../utils/http.js";
import { opaqueId } from "../utils/validation.js";
const body = z
  .object({
    title: z.string().trim().min(1).max(120),
    message: z.string().trim().min(1).max(2000),
    backgroundColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default("#C1121F"),
    targetScreenIds: z.array(opaqueId).min(1).max(1000),
    expiresAt: z.iso.datetime(),
  })
  .strict()
  .refine((v) => new Date(v.expiresAt).getTime() > Date.now(), {
    message: "expiresAt must be in the future",
    path: ["expiresAt"],
  })
  .refine(
    (v) => new Date(v.expiresAt).getTime() <= Date.now() + 24 * 60 * 60_000,
    {
      message: "expiresAt must be within 24 hours",
      path: ["expiresAt"],
    },
  );
const params = z.object({ id: opaqueId });
export const emergencyRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", app.authenticate);
  app.post("/emergencies", async (request, reply) => {
    requireCapability(request, CAPABILITIES.emergencyActivate);
    if (!app.config.emergencyPublishingEnabled)
      throw new ApiError(
        503,
        "FEATURE_DISABLED",
        "Emergency publishing is disabled on this deployment",
      );
    const input = body.parse(request.body);
    const result = await app.store.activateEmergencyAndAudit(
      request.user.organizationId,
      input,
      {
        actorUserId: request.user.sub,
        ipAddress: request.ip,
        requestId: request.id,
      },
    );
    if (!result.activated && result.reason === "FORBIDDEN")
      throw new ApiError(
        403,
        "FORBIDDEN",
        "You do not have permission to perform this action",
      );
    if (!result.activated)
      throw new ApiError(
        422,
        "INVALID_SCREEN",
        "A target screen is not in this organization",
      );
    return reply.code(201).send(result.emergency);
  });
  app.post("/emergencies/:id/clear", async (request, reply) => {
    requireCapability(request, CAPABILITIES.emergencyClear);
    if (!app.config.emergencyPublishingEnabled)
      throw new ApiError(
        503,
        "FEATURE_DISABLED",
        "Emergency publishing is disabled on this deployment",
      );
    const { id } = params.parse(request.params);
    const result = await app.store.clearEmergencyAndAudit(
      request.user.organizationId,
      id,
      {
        actorUserId: request.user.sub,
        ipAddress: request.ip,
        requestId: request.id,
      },
    );
    if (!result.cleared && result.reason === "FORBIDDEN")
      throw new ApiError(
        403,
        "FORBIDDEN",
        "You do not have permission to perform this action",
      );
    if (!result.cleared) return sendNotFound(reply);
    return result.emergency;
  });
};
