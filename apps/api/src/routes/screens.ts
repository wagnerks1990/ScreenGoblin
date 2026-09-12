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
import { managementScreen } from "./management-dto.js";
import {
  enrollmentActivationDigest,
  enrollmentActivationKeyHash,
  enrollmentCode,
  enrollmentIdempotencyKeyHash,
  enrollmentRequestDigest,
} from "../device-enrollment/canonical.js";

const screen = z
  .object({
    name: z.string().trim().min(1).max(120),
    location: z.string().trim().max(240).default(""),
    locationId: opaqueId.nullable().optional(),
    orientation: z.enum(["landscape", "portrait"]).default("landscape"),
    resolution: z
      .string()
      .regex(/^\d{3,5}x\d{3,5}$/)
      .default("1920x1080"),
    tags: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
  })
  .strict();
const screenPatch = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    location: z.string().trim().max(240).optional(),
    locationId: opaqueId.nullable().optional(),
    orientation: z.enum(["landscape", "portrait"]).optional(),
    resolution: z
      .string()
      .regex(/^\d{3,5}x\d{3,5}$/)
      .optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  })
  .strict();
const params = z.object({ id: opaqueId });
const reenrollmentParams = z.object({ id: opaqueId, grantId: opaqueId });
const activationParams = reenrollmentParams.extend({ candidateId: opaqueId });
const idempotencyKey = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "Idempotency-Key must be a canonical UUIDv4",
  );
const reenrollmentRequest = z
  .object({ reason: z.string().trim().min(5).max(500) })
  .strict();
