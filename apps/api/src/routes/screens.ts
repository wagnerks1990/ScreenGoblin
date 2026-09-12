import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { CAPABILITIES } from "@screengoblin/contracts";
import {
  ApiError,
  requireCapability,
  requireRole,
  sendNotFound,
} from "../utils/http.js";
import { opaqueId } from "../utils/validation.js";

const screen = z
  .object({
    name: z.string().trim().min(1).max(120),
    location: z.string().trim().max(240).default(""),
    orientation: z.enum(["landscape", "portrait"]).default("landscape"),
    resolution: z
      .string()
      .regex(/^\d{3,5}x\d{3,5}$/)
      .default("1920x1080"),
    tags: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
  })
  .strict();
const params = z.object({ id: opaqueId });
export const screenRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", app.authenticate);
  app.get("/screens", async (request) => ({
    data: await app.store.listScreens(request.user.organizationId),
  }));
  app.get("/screens/:id", async (request, reply) => {
    const { id } = params.parse(request.params);
    const x = await app.store.getScreen(request.user.organizationId, id);
    return x ?? sendNotFound(reply);
  });
  app.post("/screens", async (request, reply) => {
    requireRole(request, ["OWNER", "ADMIN"]);
    const x = await app.store.createScreen(
      request.user.organizationId,
      screen.parse(request.body),
    );
    await app.store.audit({
      organizationId: request.user.organizationId,
      actorUserId: request.user.sub,
      actorType: "user",
      action: "screen.created",
      entityType: "screen",
      entityId: x.id,
      ipAddress: request.ip,
      requestId: request.id,
      metadata: { name: x.name },
    });
    return reply.code(201).send(x);
  });
  app.patch("/screens/:id", async (request, reply) => {
    requireRole(request, ["OWNER", "ADMIN"]);
    const { id } = params.parse(request.params);
    const parsed = screen.partial().parse(request.body);
    const changes = {
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.location !== undefined ? { location: parsed.location } : {}),
      ...(parsed.orientation !== undefined
        ? { orientation: parsed.orientation }
        : {}),
      ...(parsed.resolution !== undefined
        ? { resolution: parsed.resolution }
        : {}),
      ...(parsed.tags !== undefined ? { tags: parsed.tags } : {}),
    };
    const x = await app.store.updateScreen(
      request.user.organizationId,
      id,
      changes,
    );
    if (!x) return sendNotFound(reply);
    await app.store.audit({
      organizationId: request.user.organizationId,
      actorUserId: request.user.sub,
      actorType: "user",
      action: "screen.updated",
      entityType: "screen",
      entityId: id,
      ipAddress: request.ip,
      requestId: request.id,
      metadata: {},
    });
    return x;
  });
  app.post("/screens/:id/device-credential/revoke", async (request, reply) => {
    requireCapability(request, CAPABILITIES.screenCredentialRevoke);
    const { id } = params.parse(request.params);
    const result = await app.store.revokeDeviceCredentialAndAudit(
      request.user.organizationId,
      id,
      {
        actorUserId: request.user.sub,
        ipAddress: request.ip,
        requestId: request.id,
      },
    );
    if (!result.revoked) {
      if (result.reason === "FORBIDDEN")
        throw new ApiError(
          403,
          "FORBIDDEN",
          "You do not have permission to perform this action",
        );
      if (result.reason === "NOT_FOUND") return sendNotFound(reply);
    }
    return reply.code(204).send();
  });
  app.delete("/screens/:id", async (request, reply) => {
    requireRole(request, ["OWNER", "ADMIN"]);
    const { id } = params.parse(request.params);
    if (!(await app.store.deleteScreen(request.user.organizationId, id)))
      return sendNotFound(reply);
    await app.store.audit({
      organizationId: request.user.organizationId,
      actorUserId: request.user.sub,
      actorType: "user",
      action: "screen.deleted",
      entityType: "screen",
      entityId: id,
      ipAddress: request.ip,
      requestId: request.id,
      metadata: {},
    });
    return reply.code(204).send();
  });
};
