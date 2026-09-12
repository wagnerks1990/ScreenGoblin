import type { FastifyPluginAsync, FastifyRequest } from "fastify";
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
import {
  compareSchedulePrecedence,
  schedulePlaybackEndsAt,
} from "../utils/schedule.js";
import {
  enforceRateLimitBudget,
  opaqueRateLimitKey,
} from "../utils/rate-limit.js";
import {
  hasMediaUrlCredentials,
  mediaUrlMatchesAllowedOrigin,
  usesAllowedMediaScheme,
} from "../utils/media-url.js";
import { mediaPublicationFailure } from "../utils/media-policy.js";
import {
  decodeCanonicalBase64Url,
  DeviceProofFormatError,
  randomChallenge,
  sha256Hex,
  validateP256Identity,
  verifyDeviceSignature,
} from "../device-proof/crypto.js";
import {
  canonicalHeartbeatDigest,
  canonicalPairingDigest,
  EMPTY_BODY_SHA256,
} from "../device-proof/canonical.js";

const MANIFEST_LEASE_MS = 5 * 60_000;

const device = z
  .object({
    installationId: z.string().min(8).max(200),
    model: z.string().min(1).max(120),
    osVersion: z.string().min(1).max(80),
    playerVersion: z.string().min(1).max(80),
  })
  .strict();
const claim = z
  .object({
    code: z.string().regex(/^\d{6}$/),
    device,
  })
  .strict();
const keyId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const encodedChallenge = z.string().regex(/^[A-Za-z0-9_-]{22,683}$/);
const identity = z
  .object({
    algorithm: z.literal("ES256"),
    publicKeySpki: z.string().regex(/^[A-Za-z0-9_-]{107,342}$/),
    keyId,
    securityLevel: z.enum([
      "strongbox",
      "trusted-environment",
      "software",
      "unknown-secure",
      "unknown",
    ]),
  })
  .strict();
const pairingChallenge = claim.extend({ identity }).strict();
const pairingProof = z
  .object({
    challengeId: z.string().min(1).max(200),
    challenge: encodedChallenge,
    keyId,
    signatureFormat: z.literal("ES256-DER"),
    signature: z.string().regex(/^[A-Za-z0-9_-]{11,107}$/),
  })
  .strict();
