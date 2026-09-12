import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ApiError, requireRole, sendNotFound } from "../utils/http.js";
import { opaqueId } from "../utils/validation.js";
import {
  hasMediaUrlCredentials,
  mediaUrlMatchesAllowedOrigin,
  usesAllowedMediaScheme,
} from "../utils/media-url.js";
const body = z
  .object({
    name: z.string().trim().min(1).max(180),
    kind: z.enum(["image", "video", "web", "template"]),
    mimeType: z.string().min(3).max(120),
    url: z.url().max(2048),
    checksumSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
    sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
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
    const x = await app.store.createMedia(request.user.organizationId, input);
    await app.store.audit({
      organizationId: request.user.organizationId,
      actorUserId: request.user.sub,
      actorType: "user",
      action: "media.created",
      entityType: "media",
      entityId: x.id,
      ipAddress: request.ip,
      requestId: request.id,
      metadata: { name: x.name },
    });
    return reply.code(201).send(x);
  });
  app.delete("/media/:id", async (request, reply) => {
    requireRole(request, ["OWNER", "ADMIN", "PUBLISHER"]);
    const { id } = params.parse(request.params);
    const result = await app.store.deleteMedia(request.user.organizationId, id);
    if (result === "NOT_FOUND") return sendNotFound(reply);
    if (result === "IN_USE")
      throw new ApiError(
        409,
        "RESOURCE_IN_USE",
        "Published or playlist content still references this media",
      );
    await app.store.audit({
      organizationId: request.user.organizationId,
      actorUserId: request.user.sub,
      actorType: "user",
      action: "media.deleted",
      entityType: "media",
      entityId: id,
      ipAddress: request.ip,
      requestId: request.id,
      metadata: {},
    });
    return reply.code(204).send();
  });
};
