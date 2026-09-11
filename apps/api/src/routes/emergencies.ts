import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ApiError, requireRole, sendNotFound } from "../utils/http.js";
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
    requireRole(request, ["OWNER", "ADMIN"]);
    if (!app.config.emergencyPublishingEnabled)
      throw new ApiError(
        503,
        "FEATURE_DISABLED",
        "Emergency publishing is disabled on this deployment",
      );
    const input = body.parse(request.body);
    for (const id of input.targetScreenIds)
      if (!(await app.store.getScreen(request.user.organizationId, id)))
        throw new ApiError(
          422,
          "INVALID_SCREEN",
          "A target screen is not in this organization",
        );
    const x = await app.store.createEmergency(
      request.user.organizationId,
      request.user.sub,
      input,
    );
    await app.store.audit({
      organizationId: request.user.organizationId,
      actorUserId: request.user.sub,
      actorType: "user",
      action: "emergency.activated",
      entityType: "emergency",
      entityId: x.id,
      ipAddress: request.ip,
      requestId: request.id,
      metadata: {
        targetCount: x.targetScreenIds.length,
        expiresAt: x.expiresAt,
      },
    });
    return reply.code(201).send(x);
  });
  app.post("/emergencies/:id/clear", async (request, reply) => {
    requireRole(request, ["OWNER", "ADMIN"]);
    if (!app.config.emergencyPublishingEnabled)
      throw new ApiError(
        503,
        "FEATURE_DISABLED",
        "Emergency publishing is disabled on this deployment",
      );
    const { id } = params.parse(request.params);
    const x = await app.store.clearEmergency(request.user.organizationId, id);
    if (!x) return sendNotFound(reply);
    await app.store.audit({
      organizationId: request.user.organizationId,
      actorUserId: request.user.sub,
      actorType: "user",
      action: "emergency.cleared",
      entityType: "emergency",
      entityId: id,
      ipAddress: request.ip,
      requestId: request.id,
      metadata: {},
    });
    return x;
  });
};
