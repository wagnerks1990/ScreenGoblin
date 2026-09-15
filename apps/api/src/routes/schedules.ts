import type { FastifyPluginAsync } from "fastify";
import { CAPABILITIES } from "@screengoblin/contracts";
import { z } from "zod";
import { ApiError, requireCapability, sendNotFound } from "../utils/http.js";
import { opaqueId } from "../utils/validation.js";
import { validTimeZone } from "../utils/schedule.js";
import {
  canonicalUtcInstant,
  releaseCandidateCommandDigest,
  releaseCandidateCreateCommandDigest,
  releaseCandidateKeyHash,
} from "../releases/canonical.js";
import {
  managementReleaseCandidate,
  managementSchedule,
} from "./management-dto.js";
const absoluteInstant = z.iso.datetime().transform(canonicalUtcInstant);
const scheduleShape = {
  playlistId: opaqueId,
  name: z.string().trim().min(1).max(140),
  priority: z.enum(["normal", "campaign", "priority"]).default("normal"),
  startsAt: absoluteInstant,
  endsAt: absoluteInstant.optional(),
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
} as const;
const candidateBody = z
  .object({ ...scheduleShape, expiresAt: absoluteInstant })
  .strict()
  .refine((v) => !v.endsAt || Date.parse(v.endsAt) > Date.parse(v.startsAt), {
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
  )
  .refine(
    (v) =>
      Date.parse(v.expiresAt) > Date.now() &&
      Date.parse(v.expiresAt) <= Date.now() + 7 * 24 * 60 * 60 * 1_000,
    {
      message: "expiresAt must be in the future and no more than 7 days away",
      path: ["expiresAt"],
    },
  );
const params = z.object({ id: opaqueId });
const transitionBody = z
  .object({ digestSha256: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();
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
    return reply.code(410).send({
      error: {
        code: "DIRECT_PUBLICATION_DISABLED",
        message: "Create, submit, approve, and publish a release candidate",
      },
    });
  });
  app.get("/release-candidates", async (request) => ({
    data: (
      await app.store.listReleaseCandidates(request.user.organizationId)
    ).map(managementReleaseCandidate),
  }));
  app.get("/release-candidates/:id", async (request, reply) => {
    const { id } = params.parse(request.params);
    const candidate = await app.store.getReleaseCandidate(
      request.user.organizationId,
      id,
    );
    return candidate
      ? managementReleaseCandidate(candidate)
      : sendNotFound(reply);
  });
  const audit = (request: Parameters<typeof requireCapability>[0]) => ({
    actorUserId: request.user.sub,
    ipAddress: request.ip,
    requestId: request.id,
  });
  const sendCandidateResult = (
    result: Awaited<
      ReturnType<typeof app.store.createReleaseCandidateAndAudit>
    >,
    reply: Parameters<typeof sendNotFound>[0],
    created = false,
  ) => {
    if (result.completed)
      return reply
        .code(created && !result.replayed ? 201 : 200)
        .send(managementReleaseCandidate(result.candidate));
    if (result.reason === "NOT_FOUND") return sendNotFound(reply);
    if (result.reason === "FORBIDDEN")
      throw new ApiError(403, "FORBIDDEN", "Permission denied");
    if (
      result.reason === "IDEMPOTENCY_KEY_REUSED" ||
      result.reason === "IDEMPOTENCY_KEY_EXPIRED"
    )
      throw new ApiError(409, result.reason, "Idempotency replay rejected");
    const status =
      result.reason === "AUTHOR_CANNOT_APPROVE" ||
      result.reason === "INVALID_STATE" ||
      result.reason === "STALE_DIGEST" ||
      result.reason === "APPROVAL_STALE" ||
      result.reason === "EXPIRED"
        ? 409
        : 422;
    throw new ApiError(status, result.reason, "Release candidate rejected");
  };
  app.post("/release-candidates", async (request, reply) => {
    requireCapability(request, CAPABILITIES.releaseCandidateCreate);
    const input = candidateBody.parse(request.body);
    const key = idempotencyKey.parse(request.headers["idempotency-key"]);
    const result = await app.store.createReleaseCandidateAndAudit(
      request.user.organizationId,
      input,
      audit(request),
      { mediaAllowedOrigins: app.config.mediaAllowedOrigins },
      {
        keyHash: releaseCandidateKeyHash(
          request.user.organizationId,
          "create",
          key,
        ),
        requestDigestSha256: releaseCandidateCreateCommandDigest(input),
      },
    );
    return sendCandidateResult(result, reply, true);
  });
  for (const operation of ["submit", "approve", "publish"] as const) {
    app.post(`/release-candidates/:id/${operation}`, async (request, reply) => {
      requireCapability(
        request,
        operation === "submit"
          ? CAPABILITIES.releaseCandidateSubmit
          : operation === "approve"
            ? CAPABILITIES.releaseApprove
            : CAPABILITIES.releasePublish,
      );
      const { id } = params.parse(request.params);
      const { digestSha256 } = transitionBody.parse(request.body);
      const key = idempotencyKey.parse(request.headers["idempotency-key"]);
      const idempotency = {
        keyHash: releaseCandidateKeyHash(
          request.user.organizationId,
          operation,
          key,
        ),
        requestDigestSha256: releaseCandidateCommandDigest(
          operation,
          id,
          digestSha256,
        ),
      };
      const result =
        operation === "submit"
          ? await app.store.submitReleaseCandidateAndAudit(
              request.user.organizationId,
              id,
              digestSha256,
              audit(request),
              idempotency,
            )
          : operation === "approve"
            ? await app.store.approveReleaseCandidateAndAudit(
                request.user.organizationId,
                id,
                digestSha256,
                audit(request),
                idempotency,
              )
            : await app.store.publishReleaseCandidateAndAudit(
                request.user.organizationId,
                id,
                digestSha256,
                audit(request),
                { mediaAllowedOrigins: app.config.mediaAllowedOrigins },
                idempotency,
              );
      return sendCandidateResult(result, reply);
    });
  }
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
