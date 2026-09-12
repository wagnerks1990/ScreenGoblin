import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ApiError, requireRole, sendNotFound } from "../utils/http.js";
import { opaqueId } from "../utils/validation.js";

const body = z.object({ name: z.string().trim().min(1).max(120) }).strict();
const params = z.object({ id: opaqueId });

const conflict = () =>
  new ApiError(409, "LOCATION_EXISTS", "A location with this name exists");
const forbidden = () =>
  new ApiError(
    403,
    "FORBIDDEN",
    "You do not have permission to perform this action",
  );

export const locationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", app.authenticate);

  app.get("/locations", async (request) => ({
    data: await app.store.listLocations(request.user.organizationId),
    authorizationScope: "organization-role",
  }));

  app.post("/locations", async (request, reply) => {
    requireRole(request, ["OWNER", "ADMIN"]);
    const { name } = body.parse(request.body);
    const result = await app.store.createLocationAndAudit(
      request.user.organizationId,
      name,
      {
        actorUserId: request.user.sub,
        ipAddress: request.ip,
        requestId: request.id,
      },
    );
    if (!result.created) {
      if (result.reason === "FORBIDDEN") throw forbidden();
      throw conflict();
    }
    return reply.code(201).send(result.value);
  });

  app.patch("/locations/:id", async (request, reply) => {
    requireRole(request, ["OWNER", "ADMIN"]);
    const { id } = params.parse(request.params);
    const { name } = body.parse(request.body);
    const result = await app.store.updateLocationAndAudit(
      request.user.organizationId,
      id,
      name,
      {
        actorUserId: request.user.sub,
        ipAddress: request.ip,
        requestId: request.id,
      },
    );
    if (!result.updated) {
      if (result.reason === "FORBIDDEN") throw forbidden();
      if (result.reason === "DUPLICATE") throw conflict();
      return sendNotFound(reply);
    }
    return result.value;
  });

  app.delete("/locations/:id", async (request, reply) => {
    requireRole(request, ["OWNER", "ADMIN"]);
    const { id } = params.parse(request.params);
    const result = await app.store.deleteLocationAndAudit(
      request.user.organizationId,
      id,
      {
        actorUserId: request.user.sub,
        ipAddress: request.ip,
        requestId: request.id,
      },
    );
    if (!result.deleted) {
      if (result.reason === "FORBIDDEN") throw forbidden();
      if (result.reason === "NOT_FOUND") return sendNotFound(reply);
      throw new ApiError(
        409,
        "RESOURCE_IN_USE",
        "A screen is still classified by this location",
      );
    }
    return reply.code(204).send();
  });
};
