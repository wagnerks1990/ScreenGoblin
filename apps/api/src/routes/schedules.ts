import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ApiError, requireRole, sendNotFound } from "../utils/http.js";
import { opaqueId } from "../utils/validation.js";
import { validTimeZone } from "../utils/schedule.js";
const body = z
  .object({
    playlistId: opaqueId,
    name: z.string().trim().min(1).max(140),
    priority: z.enum(["normal", "campaign", "priority"]).default("normal"),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime().optional(),
    timezone: z
      .string()
      .min(1)
      .max(80)
      .refine(validTimeZone, "timezone must be a valid IANA time zone")
      .default("UTC"),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).default([]),
    dailyStartMinutes: z.number().int().min(0).max(1439).optional(),
    dailyEndMinutes: z.number().int().min(1).max(1440).optional(),
    enabled: z.boolean().default(true),
    screenIds: z.array(opaqueId).min(1).max(1000),
  })
  .strict()
  .refine((v) => !v.endsAt || v.endsAt > v.startsAt, {
    message: "endsAt must be after startsAt",
    path: ["endsAt"],
  })
  .refine(
    (v) =>
      v.dailyStartMinutes === undefined ||
      v.dailyEndMinutes === undefined ||
      v.dailyEndMinutes > v.dailyStartMinutes,
    {
      message: "dailyEndMinutes must be after dailyStartMinutes",
      path: ["dailyEndMinutes"],
    },
  );
const params = z.object({ id: opaqueId });
export const scheduleRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", app.authenticate);
  app.get("/schedules", async (request) => ({
    data: await app.store.listSchedules(request.user.organizationId),
  }));
  app.post("/schedules", async (request, reply) => {
    requireRole(request, ["OWNER", "ADMIN", "PUBLISHER"]);
    const input = body.parse(request.body);
    if (
      !(await app.store.getPlaylist(
        request.user.organizationId,
        input.playlistId,
      ))
    )
      throw new ApiError(
        422,
        "INVALID_PLAYLIST",
        "Playlist is not in this organization",
      );
    for (const id of input.screenIds)
      if (!(await app.store.getScreen(request.user.organizationId, id)))
        throw new ApiError(
          422,
          "INVALID_SCREEN",
          "A target screen is not in this organization",
        );
    const x = await app.store.createSchedule(
      request.user.organizationId,
      input,
    );
    await app.store.audit({
      organizationId: request.user.organizationId,
      actorUserId: request.user.sub,
      actorType: "user",
      action: "schedule.created",
      entityType: "schedule",
      entityId: x.id,
      ipAddress: request.ip,
      requestId: request.id,
      metadata: { priority: x.priority },
    });
    return reply.code(201).send(x);
  });
  app.delete("/schedules/:id", async (request, reply) => {
    requireRole(request, ["OWNER", "ADMIN", "PUBLISHER"]);
    const { id } = params.parse(request.params);
    if (!(await app.store.deleteSchedule(request.user.organizationId, id)))
      return sendNotFound(reply);
    return reply.code(204).send();
  });
};
