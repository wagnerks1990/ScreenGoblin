import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { createHash, randomInt } from "node:crypto";
import { ApiError, requireRole } from "../utils/http.js";
import {
  manifestVerificationKey,
  pairingCodeHash,
  randomToken,
  sha256,
  signManifest,
} from "../utils/crypto.js";
import { opaqueId } from "../utils/validation.js";
import { compareSchedulePrecedence } from "../utils/schedule.js";
import {
  enforceRateLimitBudget,
  opaqueRateLimitKey,
} from "../utils/rate-limit.js";
import type { ScheduleRecord } from "../domain/types.js";

const MANIFEST_LEASE_MS = 5 * 60_000;

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

const zonedParts = (instant: Date, timeZone: string): ZonedParts => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const numberPart = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  return {
    year: numberPart("year"),
    month: numberPart("month"),
    day: numberPart("day"),
    hour: numberPart("hour"),
    minute: numberPart("minute"),
  };
};

/** Resolve a wall-clock time in an IANA zone without assuming a fixed UTC offset. */
const zonedInstant = (parts: ZonedParts, timeZone: string): Date => {
  const desired = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
  );
  let candidate = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(new Date(candidate), timeZone);
    const represented = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
    );
    const correction = desired - represented;
    if (correction === 0) break;
    candidate += correction;
  }
  return new Date(candidate);
};

const selectedSchedulePlaybackEndsAt = (
  schedule: ScheduleRecord,
  generatedAt: Date,
): string | undefined => {
  const candidates: number[] = [];
  if (schedule.endsAt) candidates.push(Date.parse(schedule.endsAt));
  if (schedule.dailyEndMinutes !== undefined) {
    const local = zonedParts(generatedAt, schedule.timezone);
    const dailyBoundary = zonedInstant(
      {
        ...local,
        hour: Math.floor(schedule.dailyEndMinutes / 60),
        minute: schedule.dailyEndMinutes % 60,
      },
      schedule.timezone,
    ).getTime();
    if (dailyBoundary > generatedAt.getTime()) candidates.push(dailyBoundary);
  }
  return candidates.length
    ? new Date(Math.min(...candidates)).toISOString()
    : undefined;
};

const claim = z
  .object({
    code: z.string().regex(/^\d{6}$/),
    device: z
      .object({
        installationId: z.string().min(8).max(200),
        model: z.string().min(1).max(120),
        osVersion: z.string().min(1).max(80),
        playerVersion: z.string().min(1).max(80),
      })
      .strict(),
  })
  .strict();
const heartbeat = z
  .object({
    installationId: z.string().min(8).max(200),
    playerVersion: z.string().min(1).max(80),
    manifestVersion: z.string().max(128).optional(),
    nowPlayingAssetId: opaqueId.optional(),
    uptimeSeconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    freeStorageBytes: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    networkType: z.string().min(1).max(40),
    occurredAt: z.iso.datetime(),
  })
  .strict();

export const pairingAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", app.authenticate);
  app.post(
    "/pairing-codes",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
          keyGenerator: (request) =>
            opaqueRateLimitKey(
              app.config.pairingCodePepper,
              "pairing-create-source",
              request.ip,
            ),
        },
      },
      preHandler: async (request) => {
        requireRole(request, ["OWNER", "ADMIN"]);
        await Promise.all([
          enforceRateLimitBudget(
            app.rateLimitBudget,
            opaqueRateLimitKey(
              app.config.pairingCodePepper,
              "pairing-create-org",
              request.user.organizationId,
            ),
            20,
          ),
          enforceRateLimitBudget(
            app.rateLimitBudget,
            opaqueRateLimitKey(
              app.config.pairingCodePepper,
              "pairing-create-operator",
              request.user.sub,
            ),
            10,
          ),
        ]);
      },
    },
    async (request, reply) => {
      const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      let code: string | undefined;
      let pairingId: string | undefined;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = randomInt(0, 1_000_000).toString().padStart(6, "0");
        const result = await app.store.tryCreatePairingAndAudit(
          request.user.organizationId,
          pairingCodeHash(candidate, app.config.pairingCodePepper),
          expiresAt,
          {
            actorUserId: request.user.sub,
            ipAddress: request.ip,
            requestId: request.id,
          },
        );
        if (result.created) {
          code = candidate;
          pairingId = result.pairing.id;
          break;
        }
      }
      if (!code || !pairingId)
        throw new ApiError(
          503,
          "PAIRING_CODE_SPACE_EXHAUSTED",
          "A pairing code could not be allocated; try again",
        );
      return reply.code(201).send({ code, expiresAt });
    },
  );
};

