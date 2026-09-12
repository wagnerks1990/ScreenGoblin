import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ApiError, requireRole, sendNotFound } from "../utils/http.js";
import { opaqueId } from "../utils/validation.js";
const body = z
  .object({
    name: z.string().trim().min(1).max(140),
    description: z.string().max(1000).default(""),
    items: z
      .array(
        z
          .object({
            assetId: opaqueId,
            position: z.number().int().nonnegative(),
            durationSeconds: z.number().int().min(1).max(86400),
          })
          .strict(),
      )
      .max(500),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.items.map((i) => i.position)).size !== v.items.length)
      ctx.addIssue({
        code: "custom",
        message: "Playlist positions must be unique",
        path: ["items"],
      });
  });
const params = z.object({ id: opaqueId });
export const playlistRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", app.authenticate);
  app.get("/playlists", async (request) => ({
    data: await app.store.listPlaylists(request.user.organizationId),
  }));
  app.get("/playlists/:id", async (request, reply) => {
    const { id } = params.parse(request.params);
    return (
      (await app.store.getPlaylist(request.user.organizationId, id)) ??
      sendNotFound(reply)
    );
  });
  app.post("/playlists", async (request, reply) => {
    requireRole(request, ["OWNER", "ADMIN", "PUBLISHER"]);
    const input = body.parse(request.body);
    for (const item of input.items)
      if (
        !(await app.store.getMedia(request.user.organizationId, item.assetId))
      )
        throw new ApiError(
          422,
          "INVALID_ASSET",
          "Playlist contains an unknown asset",
        );
    const result = await app.store.createPlaylistAndAudit(
      request.user.organizationId,
      {
        ...input,
        items: input.items.map((i) => ({ id: "", ...i })),
      },
      {
        actorUserId: request.user.sub,
        ipAddress: request.ip,
        requestId: request.id,
      },
    );
    if (!result.created && result.reason === "FORBIDDEN")
      throw new ApiError(
        403,
        "FORBIDDEN",
        "You do not have permission to perform this action",
      );
    if (!result.created)
      throw new ApiError(
        422,
        "INVALID_ASSET",
        "Playlist contains an unknown asset",
      );
    return reply.code(201).send(result.value);
  });
  app.delete("/playlists/:id", async (request, reply) => {
    requireRole(request, ["OWNER", "ADMIN", "PUBLISHER"]);
    const { id } = params.parse(request.params);
    const result = await app.store.deletePlaylistAndAudit(
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
        "A published release or schedule still references this playlist",
      );
    return reply.code(204).send();
  });
};
