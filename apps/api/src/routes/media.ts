import type { FastifyPluginAsync } from "fastify";
import {
  MEDIA_MAX_ASSET_BYTES,
  SUPPORTED_MEDIA_MIME_TYPES,
} from "@screengoblin/contracts";
import { z } from "zod";
import { ApiError, requireRole, sendNotFound } from "../utils/http.js";
import { opaqueId } from "../utils/validation.js";
import {
  hasMediaUrlCredentials,
  mediaUrlMatchesAllowedOrigin,
  usesAllowedMediaScheme,
} from "../utils/media-url.js";
import { isSupportedMedia } from "../utils/media-policy.js";
const body = z
  .object({
    name: z.string().trim().min(1).max(180),
    kind: z.enum(["image", "video", "web", "template"]),
    mimeType: z.string().min(3).max(120),
    url: z.url().max(2048),
    checksumSha256: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .transform((value) => value.toLowerCase()),
    sizeBytes: z.number().int().positive().max(MEDIA_MAX_ASSET_BYTES),
    durationSeconds: z.number().int().positive().max(86400).optional(),
    expiresAt: z.iso.datetime().optional(),
  })
  .strict();
const params = z.object({ id: opaqueId });
export const mediaRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", app.authenticate);
  app.get("/media", async (request) => ({
    data: await app.store.listMedia(request.user.organizationId),
  }));
  app.post("/media", async (request, reply) => {
    requireRole(request, ["OWNER", "ADMIN", "PUBLISHER"]);
    const input = body.parse(request.body);
    const mediaUrl = new URL(input.url);
    if (hasMediaUrlCredentials(mediaUrl))
      throw new ApiError(
        422,
        "MEDIA_URL_CREDENTIALS_NOT_ALLOWED",
        "Media URLs must not contain credentials",
      );
    if (!usesAllowedMediaScheme(mediaUrl))
      throw new ApiError(
        422,
        "MEDIA_URL_NOT_ALLOWED",
        "Media must use HTTPS or a loopback development URL",
      );
    if (
      !mediaUrlMatchesAllowedOrigin(input.url, app.config.mediaAllowedOrigins)
    )
      throw new ApiError(
        422,
        "MEDIA_ORIGIN_NOT_ALLOWED",
        "Media must use an approved content origin",
      );
    if (!isSupportedMedia(input.kind, input.mimeType))
      throw new ApiError(
        422,
        "MEDIA_TYPE_NOT_SUPPORTED",
        input.kind === "web"
          ? "Web content is disabled"
          : `Supported ${input.kind} types: ${SUPPORTED_MEDIA_MIME_TYPES[input.kind].join(", ")}`,
      );
    if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now())
      throw new ApiError(
        422,
        "MEDIA_EXPIRY_INVALID",
        "Media expiry must be in the future",
      );
    const result = await app.store.createMediaAndAudit(
      request.user.organizationId,
      input,
      {
        actorUserId: request.user.sub,
        ipAddress: request.ip,
        requestId: request.id,
      },
    );
    if (!result.created)
      throw new ApiError(
        403,
        "FORBIDDEN",
        "You do not have permission to perform this action",
      );
    return reply.code(201).send(result.value);
  });
  app.delete("/media/:id", async (request, reply) => {
    requireRole(request, ["OWNER", "ADMIN", "PUBLISHER"]);
    const { id } = params.parse(request.params);
    const result = await app.store.deleteMediaAndAudit(
      request.user.organizationId,
      id,
      {
        actorUserId: request.user.sub,
        ipAddress: request.ip,
        requestId: request.id,
      },
    );
    if (!result.deleted && result.reason === "FORBIDDEN")
      throw new ApiError(
        403,
        "FORBIDDEN",
        "You do not have permission to perform this action",
      );
    if (!result.deleted && result.reason === "NOT_FOUND")
      return sendNotFound(reply);
    if (!result.deleted && result.reason === "IN_USE")
      throw new ApiError(
        409,
        "RESOURCE_IN_USE",
        "Published or playlist content still references this media",
      );
    return reply.code(204).send();
  });
};