const enrollmentActivation = z
  .object({ fingerprint: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
export const screenRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", app.authenticate);
  app.get("/screens", async (request) => ({
    data: (await app.store.listScreens(request.user.organizationId)).map(
      managementScreen,
    ),
  }));
  app.get("/screens/:id", async (request, reply) => {
    const { id } = params.parse(request.params);
    const x = await app.store.getScreen(request.user.organizationId, id);
    return x ? managementScreen(x) : sendNotFound(reply);
  });
  app.post("/screens", async (request, reply) => {
    requireRole(request, ["OWNER", "ADMIN"]);
    const result = await app.store.createScreenAndAudit(
      request.user.organizationId,
      screen.parse(request.body),
      {
        actorUserId: request.user.sub,
        ipAddress: request.ip,
        requestId: request.id,
      },
    );
    if (!result.created && result.reason === "INVALID_LOCATION")
      throw new ApiError(
        422,
        "INVALID_LOCATION",
        "Location is not in this organization",
      );
    if (!result.created)
      throw new ApiError(
        403,
        "FORBIDDEN",
        "You do not have permission to perform this action",
      );
    return reply.code(201).send(managementScreen(result.value));
  });
  app.patch("/screens/:id", async (request, reply) => {
    requireRole(request, ["OWNER", "ADMIN"]);
    const { id } = params.parse(request.params);
    const parsed = screenPatch.parse(request.body);
    const changes = {
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.location !== undefined ? { location: parsed.location } : {}),
      ...(parsed.locationId !== undefined
        ? { locationId: parsed.locationId }
        : {}),
      ...(parsed.orientation !== undefined
        ? { orientation: parsed.orientation }
        : {}),
      ...(parsed.resolution !== undefined
        ? { resolution: parsed.resolution }
        : {}),
      ...(parsed.tags !== undefined ? { tags: parsed.tags } : {}),
    };
    const result = await app.store.updateScreenAndAudit(
      request.user.organizationId,
      id,
      changes,
      {
        actorUserId: request.user.sub,
        ipAddress: request.ip,
        requestId: request.id,
      },
    );
    if (!result.updated && result.reason === "FORBIDDEN")
      throw new ApiError(
        403,
        "FORBIDDEN",
        "You do not have permission to perform this action",
      );
    if (!result.updated && result.reason === "INVALID_LOCATION")
      throw new ApiError(
        422,
        "INVALID_LOCATION",
        "Location is not in this organization",
      );
    if (!result.updated) return sendNotFound(reply);
    return managementScreen(result.value);
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
    "/screens/:id/device-enrollment",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
          keyGenerator: (request) =>
            opaqueRateLimitKey(
              app.config.pairingCodePepper,
              "enrollment-create-source",
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
              "enrollment-create-org",
              request.user.organizationId,
            ),
            20,
          ),
          enforceRateLimitBudget(
            app.rateLimitBudget,
            opaqueRateLimitKey(
              app.config.pairingCodePepper,
              "enrollment-create-operator",
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
      const key = idempotencyKey.parse(request.headers["idempotency-key"]);
      const keyHash = enrollmentIdempotencyKeyHash(
        request.user.organizationId,
        key,
      );
      const codes = Array.from({ length: 8 }, (_, counter) => {
        const code = enrollmentCode(
          app.config.pairingCodePepper,
          request.user.organizationId,
          keyHash,
          counter,
        );
        return {
          counter,
          code,
          codeHash: pairingCodeHash(code, app.config.pairingCodePepper),
        };
      });
      const result = await app.store.requestScreenEnrollmentAndAudit(
        request.user.organizationId,
        id,
        new Date(Date.now() + 10 * 60_000).toISOString(),
        reason,
        {
          actorUserId: request.user.sub,
          ipAddress: request.ip,
          requestId: request.id,
        },
        {
          keyHash,
          requestDigestSha256: enrollmentRequestDigest(id, reason),
          codeCandidates: codes.map(({ counter, codeHash }) => ({
            counter,
            codeHash,
          })),
        },
      );
      if (!result.created) {
        if (result.reason === "FORBIDDEN")
          throw new ApiError(
            403,
            "FORBIDDEN",
            "You do not have permission to perform this action",
          );
        if (result.reason === "NOT_FOUND") return sendNotFound(reply);
        if (result.reason === "SCREEN_NOT_ELIGIBLE")
          throw new ApiError(
            409,
            "SCREEN_NOT_ELIGIBLE",
            "This screen must use credential re-enrollment",
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
        throw new ApiError(
          503,
          "PAIRING_CODE_SPACE_EXHAUSTED",
          "A pairing code could not be allocated; try again",
        );
      }
      const code = codes.find(
        ({ counter }) => counter === result.codeCounter,
      )?.code;
      if (!code) throw new Error("Enrollment code counter is invalid");
      return reply.code(201).send({
        grantId: result.pairing.id,
        screenId: id,
        code,
        expiresAt: result.pairing.expiresAt,
        generation: result.pairing.expectedGeneration,
      });
    },
  );
  app.get("/screens/:id/device-enrollment/:grantId", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    requireCapability(request, CAPABILITIES.screenCredentialReenroll);
    const { id, grantId } = reenrollmentParams.parse(request.params);
    const status = await app.store.getReenrollmentStatus(
      request.user.organizationId,
      id,
      grantId,
      request.user.sub,
      "NEW_SCREEN",
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
  });
  app.post(
    "/screens/:id/device-enrollment/:grantId/candidates/:candidateId/activate",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      requireCapability(request, CAPABILITIES.screenCredentialReenroll);
      const { id, grantId, candidateId } = activationParams.parse(
        request.params,
      );
      const { fingerprint } = enrollmentActivation.parse(request.body);
      const key = idempotencyKey.parse(request.headers["idempotency-key"]);
      const result = await app.store.activateScreenEnrollmentCandidateAndAudit(
        request.user.organizationId,
        id,
        grantId,
        candidateId,
        fingerprint,
        {
          actorUserId: request.user.sub,
          ipAddress: request.ip,
          requestId: request.id,
        },
        {
          keyHash: enrollmentActivationKeyHash(
            request.user.organizationId,
            key,
          ),
          requestDigestSha256: enrollmentActivationDigest(
            id,
            grantId,
            candidateId,
            fingerprint,
          ),
        },
      );
      if (!result.activated) {
        if (result.reason === "FORBIDDEN")
          throw new ApiError(
            403,
            "FORBIDDEN",
            "You do not have permission to perform this action",
          );
        if (result.reason === "NOT_FOUND") return sendNotFound(reply);
        if (
          result.reason === "IDEMPOTENCY_KEY_REUSED" ||
          result.reason === "IDEMPOTENCY_KEY_EXPIRED"
        )
          throw new ApiError(
            409,
            result.reason,
            "Enrollment activation could not be replayed",
          );
        throw new ApiError(
          409,
          "ENROLLMENT_STALE",
          "This enrollment can no longer be activated",
        );
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
    "/screens/:id/device-enrollment/:grantId",
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
        "NEW_SCREEN",
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
