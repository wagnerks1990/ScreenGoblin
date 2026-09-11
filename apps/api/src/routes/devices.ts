import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { createHash, randomInt } from "node:crypto";
import { ApiError, requireRole } from "../utils/http.js";
import { randomToken, sha256, signManifest } from "../utils/crypto.js";
import { opaqueId } from "../utils/validation.js";

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
    uptimeSeconds: z.number().int().nonnegative(),
    freeStorageBytes: z.number().int().nonnegative(),
    networkType: z.string().min(1).max(40),
    occurredAt: z.iso.datetime(),
  })
  .strict();
const weight = { normal: 0, campaign: 1, priority: 2, emergency: 3 };

export const pairingAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", app.authenticate);
  app.post("/pairing-codes", async (request, reply) => {
    requireRole(request, ["OWNER", "ADMIN"]);
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    await app.store.createPairing(
      request.user.organizationId,
      sha256(code),
      expiresAt,
    );
    return reply.code(201).send({ code, expiresAt });
  });
};

export const deviceRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/pair",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = claim.parse(request.body);
      const token = randomToken();
      const screen = await app.store.claimPairing(
        sha256(input.code),
        input.device,
        sha256(token),
      );
      if (!screen)
        throw new ApiError(
          404,
          "PAIRING_CODE_INVALID",
          "Pairing code is invalid or expired",
        );
      await app.store.audit({
        organizationId: screen.organizationId,
        actorType: "device",
        action: "device.paired",
        entityType: "screen",
        entityId: screen.id,
        ipAddress: request.ip,
        requestId: request.id,
        metadata: { installationId: input.device.installationId },
      });
      return reply.code(201).send({
        screenId: screen.id,
        deviceToken: token,
        apiBaseUrl: `${request.protocol}://${request.host}/api/v1/device`,
        heartbeatIntervalSeconds: 60,
      });
    },
  );
  app.post(
    "/heartbeat",
    { onRequest: [app.authenticateDevice] },
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
    { onRequest: [app.authenticateDevice] },
    async (request) => {
      const screen = request.device!;
      const generatedAt = new Date().toISOString();
      const emergency = app.config.emergencyPublishingEnabled
        ? await app.store.activeEmergency(
            screen.organizationId,
            screen.id,
            generatedAt,
          )
        : null;
      let priority: "normal" | "campaign" | "priority" | "emergency" = "normal";
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
                (new Date(emergency.expiresAt).getTime() - Date.now()) / 1000,
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
        ).sort((a, b) => weight[b.priority] - weight[a.priority]);
        const selected = schedules[0];
        if (selected) {
          priority = selected.priority;
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
                } => Boolean(x.asset),
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
        }
      }
      const version = sha256(
        JSON.stringify({ screenId: screen.id, priority, items }),
      );
      const unsigned = {
        version,
        generatedAt,
        validUntil:
          emergency?.expiresAt ??
          new Date(Date.now() + 5 * 60_000).toISOString(),
        screenId: screen.id,
        priority,
        items,
      };
      return {
        ...unsigned,
        signature: signManifest(unsigned, app.config.manifestSigningSecret),
      };
    },
  );
};