export const deviceRoutes: FastifyPluginAsync = async (app) => {
  const sourceBudget =
    (dimension: string, maximum: number) =>
    async (request: Parameters<typeof app.authenticateDevice>[0]) =>
      enforceRateLimitBudget(
        app.rateLimitBudget,
        opaqueRateLimitKey(app.config.pairingCodePepper, dimension, request.ip),
        maximum,
      );

  app.post(
    "/pair",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
          keyGenerator: (request) =>
            opaqueRateLimitKey(
              app.config.pairingCodePepper,
              "pair-source",
              request.ip,
            ),
        },
      },
      preHandler: async (request) => {
        const code =
          typeof request.body === "object" &&
          request.body !== null &&
          "code" in request.body &&
          typeof request.body.code === "string"
            ? request.body.code
            : "invalid";
        await enforceRateLimitBudget(
          app.rateLimitBudget,
          opaqueRateLimitKey(app.config.pairingCodePepper, "pair-code", code),
          5,
        );
      },
    },
    async (request, reply) => {
      const input = claim.parse(request.body);
      const token = randomToken();
      const screen = await app.store.claimPairingAndAudit(
        pairingCodeHash(input.code, app.config.pairingCodePepper),
        input.device,
        sha256(token),
        { ipAddress: request.ip, requestId: request.id },
      );
      if (!screen)
        throw new ApiError(
          404,
          "PAIRING_CODE_INVALID",
          "Pairing code is invalid or expired",
        );
      return reply.code(201).send({
        screenId: screen.id,
        deviceToken: token,
        apiBaseUrl: `${(
          app.config.publicApiUrl ?? `${request.protocol}://${request.host}`
        ).replace(/\/+$/, "")}/api/v1/device`,
        heartbeatIntervalSeconds: 60,
        manifestVerificationKey: manifestVerificationKey(
          app.config.manifestSigningPrivateKey,
        ),
      });
    },
  );
  app.post(
    "/heartbeat",
    {
      onRequest: [sourceBudget("heartbeat-source", 60), app.authenticateDevice],
      config: { rateLimit: false },
      preHandler: async (request) =>
        enforceRateLimitBudget(
          app.rateLimitBudget,
          opaqueRateLimitKey(
            app.config.pairingCodePepper,
            "heartbeat-device",
            request.device!.id,
          ),
          30,
        ),
    },
    async (request) => {
      const input = heartbeat.parse(request.body);
      if (input.installationId !== request.device?.installationId)
        throw new ApiError(
          409,
          "INSTALLATION_MISMATCH",
          "Installation identity does not match paired device",
        );
      await app.store.heartbeat(request.device.id, input);
      return {
        accepted: true,
        serverTime: new Date().toISOString(),
        nextHeartbeatSeconds: 60,
      };
    },
  );
  app.get(
    "/manifest",
    {
      onRequest: [sourceBudget("manifest-source", 120), app.authenticateDevice],
      config: { rateLimit: false },
      preHandler: async (request) =>
        enforceRateLimitBudget(
          app.rateLimitBudget,
          opaqueRateLimitKey(
            app.config.pairingCodePepper,
            "manifest-device",
            request.device!.id,
          ),
          60,
        ),
    },
    async (request) => {
      const screen = request.device!;
      const generatedDate = new Date();
      const generatedAt = generatedDate.toISOString();
      const emergency = app.config.emergencyPublishingEnabled
        ? await app.store.activeEmergency(
            screen.organizationId,
            screen.id,
            generatedAt,
          )
        : null;
      let priority: "normal" | "campaign" | "priority" | "emergency" = "normal";
      let releaseIdentity = "no-schedule";
      let withdrawn = true;
      let playbackEndsAt: string | undefined;
      let validUntil = new Date(
        generatedDate.getTime() + MANIFEST_LEASE_MS,
      ).toISOString();
      let items: Array<{
        id: string;
        asset: {
          id: string;
          name: string;
          kind: "image" | "video" | "web" | "template";
          mimeType: string;
          url: string;
          checksumSha256: string;
          sizeBytes: number;
          createdAt: string;
        };
        position: number;
        durationSeconds: number;
      }> = [];
      if (emergency) {
        priority = "emergency";
        withdrawn = false;
        releaseIdentity = `emergency:${emergency.id}:${emergency.expiresAt}`;
        validUntil = emergency.expiresAt;
        const raw = JSON.stringify({
          title: emergency.title,
          message: emergency.message,
          backgroundColor: emergency.backgroundColor,
        });
        items = [
          {
            id: `emergency-${emergency.id}`,
            asset: {
              id: emergency.id,
              name: emergency.title,
              kind: "template",
              mimeType: "application/vnd.screengoblin.emergency+json",
              url: `data:application/json;base64,${Buffer.from(raw).toString("base64")}`,
              checksumSha256: createHash("sha256").update(raw).digest("hex"),
              sizeBytes: Buffer.byteLength(raw),
              createdAt: emergency.createdAt,
            },
            position: 0,
            durationSeconds: Math.max(
              1,
              Math.ceil(
                (new Date(emergency.expiresAt).getTime() -
                  new Date(emergency.startsAt).getTime()) /
                  1000,
              ),
            ),
          },
        ];
      } else {
        const schedules = (
          await app.store.activeSchedules(
            screen.organizationId,
            screen.id,
            generatedAt,
          )
        ).sort(compareSchedulePrecedence);
        const selected = schedules[0];
        if (selected) {
          const playlist = await app.store.getPlaylist(
            screen.organizationId,
            selected.playlistId,
          );
          if (playlist) {
            const resolved = await Promise.all(
              playlist.items
                .sort((a, b) => a.position - b.position)
                .map(async (item) => ({
                  item,
                  asset: await app.store.getMedia(
                    screen.organizationId,
                    item.assetId,
                  ),
                })),
            );
            items = resolved
              .filter(
                (
                  x,
                ): x is {
                  item: (typeof playlist.items)[number];
                  asset: NonNullable<typeof x.asset>;
                } =>
                  Boolean(x.asset) &&
                  (!x.asset?.expiresAt || x.asset.expiresAt > generatedAt),
              )
              .map(({ item, asset }) => ({
                id: item.id,
                asset: {
                  id: asset.id,
                  name: asset.name,
                  kind: asset.kind,
                  mimeType: asset.mimeType,
                  url: asset.url,
                  checksumSha256: asset.checksumSha256,
                  sizeBytes: asset.sizeBytes,
                  createdAt: asset.createdAt,
                },
                position: item.position,
                durationSeconds: item.durationSeconds,
              }));
          }
          // An applicable schedule without a playable item must clear playback.
          // Publishing an empty non-withdrawn release would be rejected by the
          // player and could leave stale content on screen indefinitely.
          if (items.length > 0) {
            priority = selected.priority;
            withdrawn = false;
            releaseIdentity = `schedule:${selected.id}:${selected.updatedAt}`;
            playbackEndsAt = selectedSchedulePlaybackEndsAt(
              selected,
              generatedDate,
            );
          }
        }
      }
      const version = sha256(
        JSON.stringify({
          screenId: screen.id,
          releaseIdentity,
          priority,
          withdrawn,
          playbackEndsAt,
          items,
        }),
      );
      const unsigned = {
        version,
        generatedAt,
        validUntil,
        screenId: screen.id,
        priority,
        withdrawn,
        ...(playbackEndsAt ? { playbackEndsAt } : {}),
        items,
      };
      return {
        ...unsigned,
        signatureAlgorithm: "Ed25519",
        signature: signManifest(unsigned, app.config.manifestSigningPrivateKey),
      };
    },
  );
};
