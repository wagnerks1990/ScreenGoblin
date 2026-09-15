import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ApiError, requireRole, sendNotFound } from "../utils/http.js";
import { opaqueId } from "../utils/validation.js";
import type { MediaRecord } from "../domain/types.js";

const publicMedia = (media: MediaRecord) => {
  const result = { ...media };
  delete result.storageKey;
  return result;
};
const params = z.object({ id: opaqueId });
export const mediaRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", app.authenticate);
  app.get("/media", async (request) => ({
    data: (await app.store.listMedia(request.user.organizationId)).map(
      publicMedia,
    ),
  }));
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
