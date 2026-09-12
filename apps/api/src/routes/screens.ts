import type { FastifyPluginAsync } from "fastify";
import { randomInt } from "node:crypto";
import { z } from "zod";
import { CAPABILITIES } from "@screengoblin/contracts";
import {
  ApiError,
  requireCapability,
  requireRole,
  sendNotFound,
} from "../utils/http.js";
import { opaqueId } from "../utils/validation.js";
import { pairingCodeHash } from "../utils/crypto.js";
import {
  enforceRateLimitBudget,
  opaqueRateLimitKey,
} from "../utils/rate-limit.js";

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
const reenrollmentParams = z.object({ id: opaqueId, grantId: opaqueId });
const activationParams = reenrollmentParams.extend({ candidateId: opaqueId });
const reenrollmentRequest = z
  .object({ reason: z.string().trim().min(5).max(500) })
  .strict();
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
  app.post(
    "/screens/:id/device-reenrollment",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
          keyGenerator: (request) =>
            opaqueRateLimitKey(
              app.config.pairingCodePepper,
              "reenrollment-create-source",
              request.ip,
            ),
        },
      },
      preHandler: async (request) => {
        requireCapability(request, CAPABILITIES.screenCredentialReenroll);
        await Promise.all([
          enforceRateLimitBudget(
            app.rateLimitBudget,
            opaqueRateLimitKey(
              app.config.pairingCodePepper,
              "reenrollment-create-org",
              request.user.organizationId,
            ),
            20,
          ),
          enforceRateLimitBudget(
            app.rateLimitBudget,
            opaqueRateLimitKey(
              app.config.pairingCodePepper,
              "reenrollment-create-operator",
              request.user.sub,
            ),
            10,
          ),
        ]);
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      requireCapability(request, CAPABILITIES.screenCredentialReenroll);
      const { id } = params.parse(request.params);
      const { reason } = reenrollmentRequest.parse(request.body);
      const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
        const result = await app.store.requestScreenReenrollmentAndAudit(
          request.user.organizationId,
          id,
          pairingCodeHash(code, app.config.pairingCodePepper),
          expiresAt,
          reason,
          {
            actorUserId: request.user.sub,
            ipAddress: request.ip,
            requestId: request.id,
          },
        );
        if (result.created)
          return reply.code(201).send({
            grantId: result.pairing.id,
            screenId: id,
            code,
            expiresAt: result.pairing.expiresAt,
            generation: result.pairing.expectedGeneration,
          });
        if (result.reason === "FORBIDDEN")
          throw new ApiError(
            403,
            "FORBIDDEN",
            "You do not have permission to perform this action",
          );
        if (result.reason === "NOT_FOUND") return sendNotFound(reply);
      }
      throw new ApiError(
        409,
        "REENROLLMENT_ALREADY_PENDING",
        "A re-enrollment grant is already pending for this screen",
      );
    },
  );
  app.get(
    "/screens/:id/device-reenrollment/:grantId",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      requireCapability(request, CAPABILITIES.screenCredentialReenroll);
      const { id, grantId } = reenrollmentParams.parse(request.params);
      const status = await app.store.getReenrollmentStatus(
        request.user.organizationId,
        id,
        grantId,
        request.user.sub,
      );
      if (!status) return sendNotFound(reply);
      return reply.send({
        grantId,
        screenId: id,
        status: status.status.toLowerCase(),
        expiresAt: status.expiresAt,
        candidates: status.candidates.map((candidate) => ({
          id: candidate.id,
          keyId: candidate.keyId,
          fingerprint: candidate.fingerprint,
          securityLevel: candidate.securityLevel,
          device: {
            installationId: candidate.installationId,
            model: candidate.model,
            osVersion: candidate.osVersion,
            playerVersion: candidate.playerVersion,
          },
          provedAt: candidate.provedAt,
        })),
      });
    },
  );
  app.post(
    "/screens/:id/device-reenrollment/:grantId/candidates/:candidateId/activate",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      requireCapability(request, CAPABILITIES.screenCredentialReenroll);
      const { id, grantId, candidateId } = activationParams.parse(
        request.params,
      );
      const result = await app.store.activateReenrollmentCandidateAndAudit(
        request.user.organizationId,
        id,
        grantId,
        candidateId,
        {
          actorUserId: request.user.sub,
          ipAddress: request.ip,
          requestId: request.id,
        },
      );
      if (!result.activated) {
        if (result.reason === "FORBIDDEN")
          throw new ApiError(
            403,
            "FORBIDDEN",
            "You do not have permission to perform this action",
          );
        if (result.reason === "STALE")
          throw new ApiError(
            409,
            "REENROLLMENT_STALE",
            "This re-enrollment can no longer be activated",
          );
        return sendNotFound(reply);
      }
      return reply.send({
        grantId,
        screenId: id,
        candidateId,
        credentialId: result.credential.id,
        keyId: result.credential.keyId,
        activatedAt: result.credential.createdAt,
        status: "activated",
      });
    },
  );
  app.delete(
    "/screens/:id/device-reenrollment/:grantId",
    async (request, reply) => {
      requireCapability(request, CAPABILITIES.screenCredentialReenroll);
      const { id, grantId } = reenrollmentParams.parse(request.params);
      const result = await app.store.cancelScreenReenrollmentAndAudit(
        request.user.organizationId,
        id,
        grantId,
        {
          actorUserId: request.user.sub,
          ipAddress: request.ip,
          requestId: request.id,
        },
      );
      if (!result.cancelled) {
        if (result.reason === "FORBIDDEN")
          throw new ApiError(
            403,
            "FORBIDDEN",
            "You do not have permission to perform this action",
          );
        return sendNotFound(reply);
      }
      return reply.code(204).send();
    },
  );
  app.delete("/screens/:id", async (request, reply) => {
    requireRole(request, ["OWNER", "ADMIN"]);
    const { id } = params.parse(request.params);
    const result = await app.store.deleteScreenAndAudit(
      request.user.organizationId,
      id,
      {
        actorUserId: request.user.sub,
        ipAddress: request.ip,
        requestId: request.id,
      },
    );
    if (result === "FORBIDDEN")
      throw new ApiError(
        403,
        "FORBIDDEN",
        "You do not have permission to perform this action",
      );
    if (result === "NOT_FOUND") return sendNotFound(reply);
    return reply.code(204).send();
  });
};
