import type { FastifyPluginAsync } from "fastify";
import { CAPABILITIES } from "@screengoblin/contracts";
import { z } from "zod";
import { ApiError, requireCapability, sendNotFound } from "../utils/http.js";
import { opaqueId } from "../utils/validation.js";
import { validTimeZone } from "../utils/schedule.js";
import {
  schedulePublicationKeyHash,
  schedulePublicationRequestDigest,
} from "../releases/canonical.js";
import { managementSchedule } from "./management-dto.js";
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
const idempotencyKey = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "Idempotency-Key must be a canonical UUIDv4",
  );
export const scheduleRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", app.authenticate);
  app.get("/schedules", async (request) => ({
    data: (await app.store.listSchedules(request.user.organizationId)).map(
      managementSchedule,
    ),
  }));
  app.post("/schedules", async (request, reply) => {
    requireCapability(request, CAPABILITIES.releasePublish);
    const input = body.parse(request.body);
    const key = idempotencyKey.parse(request.headers["idempotency-key"]);
    const result = await app.store.publishScheduleAndAudit(
      request.user.organizationId,
      input,
      {
        actorUserId: request.user.sub,
        ipAddress: request.ip,
        requestId: request.id,
      },
      { mediaAllowedOrigins: app.config.mediaAllowedOrigins },
      {
        keyHash: schedulePublicationKeyHash(request.user.organizationId, key),
        requestDigestSha256: schedulePublicationRequestDigest(input),
      },
    );
    if (!result.published) {
      if (result.reason === "FORBIDDEN")
        throw new ApiError(
          403,
          "FORBIDDEN",
          "You do not have permission to perform this action",
        );
      if (
        result.reason === "IDEMPOTENCY_KEY_REUSED" ||
        result.reason === "IDEMPOTENCY_KEY_EXPIRED"
      )
        throw new ApiError(
          409,
          result.reason,
          result.reason === "IDEMPOTENCY_KEY_REUSED"
            ? "Idempotency key was already used for another request"
            : "Idempotency key replay window has expired",
        );
      const errors = {
        PLAYLIST_NOT_FOUND: [
          "INVALID_PLAYLIST",
          "Playlist is not in this organization",
        ],
        SCREEN_NOT_FOUND: [
          "INVALID_SCREEN",
          "A target screen is not in this organization",
        ],
        ASSET_NOT_FOUND: [
          "INVALID_ASSET",
          "Playlist contains an unknown asset",
        ],
        ASSET_NOT_ALLOWED: [
          "MEDIA_ORIGIN_NOT_ALLOWED",
          "Playlist contains media outside the approved origin policy",
        ],
        ASSET_UNSUPPORTED: [
          "MEDIA_TYPE_NOT_SUPPORTED",
          "Playlist contains unsupported media",
        ],
        ASSET_EXPIRED: ["MEDIA_EXPIRED", "Playlist contains expired media"],
        RELEASE_TOO_LARGE: [
          "RELEASE_TOO_LARGE",
          "Release media exceeds the aggregate size limit",
        ],
        NO_PLAYABLE_ITEMS: [
          "EMPTY_RELEASE",
          "A schedule must publish at least one item",
        ],
      } as const;
      const [code, message] = errors[result.reason];
      throw new ApiError(422, code, message);
    }
    return reply.code(201).send(managementSchedule(result.schedule));
  });
  app.delete("/schedules/:id", async (request, reply) => {
    requireCapability(request, CAPABILITIES.releaseWithdraw);
    const { id } = params.parse(request.params);
    const result = await app.store.withdrawScheduleAndAudit(
      request.user.organizationId,
      id,
      {
        actorUserId: request.user.sub,
        ipAddress: request.ip,
        requestId: request.id,
      },
    );
    if (!result.withdrawn && result.reason === "FORBIDDEN")
      throw new ApiError(
        403,
        "FORBIDDEN",
        "You do not have permission to perform this action",
      );
    if (!result.withdrawn && result.reason === "NOT_FOUND")
      return sendNotFound(reply);
    return reply.code(204).send();
  });
};