const proofClaim = pairingChallenge.extend({ pairingProof }).strict();
const deviceChallenge = z
  .object({
    operation: z.enum(["heartbeat", "manifest"]),
    bodySha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
const proofHeaders = z
  .object({
    "x-screen-id": z.string().min(1).max(200),
    "x-device-key-id": keyId,
    "x-device-challenge-id": z.string().min(1).max(200),
    "x-device-challenge": encodedChallenge,
    "x-device-signature-format": z.literal("ES256-DER"),
    "x-device-signature": z.string().regex(/^[A-Za-z0-9_-]{11,107}$/),
  })
  .passthrough();
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
        if (!result.created && result.reason === "FORBIDDEN")
          throw new ApiError(
            403,
            "FORBIDDEN",
            "You do not have permission to perform this action",
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
    (dimension: string, maximum: number) => async (request: FastifyRequest) =>
      enforceRateLimitBudget(
        app.rateLimitBudget,
        opaqueRateLimitKey(app.config.pairingCodePepper, dimension, request.ip),
        maximum,
      );

  const invalidDeviceProof = () =>
    new ApiError(
      401,
      "DEVICE_UNAUTHORIZED",
      "Device credentials are invalid or revoked",
    );
  const apiBaseUrl = (request: FastifyRequest) =>
    `${(
      app.config.publicApiUrl ?? `${request.protocol}://${request.host}`
    ).replace(/\/+$/, "")}/api/v1/device`;
  const proofIdentity = (input: z.infer<typeof pairingChallenge>) => {
    if (input.device.installationId !== input.identity.keyId)
      throw new DeviceProofFormatError("Installation identity is invalid");
    return validateP256Identity(input.identity).enrollment;
  };
  const readDeviceProof = async (request: FastifyRequest) => {
    const parsed = proofHeaders.safeParse(request.headers);
    if (!parsed.success) throw invalidDeviceProof();
    try {
      decodeCanonicalBase64Url(parsed.data["x-device-challenge"], 16, 512);
      decodeCanonicalBase64Url(parsed.data["x-device-signature"], 8, 80);
    } catch {
      throw invalidDeviceProof();
    }
    const authenticated = await app.store.authenticateDeviceCredential(
      parsed.data["x-screen-id"],
      parsed.data["x-device-key-id"],
    );
    if (!authenticated.authenticated) throw invalidDeviceProof();
    return { headers: parsed.data, authenticated };
  };
  const deviceProofBudget =
    (dimension: string, maximum: number) =>
    async (
      request: FastifyRequest,
      reply: Parameters<typeof app.authenticateDevice>[1],
    ) => {
      if (app.config.deviceAuthMode === "development-bearer") {
        await app.authenticateDevice(request, reply);
        return enforceRateLimitBudget(
          app.rateLimitBudget,
          opaqueRateLimitKey(
            app.config.pairingCodePepper,
            dimension,
            request.device!.id,
          ),
          maximum,
        );
      }
      const screenId = request.headers["x-screen-id"];
      const deviceKeyId = request.headers["x-device-key-id"];
      return enforceRateLimitBudget(
        app.rateLimitBudget,
        opaqueRateLimitKey(
          app.config.pairingCodePepper,
          dimension,
          `${typeof screenId === "string" ? screenId : "invalid"}:${
            typeof deviceKeyId === "string" ? deviceKeyId : "invalid"
          }`,
        ),
        maximum,
      );
    };

  app.post(
    "/pair/challenge",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
          keyGenerator: (request) =>
            opaqueRateLimitKey(
              app.config.pairingCodePepper,
              "pair-challenge-source",
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
          opaqueRateLimitKey(
            app.config.pairingCodePepper,
            "pair-challenge-code",
            code,
          ),
          8,
        );
      },
    },
    async (request, reply) => {
      const input = pairingChallenge.parse(request.body);
      let enrollment;
      try {
        enrollment = proofIdentity(input);
      } catch (error) {
        if (error instanceof DeviceProofFormatError)
          throw new ApiError(
            422,
            "INVALID_DEVICE_IDENTITY",
            "Device identity is invalid",
          );
        throw error;
      }
      const challenge = randomChallenge();
      // Keep 15 seconds of tolerance below the database's hard 45-second cap
      // so small API/database clock skew cannot turn valid attempts into dummies.
      const expiresAt = new Date(Date.now() + 30_000).toISOString();
      const attempt = await app.store.issuePairingChallenge({
        codeHash: pairingCodeHash(input.code, app.config.pairingCodePepper),
        credential: enrollment,
        challengeHashSha256: sha256Hex(
          decodeCanonicalBase64Url(challenge, 32, 32),
        ),
        transcriptDigestSha256: canonicalPairingDigest(
          input,
          app.config.pairingCodePepper,
        ),
        expiresAt,
      });
      return reply.code(201).send({
        id: attempt?.id ?? randomToken(),
        challenge,
        expiresAt,
      });
    },
  );

  app.post(
    "/challenges",
    {
      onRequest: [sourceBudget("device-challenge-source", 120)],
      config: { rateLimit: false },
      preHandler: async (request) => {
        const screenId = request.headers["x-screen-id"];
        const deviceKeyId = request.headers["x-device-key-id"];
        await enforceRateLimitBudget(
          app.rateLimitBudget,
          opaqueRateLimitKey(
            app.config.pairingCodePepper,
            "device-challenge-key",
            `${typeof screenId === "string" ? screenId : "invalid"}:${
              typeof deviceKeyId === "string" ? deviceKeyId : "invalid"
            }`,
          ),
          30,
        );
      },
    },
    async (request, reply) => {
      const headers = z
        .object({
          "x-screen-id": z.string().min(1).max(200),
          "x-device-key-id": keyId,
        })
        .passthrough()
        .parse(request.headers);
      const input = deviceChallenge.parse(request.body);
      if (
        input.operation === "manifest" &&
        input.bodySha256 !== EMPTY_BODY_SHA256
      )
        throw new ApiError(
          422,
          "INVALID_BODY_DIGEST",
          "Manifest challenges require the empty-body digest",
        );
      const challenge = randomChallenge();
      const expiresAt = new Date(Date.now() + 45_000).toISOString();
      const issued = await app.store.issueDeviceAuthChallenge({
        screenId: headers["x-screen-id"],
        keyId: headers["x-device-key-id"],
        challengeHashSha256: sha256Hex(
          decodeCanonicalBase64Url(challenge, 32, 32),
        ),
        operation: input.operation,
        requestDigestSha256: input.bodySha256,
        expiresAt,
      });
      return reply.code(201).send({
        id: issued?.id ?? randomToken(),
        challenge,
        expiresAt,
      });
    },
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
          // A pending re-enrollment polls the same signature-bound proof about
          // four times/minute; leave room for the first request and jitter.
          8,
        );
      },
    },
    async (request, reply) => {
      if (app.config.deviceAuthMode === "proof-v1") {
        const input = proofClaim.parse(request.body);
        let enrollment;
        try {
          enrollment = proofIdentity(input);
          decodeCanonicalBase64Url(input.pairingProof.challenge, 16, 512);
        } catch (error) {
          if (error instanceof DeviceProofFormatError)
            throw new ApiError(
              422,
              "INVALID_DEVICE_IDENTITY",
              "Device identity or proof is invalid",
            );
          throw error;
        }
        if (input.pairingProof.keyId !== enrollment.keyId)
          throw new ApiError(
            404,
            "PAIRING_CODE_INVALID",
            "Pairing code is invalid or expired",
          );
        const paired = await app.store.claimPairingWithCredentialAndAudit(
          {
            codeHash: pairingCodeHash(input.code, app.config.pairingCodePepper),
            pairingAttemptId: input.pairingProof.challengeId,
            challengeHashSha256: sha256Hex(
              decodeCanonicalBase64Url(input.pairingProof.challenge, 16, 512),
            ),
            transcriptDigestSha256: canonicalPairingDigest(
              {
                code: input.code,
                device: input.device,
                identity: input.identity,
              },
              app.config.pairingCodePepper,
            ),
            keyId: input.pairingProof.keyId,
            device: input.device,
          },
          (credential) =>
            verifyDeviceSignature(
              credential,
              input.pairingProof.challenge,
              input.pairingProof.signature,
            ),
          { ipAddress: request.ip, requestId: request.id },
        );
        if (!paired.paired && paired.reason === "PENDING_APPROVAL")
          return reply.code(202).send({
            status: "pending-approval",
            grantId: paired.grantId,
            candidateId: paired.candidateId,
            keyId: paired.keyId,
            fingerprint: paired.keyId,
            expiresAt: paired.expiresAt,
          });
        if (!paired.paired)
          throw new ApiError(
            404,
            "PAIRING_CODE_INVALID",
            "Pairing code is invalid or expired",
          );
        return reply.code(201).send({
          authMode: "proof-v1",
          screenId: paired.screen.id,
          credentialId: paired.credential.id,
          keyId: paired.credential.keyId,
          apiBaseUrl: apiBaseUrl(request),
          heartbeatIntervalSeconds: 60,
          manifestVerificationKey: manifestVerificationKey(
            app.config.manifestSigningPrivateKey,
          ),
        });
      }
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
        apiBaseUrl: apiBaseUrl(request),
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
      onRequest: [sourceBudget("heartbeat-source", 60)],
      config: { rateLimit: false },
      preHandler: deviceProofBudget("heartbeat-device", 30),
    },
    async (request) => {
      const input = heartbeat.parse(request.body);
      if (app.config.deviceAuthMode === "proof-v1") {
        const proof = await readDeviceProof(request);
        if (input.installationId !== proof.authenticated.screen.installationId)
          throw new ApiError(
            409,
            "INSTALLATION_MISMATCH",
            "Installation identity does not match paired device",
          );
        const proofInput = {
          credentialId: proof.authenticated.credential.id,
          challengeId: proof.headers["x-device-challenge-id"],
          challengeHashSha256: sha256Hex(
            decodeCanonicalBase64Url(
              proof.headers["x-device-challenge"],
              16,
              512,
            ),
          ),
          operation: "heartbeat" as const,
          requestDigestSha256: canonicalHeartbeatDigest({
            installationId: input.installationId,
            playerVersion: input.playerVersion,
            ...(input.manifestVersion !== undefined
              ? { manifestVersion: input.manifestVersion }
              : {}),
            ...(input.nowPlayingAssetId !== undefined
              ? { nowPlayingAssetId: input.nowPlayingAssetId }
              : {}),
            uptimeSeconds: input.uptimeSeconds,
            freeStorageBytes: input.freeStorageBytes,
            networkType: input.networkType,
            occurredAt: input.occurredAt,
          }),
        };
        const result = await app.store.heartbeatWithDeviceProof(
          proofInput,
          {
            playerVersion: input.playerVersion,
            ...(input.manifestVersion !== undefined
              ? { manifestVersion: input.manifestVersion }
              : {}),
            ...(input.nowPlayingAssetId !== undefined
              ? { nowPlayingAssetId: input.nowPlayingAssetId }
              : {}),
            uptimeSeconds: input.uptimeSeconds,
            freeStorageBytes: input.freeStorageBytes,
            networkType: input.networkType,
          },
          (credential) =>
            verifyDeviceSignature(
              credential,
              proof.headers["x-device-challenge"],
              proof.headers["x-device-signature"],
            ),
        );
        if (!result.authenticated) throw invalidDeviceProof();
        return {
          accepted: true,
          serverTime: new Date().toISOString(),
          nextHeartbeatSeconds: 60,
        };
      }
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
      onRequest: [sourceBudget("manifest-source", 120)],
      config: { rateLimit: false },
      preHandler: deviceProofBudget("manifest-device", 60),
    },
    async (request) => {
      let screen = request.device!;
      if (app.config.deviceAuthMode === "proof-v1") {
        if (request.url.includes("?")) throw invalidDeviceProof();
        const proof = await readDeviceProof(request);
        const consumed = await app.store.consumeDeviceAuthChallenge(
          {
            credentialId: proof.authenticated.credential.id,
            challengeId: proof.headers["x-device-challenge-id"],
            challengeHashSha256: sha256Hex(
              decodeCanonicalBase64Url(
                proof.headers["x-device-challenge"],
                16,
                512,
              ),
            ),
            operation: "manifest",
            requestDigestSha256: EMPTY_BODY_SHA256,
          },
          (credential) =>
            verifyDeviceSignature(
              credential,
              proof.headers["x-device-challenge"],
              proof.headers["x-device-signature"],
            ),
        );
        if (!consumed.authenticated) throw invalidDeviceProof();
        screen = consumed.screen;
      }
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
          expiresAt?: string;
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
        const releases = (
          await app.store.activeOrdinaryReleases(
            screen.organizationId,
            screen.id,
            generatedAt,
          )
        ).sort((left, right) =>
          compareSchedulePrecedence(
            { id: left.assignment.id, ...left.assignment.schedule },
            { id: right.assignment.id, ...right.assignment.schedule },
          ),
        );
        const selected = releases[0];
        if (selected) {
          const releaseAssets = selected.release.items.map(
            (item) => item.asset,
          );
          const everyUrlAllowed = selected.release.items.every((item) => {
            try {
              const url = new URL(item.asset.url);
              return (
                !hasMediaUrlCredentials(url) &&
                usesAllowedMediaScheme(url) &&
                mediaUrlMatchesAllowedOrigin(
                  item.asset.url,
                  app.config.mediaAllowedOrigins,
                )
              );
            } catch {
              return false;
            }
          });
          const entireReleasePlayable =
            selected.release.items.length > 0 &&
            everyUrlAllowed &&
            mediaPublicationFailure(releaseAssets, generatedDate) === undefined;
          items = entireReleasePlayable
            ? selected.release.items.map((item) => ({
                id: item.id,
                asset: {
                  id: item.asset.id,
                  name: item.asset.name,
                  kind: item.asset.kind,
                  mimeType: item.asset.mimeType,
                  url: item.asset.url,
                  checksumSha256: item.asset.checksumSha256,
                  sizeBytes: item.asset.sizeBytes,
                  createdAt: item.asset.createdAt,
                  ...(item.asset.expiresAt
                    ? { expiresAt: item.asset.expiresAt }
                    : {}),
                },
                position: item.position,
                durationSeconds: item.durationSeconds,
              }))
            : [];
          // An applicable schedule without a playable item must clear playback.
          // Publishing an empty non-withdrawn release would be rejected by the
          // player and could leave stale content on screen indefinitely.
          if (items.length > 0) {
            priority = selected.assignment.schedule.priority;
            withdrawn = false;
            releaseIdentity = `assignment:${selected.assignment.digestSha256}`;
            playbackEndsAt = schedulePlaybackEndsAt(
              selected.assignment.schedule,
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
