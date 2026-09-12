import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { CAPABILITIES } from "@screengoblin/contracts";
import { mediaStorageKey } from "../media/delivery.js";
import { isApprovedPasswordHash } from "../utils/crypto.js";
import type {
  ActiveOrdinaryRelease,
  AuditRecord,
  DataStore,
  DeleteResult,
  DeviceAuthChallengeRecord,
  DeviceCredentialEnrollment,
  DeviceCredentialRecord,
  DeviceCredentialRevokeAuditContext,
  DeviceProofInput,
  DeviceProofVerifier,
  EmergencyRecord,
  HeartbeatUpdateInput,
  LoginFailureInput,
  MediaDeliveryAuthorizationInput,
  LocationRecord,
  MediaRecord,
  PairingRecord,
  PairingClaimAuditContext,
  PairingCreateAuditContext,
  PairingCreateResult,
  AuditedPairingCreateResult,
  PairingAttemptRecord,
  PairingProofVerifier,
  ReenrollmentActivationResult,
  ReenrollmentCandidateRecord,
  PlaylistRecord,
  PublishedReleaseRecord,
  ReleaseAssignmentRecord,
  ReleaseAuditContext,
  ReleasePublicationPolicy,
  ScheduleRecord,
  SchedulePublicationInput,
  SchedulePublicationResult,
  ScheduleWithdrawalResult,
  ScreenMutationInput,
  ScreenMutationPatch,
  ScreenRecord,
  SessionUser,
  SystemIdentityMutationAuditContext,
  UserMutationAuditContext,
  UserSessionCreateInput,
} from "../domain/types.js";
import {
  LOGIN_FAILURE_MAX_RECORDS,
  LOGIN_FAILURE_RETENTION_MS,
} from "../domain/types.js";
import {
  assignmentSnapshotDigest,
  canonicalAssignmentSnapshot,
  canonicalReleaseSnapshot,
  ReleaseSnapshotError,
  releaseSnapshotDigest,
} from "../releases/canonical.js";
import { hasCapability } from "../authorization/policy.js";
import { mediaUrlMatchesAllowedOrigin } from "../utils/media-url.js";
import { mediaPublicationFailure } from "../utils/media-policy.js";
import { matchesScheduleWindow } from "../utils/schedule.js";
import { randomToken } from "../utils/crypto.js";

const iso = (v: Date | null | undefined) => v?.toISOString();
const enumLower = <T extends string>(v: string) => v.toLowerCase() as T;
const safeInteger = (value: unknown, field: string): number => {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted))
    throw new RangeError(`${field} exceeds the JSON safe-integer range`);
  return converted;
};
const screenStatus = (x: Record<string, unknown>): ScreenRecord["status"] => {
  const stored = enumLower<ScreenRecord["status"]>(String(x.status));
  if (stored === "fallback") return stored;
  const lastSeen = x.lastSeenAt instanceof Date ? x.lastSeenAt.getTime() : 0;
  if (!x.installationId || !lastSeen) return "offline";
  const ageMs = Date.now() - lastSeen;
  if (ageMs > 5 * 60_000) return "offline";
  if (ageMs > 2 * 60_000) return "warning";
  return "online";
};
const screenDto = (
  x: Record<string, unknown>,
  includeCredential = false,
): ScreenRecord => ({
  id: String(x.id),
  organizationId: String(x.organizationId),
  name: String(x.name),
  location: String(x.location),
  ...(x.locationId ? { locationId: String(x.locationId) } : {}),
  ...(x.classifiedLocation &&
  typeof x.classifiedLocation === "object" &&
  "name" in x.classifiedLocation
    ? {
        locationName: String(
          (x.classifiedLocation as Record<string, unknown>).name,
        ),
      }
    : {}),
  status: screenStatus(x),
  orientation: enumLower<ScreenRecord["orientation"]>(String(x.orientation)),
  resolution: String(x.resolution),
  tags: x.tags as string[],
  ...(x.installationId ? { installationId: String(x.installationId) } : {}),
  ...(includeCredential && x.deviceTokenHash
    ? { deviceTokenHash: String(x.deviceTokenHash) }
    : {}),
  ...(x.model ? { model: String(x.model) } : {}),
  ...(x.osVersion ? { osVersion: String(x.osVersion) } : {}),
  ...(x.playerVersion ? { playerVersion: String(x.playerVersion) } : {}),
  ...(x.manifestVersion ? { manifestVersion: String(x.manifestVersion) } : {}),
  ...(x.nowPlayingAssetId
    ? { nowPlayingAssetId: String(x.nowPlayingAssetId) }
    : {}),
  ...(x.uptimeSeconds != null
    ? { uptimeSeconds: safeInteger(x.uptimeSeconds, "uptimeSeconds") }
    : {}),
  ...(x.freeStorageBytes != null
    ? { freeStorageBytes: safeInteger(x.freeStorageBytes, "freeStorageBytes") }
    : {}),
  ...(x.networkType ? { networkType: String(x.networkType) } : {}),
  ...(x.lastSeenAt ? { lastSeenAt: iso(x.lastSeenAt as Date) } : {}),
  ...(x.credentialRevokedAt
    ? { credentialRevokedAt: iso(x.credentialRevokedAt as Date) }
    : {}),
  ...(x.credentialGeneration != null
    ? { credentialGeneration: Number(x.credentialGeneration) }
    : {}),
  createdAt: iso(x.createdAt as Date)!,
  updatedAt: iso(x.updatedAt as Date)!,
});
const locationDto = (x: Record<string, unknown>): LocationRecord => ({
  id: String(x.id),
  organizationId: String(x.organizationId),
  name: String(x.name),
  createdAt: iso(x.createdAt as Date)!,
  updatedAt: iso(x.updatedAt as Date)!,
});
const mediaDto = (x: Record<string, unknown>): MediaRecord => ({
  id: String(x.id),
  organizationId: String(x.organizationId),
  name: String(x.name),
  kind: enumLower<MediaRecord["kind"]>(String(x.kind)),
  mimeType: String(x.mimeType),
  url: String(x.url),
  storageKey: String(x.storageKey),
  checksumSha256: String(x.checksumSha256),
  sizeBytes: safeInteger(x.sizeBytes, "sizeBytes"),
  ...(x.durationSeconds != null
    ? { durationSeconds: Number(x.durationSeconds) }
    : {}),
  ...(x.expiresAt ? { expiresAt: iso(x.expiresAt as Date) } : {}),
  createdAt: iso(x.createdAt as Date)!,
  updatedAt: iso(x.updatedAt as Date)!,
});
const playlistDto = (x: Record<string, unknown>): PlaylistRecord => ({
  id: String(x.id),
  organizationId: String(x.organizationId),
  name: String(x.name),
  description: String(x.description),
  items: ((x.items ?? []) as Array<Record<string, unknown>>).map((i) => ({
    id: String(i.id),
    assetId: String(i.assetId),
    position: Number(i.position),
    durationSeconds: Number(i.durationSeconds),
  })),
  createdAt: iso(x.createdAt as Date)!,
  updatedAt: iso(x.updatedAt as Date)!,
});
const scheduleDto = (x: Record<string, unknown>): ScheduleRecord => ({
  id: String(x.id),
  organizationId: String(x.organizationId),
  playlistId: String(x.playlistId),
  name: String(x.name),
  priority: enumLower<ScheduleRecord["priority"]>(String(x.priority)),
  startsAt: iso(x.startsAt as Date)!,
  ...(x.endsAt ? { endsAt: iso(x.endsAt as Date) } : {}),
  timezone: String(x.timezone),
  daysOfWeek: x.daysOfWeek as number[],
  ...(x.dailyStartMinutes != null
    ? { dailyStartMinutes: Number(x.dailyStartMinutes) }
    : {}),
  ...(x.dailyEndMinutes != null
    ? { dailyEndMinutes: Number(x.dailyEndMinutes) }
    : {}),
  enabled: Boolean(x.enabled),
  screenIds: ((x.targets ?? []) as Array<{ screenId: string }>).map(
    (t) => t.screenId,
  ),
  createdAt: iso(x.createdAt as Date)!,
  updatedAt: iso(x.updatedAt as Date)!,
});
const emergencyDto = (x: Record<string, unknown>): EmergencyRecord => ({
  id: String(x.id),
  organizationId: String(x.organizationId),
  title: String(x.title),
  message: String(x.message),
  backgroundColor: String(x.backgroundColor),
  targetScreenIds: x.targetScreenIds as string[],
  startsAt: iso(x.startsAt as Date)!,
  expiresAt: iso(x.expiresAt as Date)!,
  ...(x.clearedAt ? { clearedAt: iso(x.clearedAt as Date) } : {}),
  createdById: String(x.createdById),
  createdAt: iso(x.createdAt as Date)!,
});

const publishedReleaseDto = (
  x: Record<string, unknown>,
): PublishedReleaseRecord => ({
  id: String(x.id),
  organizationId: String(x.organizationId),
  sourcePlaylistId: String(x.sourcePlaylistId),
  sourcePlaylistUpdatedAt: iso(x.sourcePlaylistUpdatedAt as Date)!,
  playlistName: String(x.sourcePlaylistName),
  playlistDescription: String(x.sourcePlaylistDescription),
  digestSha256: String(x.digestSha256),
  items: ((x.items ?? []) as Array<Record<string, unknown>>).map((item) => ({
    id: String(item.sourcePlaylistItemId),
    asset: {
      id: String(item.sourceAssetId),
      name: String(item.assetName),
      kind: enumLower<MediaRecord["kind"]>(String(item.assetKind)),
      mimeType: String(item.assetMimeType),
      url: String(item.assetUrl),
      storageKey: String(item.assetStorageKey),
      checksumSha256: String(item.assetChecksumSha256),
      sizeBytes: safeInteger(item.assetSizeBytes, "assetSizeBytes"),
      createdAt: iso(item.assetCreatedAt as Date)!,
      ...(item.assetExpiresAt
        ? { expiresAt: iso(item.assetExpiresAt as Date) }
        : {}),
    },
    position: Number(item.position),
    durationSeconds: Number(item.durationSeconds),
  })),
  createdById: String(x.createdById),
  createdAt: iso(x.createdAt as Date)!,
});

const releaseAssignmentDto = (
  x: Record<string, unknown>,
): ReleaseAssignmentRecord => ({
  id: String(x.id),
  organizationId: String(x.organizationId),
  releaseId: String(x.releaseId),
  scheduleId: String(x.scheduleId),
  screenIds: ((x.targets ?? []) as Array<{ screenId: string }>)
    .map((target) => target.screenId)
    .sort(),
  state: String(x.state) as ReleaseAssignmentRecord["state"],
  schedule: {
    name: String(x.scheduleName),
    priority: enumLower<ScheduleRecord["priority"]>(String(x.priority)),
    startsAt: iso(x.startsAt as Date)!,
    ...(x.endsAt ? { endsAt: iso(x.endsAt as Date) } : {}),
    timezone: String(x.timezone),
    daysOfWeek: [...(x.daysOfWeek as number[])],
    ...(x.dailyStartMinutes != null
      ? { dailyStartMinutes: Number(x.dailyStartMinutes) }
      : {}),
    ...(x.dailyEndMinutes != null
      ? { dailyEndMinutes: Number(x.dailyEndMinutes) }
      : {}),
    enabled: Boolean(x.enabled),
  },
  digestSha256: String(x.digestSha256),
  ...(x.previousAssignmentId
    ? { previousAssignmentId: String(x.previousAssignmentId) }
    : {}),
  createdById: String(x.createdById),
  createdAt: iso(x.createdAt as Date)!,
});

const pairingDto = (x: {
  id: string;
  organizationId: string;
  codeHash: string;
  expiresAt: Date;
  status: "PENDING" | "CLAIMED" | "EXPIRED" | "REVOKED";
  screenId: string | null;
  purpose?: "NEW_SCREEN" | "REENROLL";
  targetScreenId?: string | null;
  targetScreenReferenceId?: string | null;
  expectedGeneration?: number | null;
  authorizedByUserId?: string | null;
  priorCredentialId?: string | null;
  requestReason?: string | null;
}): PairingRecord => ({
  id: x.id,
  organizationId: x.organizationId,
  codeHash: x.codeHash,
  expiresAt: iso(x.expiresAt)!,
  status: x.status,
  ...(x.screenId ? { screenId: x.screenId } : {}),
  ...(x.purpose ? { purpose: x.purpose } : {}),
  ...(x.targetScreenId ? { targetScreenId: x.targetScreenId } : {}),
  ...(x.targetScreenReferenceId
    ? { targetScreenReferenceId: x.targetScreenReferenceId }
    : {}),
  ...(x.expectedGeneration != null
    ? { expectedGeneration: x.expectedGeneration }
    : {}),
  ...(x.authorizedByUserId ? { authorizedByUserId: x.authorizedByUserId } : {}),
  ...(x.priorCredentialId ? { priorCredentialId: x.priorCredentialId } : {}),
  ...(x.requestReason ? { requestReason: x.requestReason } : {}),
});

const deviceCredentialDto = (x: {
  id: string;
  organizationId: string;
  screenId: string;
  liveScreenId: string | null;
  keyId: string;
  publicKeySpki: Uint8Array;
  algorithm: string;
  securityLevel: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}): DeviceCredentialRecord => ({
  id: x.id,
  organizationId: x.organizationId,
  screenId: x.screenId,
  detached: x.liveScreenId === null,
  keyId: x.keyId,
  publicKeySpki: Buffer.from(x.publicKeySpki).toString("base64url"),
  algorithm: "ES256",
  securityLevel: x.securityLevel as DeviceCredentialRecord["securityLevel"],
  ...(x.expiresAt ? { expiresAt: iso(x.expiresAt) } : {}),
  ...(x.revokedAt ? { revokedAt: iso(x.revokedAt) } : {}),
  createdAt: iso(x.createdAt)!,
});

const deviceChallengeDto = (x: {
  id: string;
  organizationId: string;
  credentialId: string;
  challengeHashSha256: string;
  operation: "HEARTBEAT" | "MANIFEST";
  requestDigestSha256: string;
  expiresAt: Date;
  consumedAt: Date | null;
  provedAt?: Date | null;
  activatedAt?: Date | null;
  cancelledAt?: Date | null;
  installationId?: string | null;
  model?: string | null;
  osVersion?: string | null;
  playerVersion?: string | null;
  createdAt: Date;
}): DeviceAuthChallengeRecord => ({
  id: x.id,
  organizationId: x.organizationId,
  credentialId: x.credentialId,
  challengeHashSha256: x.challengeHashSha256,
  operation: enumLower(x.operation),
  requestDigestSha256: x.requestDigestSha256,
  expiresAt: iso(x.expiresAt)!,
  ...(x.consumedAt ? { consumedAt: iso(x.consumedAt) } : {}),
  ...(x.provedAt ? { provedAt: iso(x.provedAt) } : {}),
  ...(x.activatedAt ? { activatedAt: iso(x.activatedAt) } : {}),
  ...(x.cancelledAt ? { cancelledAt: iso(x.cancelledAt) } : {}),
  ...(x.installationId ? { installationId: x.installationId } : {}),
  ...(x.model ? { model: x.model } : {}),
  ...(x.osVersion ? { osVersion: x.osVersion } : {}),
  ...(x.playerVersion ? { playerVersion: x.playerVersion } : {}),
  createdAt: iso(x.createdAt)!,
});

const pairingAttemptDto = (x: {
  id: string;
  organizationId: string;
  pairingCodeId: string;
  keyId: string;
  publicKeySpki: Uint8Array;
  algorithm: string;
  securityLevel: string;
  credentialExpiresAt: Date | null;
  challengeHashSha256: string;
  transcriptDigestSha256: string;
  expiresAt: Date;
  consumedAt: Date | null;
  boundCredentialId: string | null;
  createdAt: Date;
}): PairingAttemptRecord => ({
  id: x.id,
  organizationId: x.organizationId,
  pairingCodeId: x.pairingCodeId,
  keyId: x.keyId,
  publicKeySpki: Buffer.from(x.publicKeySpki).toString("base64url"),
  algorithm: "ES256",
  securityLevel: x.securityLevel as PairingAttemptRecord["securityLevel"],
  ...(x.credentialExpiresAt
    ? { credentialExpiresAt: iso(x.credentialExpiresAt) }
    : {}),
  challengeHashSha256: x.challengeHashSha256,
  transcriptDigestSha256: x.transcriptDigestSha256,
  expiresAt: iso(x.expiresAt)!,
  ...(x.consumedAt ? { consumedAt: iso(x.consumedAt) } : {}),
  ...(x.boundCredentialId ? { boundCredentialId: x.boundCredentialId } : {}),
  createdAt: iso(x.createdAt)!,
});

const isUniqueConstraintError = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002";
const isForeignKeyConstraintError = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2003";
const isRetryableWriteConflict = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  (error.code === "P2034" ||
    (error.code === "P2010" &&
      (error.meta as { code?: unknown } | undefined)?.code === "40001"));

class InvalidLocationClassificationError extends Error {
  readonly code = "INVALID_LOCATION";

  constructor() {
    super("Location is not in this organization");
  }
}

export class PrismaStore implements DataStore {
  constructor(readonly prisma = new PrismaClient()) {}
  private async lockActiveActorRole(
    tx: Prisma.TransactionClient,
    organizationId: string,
    actorUserId: string,
  ) {
    const [actor] = await tx.$queryRaw<Array<{ role: string }>>`
      SELECT membership."role"::text AS "role"
      FROM "Membership" membership
      INNER JOIN "User" actor ON actor."id" = membership."userId"
      WHERE membership."organizationId" = ${organizationId}
        AND membership."userId" = ${actorUserId}
        AND actor."disabledAt" IS NULL
      FOR UPDATE OF membership, actor`;
    return actor?.role;
  }
  private async lockLocationForClassification(
    tx: Prisma.TransactionClient,
    organizationId: string,
    locationId: string,
  ) {
    // Classification mutations take the target Location lock before any Screen
    // lock. Deletion takes Location FOR UPDATE first, so concurrent assignment
    // either commits before an IN_USE result or observes the completed delete.
    const [location] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT location."id"
      FROM "Location" location
      WHERE location."id" = ${locationId}
        AND location."organizationId" = ${organizationId}
      FOR KEY SHARE OF location`;
    return Boolean(location);
  }
  private identityMutationMetadata(audit: SystemIdentityMutationAuditContext) {
    const reason = audit.reason.trim();
    if (!reason || reason.length > 500)
      throw new Error(
        "Identity mutation reason must contain 1 to 500 characters",
      );
    return { reason };
  }
  async ping() {
    await this.prisma.$queryRaw`SELECT 1`;
  }
  async close() {
    await this.prisma.$disconnect();
  }
  async findUserByEmail(email: string) {
    // Resolve identity eligibility and the stable compatibility membership in
    // one statement for known, unknown, disabled, and membershipless accounts.
    // LIMIT 2 keeps pre-migration case ambiguity fail-closed.
    const matches = await this.prisma.$queryRaw<
      Array<{
        id: string;
        email: string;
        name: string;
        passwordHash: string;
        authenticationEpoch: number;
        disabledAt: Date | null;
        organizationId: string | null;
        role: SessionUser["role"] | null;
        authorizationEpoch: number | null;
      }>
    >`
      SELECT identity."id",
             identity."email",
             identity."name",
             identity."passwordHash",
             identity."authenticationEpoch",
             identity."disabledAt",
             membership."organizationId",
             membership."role"::text AS "role",
             membership."authorizationEpoch"
      FROM "User" identity
      LEFT JOIN LATERAL (
        SELECT candidate."organizationId",
               candidate."role",
               candidate."authorizationEpoch"
        FROM "Membership" candidate
        WHERE candidate."userId" = identity."id"
        ORDER BY candidate."organizationId" ASC
        LIMIT 1
      ) membership ON TRUE
      WHERE LOWER(identity."email") = ${email.toLowerCase()}
      ORDER BY identity."id" ASC
      LIMIT 2
    `;
    if (matches.length !== 1) return null;
    const x = matches[0]!;
    return !x.disabledAt &&
      x.organizationId !== null &&
      x.role !== null &&
      x.authorizationEpoch !== null
      ? ({
          id: x.id,
          email: x.email,
          name: x.name,
          passwordHash: x.passwordHash,
          organizationId: x.organizationId,
          role: x.role,
          authenticationEpoch: x.authenticationEpoch,
          authorizationEpoch: x.authorizationEpoch,
        } satisfies SessionUser)
      : null;
  }
  async recordLoginFailure(input: LoginFailureInput) {
    if (
      !/^[0-9a-f]{64}$/.test(input.accountKey) ||
      !/^[0-9a-f]{64}$/.test(input.sourceKey)
    )
      throw new Error("Login failure identifiers must be opaque SHA-256 HMACs");
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(474696137)`;
      const [clock] = await tx.$queryRaw<Array<{ databaseNow: Date }>>`
        SELECT CURRENT_TIMESTAMP AS "databaseNow"`;
      if (!clock) throw new Error("Database clock is unavailable");
      const cutoff = new Date(
        clock.databaseNow.getTime() - LOGIN_FAILURE_RETENTION_MS,
      );
      await tx.loginFailureEvent.deleteMany({
        where: { occurredAt: { lt: cutoff } },
      });
      await tx.$executeRaw`
        DELETE FROM "LoginFailureEvent"
        WHERE "id" IN (
          SELECT "id"
          FROM "LoginFailureEvent"
          ORDER BY "occurredAt" DESC, "id" DESC
          OFFSET ${LOGIN_FAILURE_MAX_RECORDS - 1}
        )`;
      await tx.loginFailureEvent.create({
        data: {
          accountKey: input.accountKey,
          sourceKey: input.sourceKey,
          reason: input.reason,
          occurredAt: clock.databaseNow,
        },
      });
    });
  }
  async findSessionUser(userId: string, organizationId: string) {
    const x = await this.prisma.user.findFirst({
      where: {
        id: userId,
        disabledAt: null,
        memberships: { some: { organizationId } },
      },
      include: {
        memberships: { where: { organizationId }, take: 1 },
      },
    });
    const membership = x?.memberships[0];
    return x && membership
      ? {
          id: x.id,
          email: x.email,
          name: x.name,
          passwordHash: x.passwordHash,
          organizationId,
          role: membership.role,
          authenticationEpoch: x.authenticationEpoch,
          authorizationEpoch: membership.authorizationEpoch,
        }
      : null;
  }
  async createUserSessionAndAudit(
    organizationId: string,
    input: UserSessionCreateInput,
    audit: UserMutationAuditContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const [current] = await tx.$queryRaw<
        Array<{
          id: string;
          passwordHash: string;
          role: string;
          authenticationEpoch: number;
          authorizationEpoch: number;
          databaseNow: Date;
        }>
      >`
        SELECT actor."id",
               actor."passwordHash",
               actor."authenticationEpoch",
               membership."role"::text AS "role",
               membership."authorizationEpoch",
               CURRENT_TIMESTAMP AS "databaseNow"
        FROM "Membership" membership
        INNER JOIN "User" actor ON actor."id" = membership."userId"
        WHERE membership."organizationId" = ${organizationId}
          AND membership."userId" = ${audit.actorUserId}
          AND actor."disabledAt" IS NULL
        FOR UPDATE OF membership, actor`;
      const expiresAt = new Date(input.expiresAt);
      if (
        !current ||
        current.passwordHash !== input.expectedPasswordHash ||
        current.role !== input.expectedRole ||
        current.authenticationEpoch !== input.expectedAuthenticationEpoch ||
        current.authorizationEpoch !== input.expectedAuthorizationEpoch ||
        !Number.isFinite(expiresAt.getTime()) ||
        expiresAt <= current.databaseNow
      )
        return { created: false as const, reason: "FORBIDDEN" as const };
      await tx.userSession.deleteMany({
        where: {
          userId: current.id,
          organizationId,
          expiresAt: { lte: current.databaseNow },
        },
      });
      const session = await tx.userSession.create({
        data: {
          organizationId,
          userId: current.id,
          tokenHash: input.tokenHash,
          authenticationEpoch: current.authenticationEpoch,
          authorizationEpoch: current.authorizationEpoch,
          expiresAt,
        },
      });
      await tx.auditEvent.create({
        data: {
          organizationId,
          actorUserId: current.id,
          actorType: "user",
          action: "auth.login_succeeded",
          entityType: "session",
          entityId: session.id,
          ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
          ...(audit.requestId ? { requestId: audit.requestId } : {}),
          metadata: { expiresAt: input.expiresAt },
        },
      });
      return {
        created: true as const,
        session: {
          id: session.id,
          organizationId: session.organizationId,
          userId: session.userId,
          tokenHash: session.tokenHash,
          authenticationEpoch: session.authenticationEpoch,
          authorizationEpoch: session.authorizationEpoch,
          expiresAt: session.expiresAt.toISOString(),
          ...(session.revokedAt
            ? { revokedAt: session.revokedAt.toISOString() }
            : {}),
          createdAt: session.createdAt.toISOString(),
        },
      };
    });
  }
  async findActiveUserSession(
    userId: string,
    organizationId: string,
    tokenHash: string,
  ) {
    const [current] = await this.prisma.$queryRaw<
      Array<{
        id: string;
        email: string;
        name: string;
        passwordHash: string;
        role: SessionUser["role"];
        authenticationEpoch: number;
        authorizationEpoch: number;
      }>
    >`
      SELECT actor."id",
             actor."email",
             actor."name",
             actor."passwordHash",
             membership."role"::text AS "role",
             actor."authenticationEpoch",
             membership."authorizationEpoch"
      FROM "UserSession" session
      INNER JOIN "Membership" membership
        ON membership."organizationId" = session."organizationId"
       AND membership."userId" = session."userId"
      INNER JOIN "User" actor ON actor."id" = membership."userId"
      WHERE session."tokenHash" = ${tokenHash}
        AND session."userId" = ${userId}
        AND session."organizationId" = ${organizationId}
        AND session."revokedAt" IS NULL
        AND session."expiresAt" > CURRENT_TIMESTAMP
        AND actor."disabledAt" IS NULL
        AND session."authenticationEpoch" = actor."authenticationEpoch"
        AND session."authorizationEpoch" = membership."authorizationEpoch"
    `;
    return current
      ? {
          ...current,
          organizationId,
        }
      : null;
  }
  async revokeUserSessionAndAudit(
    userId: string,
    organizationId: string,
    tokenHash: string,
    audit: UserMutationAuditContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      if (audit.actorUserId !== userId)
        return { revoked: false as const, reason: "NOT_FOUND" as const };
      const [session] = await tx.$queryRaw<
        Array<{ id: string; databaseNow: Date }>
      >`
        SELECT session."id", CURRENT_TIMESTAMP AS "databaseNow"
        FROM "UserSession" session
        INNER JOIN "Membership" membership
          ON membership."organizationId" = session."organizationId"
         AND membership."userId" = session."userId"
        INNER JOIN "User" actor ON actor."id" = membership."userId"
        WHERE session."tokenHash" = ${tokenHash}
          AND session."userId" = ${userId}
          AND session."organizationId" = ${organizationId}
          AND session."revokedAt" IS NULL
          AND session."expiresAt" > CURRENT_TIMESTAMP
          AND actor."disabledAt" IS NULL
        FOR UPDATE OF session, membership, actor`;
      if (!session)
        return { revoked: false as const, reason: "NOT_FOUND" as const };
      await tx.userSession.update({
        where: { id: session.id },
        data: { revokedAt: session.databaseNow },
      });
      await tx.auditEvent.create({
        data: {
          organizationId,
          actorUserId: userId,
          actorType: "user",
          action: "auth.logout",
          entityType: "session",
          entityId: session.id,
          ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
          ...(audit.requestId ? { requestId: audit.requestId } : {}),
          metadata: {},
        },
      });
      return { revoked: true as const };
    });
  }
  async rotateUserPasswordAndAudit(
    userId: string,
    passwordHash: string,
    audit: SystemIdentityMutationAuditContext,
  ) {
    if (!isApprovedPasswordHash(passwordHash))
      throw new Error("An approved bcrypt password hash is required");
    const metadata = this.identityMutationMetadata(audit);
    return this.prisma.$transaction(async (tx) => {
      const memberships = await tx.$queryRaw<
        Array<{ organizationId: string; databaseNow: Date }>
      >`
        SELECT membership."organizationId",
               CURRENT_TIMESTAMP AS "databaseNow"
        FROM "User" actor
        INNER JOIN "Membership" membership
          ON membership."userId" = actor."id"
        WHERE actor."id" = ${userId}
        ORDER BY membership."organizationId" ASC
        FOR UPDATE OF actor, membership`;
      const clock = memberships[0]?.databaseNow;
      if (!clock)
        return { updated: false as const, reason: "NOT_FOUND" as const };
      await tx.user.update({
        where: { id: userId },
        data: {
          passwordHash,
          authenticationEpoch: { increment: 1 },
        },
      });
      await tx.userSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: clock },
      });
      await tx.auditEvent.createMany({
        data: memberships.map(({ organizationId }) => ({
          organizationId,
          actorType: "system",
          action: "identity.password_rotated",
          entityType: "user",
          entityId: userId,
          ...(audit.requestId ? { requestId: audit.requestId } : {}),
          metadata,
        })),
      });
      return {
        updated: true as const,
        affectedOrganizationIds: memberships.map(
          ({ organizationId }) => organizationId,
        ),
      };
    });
  }
  async disableUserAndAudit(
    userId: string,
    audit: SystemIdentityMutationAuditContext,
  ) {
    const metadata = this.identityMutationMetadata(audit);
    return this.prisma.$transaction(async (tx) => {
      const memberships = await tx.$queryRaw<
        Array<{ organizationId: string; databaseNow: Date }>
      >`
        SELECT membership."organizationId",
               CURRENT_TIMESTAMP AS "databaseNow"
        FROM "User" actor
        INNER JOIN "Membership" membership
          ON membership."userId" = actor."id"
        WHERE actor."id" = ${userId}
        ORDER BY membership."organizationId" ASC
        FOR UPDATE OF actor, membership`;
      const clock = memberships[0]?.databaseNow;
      if (!clock)
        return { updated: false as const, reason: "NOT_FOUND" as const };
      await tx.user.update({
        where: { id: userId },
        data: {
          disabledAt: clock,
          authenticationEpoch: { increment: 1 },
        },
      });
      await tx.userSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: clock },
      });
      await tx.auditEvent.createMany({
        data: memberships.map(({ organizationId }) => ({
          organizationId,
          actorType: "system",
          action: "identity.user_disabled",
          entityType: "user",
          entityId: userId,
          ...(audit.requestId ? { requestId: audit.requestId } : {}),
          metadata,
        })),
      });
      return {
        updated: true as const,
        affectedOrganizationIds: memberships.map(
          ({ organizationId }) => organizationId,
        ),
      };
    });
  }
  async changeMembershipRoleAndAudit(
    organizationId: string,
    userId: string,
    role: SessionUser["role"],
    audit: SystemIdentityMutationAuditContext,
  ) {
    const metadata = this.identityMutationMetadata(audit);
    return this.prisma.$transaction(async (tx) => {
      const [membership] = await tx.$queryRaw<
        Array<{ id: string; role: SessionUser["role"]; databaseNow: Date }>
      >`
        SELECT membership."id",
               membership."role"::text AS "role",
               CURRENT_TIMESTAMP AS "databaseNow"
        FROM "Membership" membership
        INNER JOIN "User" actor ON actor."id" = membership."userId"
        WHERE membership."organizationId" = ${organizationId}
          AND membership."userId" = ${userId}
        FOR UPDATE OF membership, actor`;
      if (!membership)
        return { updated: false as const, reason: "NOT_FOUND" as const };
      await tx.membership.update({
        where: { id: membership.id },
        data: { role, authorizationEpoch: { increment: 1 } },
      });
      await tx.userSession.updateMany({
        where: { organizationId, userId, revokedAt: null },
        data: { revokedAt: membership.databaseNow },
      });
      await tx.auditEvent.create({
        data: {
          organizationId,
          actorType: "system",
          action: "identity.membership_role_changed",
          entityType: "membership",
          entityId: membership.id,
          ...(audit.requestId ? { requestId: audit.requestId } : {}),
          metadata: { ...metadata, previousRole: membership.role, role },
        },
      });
      return { updated: true as const };
    });
  }
  async removeMembershipAndAudit(
    organizationId: string,
    userId: string,
    audit: SystemIdentityMutationAuditContext,
  ) {
    const metadata = this.identityMutationMetadata(audit);
    return this.prisma.$transaction(async (tx) => {
      const [membership] = await tx.$queryRaw<
        Array<{ id: string; role: SessionUser["role"]; databaseNow: Date }>
      >`
        SELECT membership."id",
               membership."role"::text AS "role",
               CURRENT_TIMESTAMP AS "databaseNow"
        FROM "Membership" membership
        INNER JOIN "User" actor ON actor."id" = membership."userId"
        WHERE membership."organizationId" = ${organizationId}
          AND membership."userId" = ${userId}
        FOR UPDATE OF membership, actor`;
      if (!membership)
        return { updated: false as const, reason: "NOT_FOUND" as const };
      await tx.membership.update({
        where: { id: membership.id },
        data: { authorizationEpoch: { increment: 1 } },
      });
      await tx.userSession.updateMany({
        where: { organizationId, userId, revokedAt: null },
        data: { revokedAt: membership.databaseNow },
      });
      await tx.auditEvent.create({
        data: {
          organizationId,
          actorType: "system",
          action: "identity.membership_removed",
          entityType: "membership",
          entityId: membership.id,
          ...(audit.requestId ? { requestId: audit.requestId } : {}),
          metadata: { ...metadata, previousRole: membership.role },
        },
      });
      await tx.membership.delete({ where: { id: membership.id } });
      return { updated: true as const };
    });
  }
  async listLocations(org: string) {
    return (
      await this.prisma.location.findMany({
        where: { organizationId: org },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      })
    ).map((location) => locationDto(location));
  }
  async createLocationAndAudit(
    org: string,
    name: string,
    audit: UserMutationAuditContext,
  ) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const role = await this.lockActiveActorRole(tx, org, audit.actorUserId);
        if (role !== "OWNER" && role !== "ADMIN")
          return { created: false as const, reason: "FORBIDDEN" as const };
        const location = await tx.location.create({
          data: { organizationId: org, name },
        });
        await tx.auditEvent.create({
          data: {
            organizationId: org,
            actorUserId: audit.actorUserId,
            actorType: "user",
            action: "location.created",
            entityType: "location",
            entityId: location.id,
            ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
            ...(audit.requestId ? { requestId: audit.requestId } : {}),
            metadata: { name },
          },
        });
        return { created: true as const, value: locationDto(location) };
      });
    } catch (error) {
      if (isUniqueConstraintError(error))
        return { created: false as const, reason: "DUPLICATE" as const };
      throw error;
    }
  }
  async updateLocationAndAudit(
    org: string,
    id: string,
    name: string,
    audit: UserMutationAuditContext,
  ) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const role = await this.lockActiveActorRole(tx, org, audit.actorUserId);
        if (role !== "OWNER" && role !== "ADMIN")
          return { updated: false as const, reason: "FORBIDDEN" as const };
        const [locked] = await tx.$queryRaw<
          Array<{ id: string; name: string }>
        >`
          SELECT location."id", location."name"
          FROM "Location" location
          WHERE location."id" = ${id}
            AND location."organizationId" = ${org}
          FOR UPDATE OF location`;
        if (!locked)
          return { updated: false as const, reason: "NOT_FOUND" as const };
        const location = await tx.location.update({
          where: { id },
          data: { name },
        });
        await tx.auditEvent.create({
          data: {
            organizationId: org,
            actorUserId: audit.actorUserId,
            actorType: "user",
            action: "location.updated",
            entityType: "location",
            entityId: id,
            ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
            ...(audit.requestId ? { requestId: audit.requestId } : {}),
            metadata: { previousName: locked.name, name },
          },
        });
        return { updated: true as const, value: locationDto(location) };
      });
    } catch (error) {
      if (isUniqueConstraintError(error))
        return { updated: false as const, reason: "DUPLICATE" as const };
      throw error;
    }
  }
  async deleteLocationAndAudit(
    org: string,
    id: string,
    audit: UserMutationAuditContext,
  ) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const role = await this.lockActiveActorRole(tx, org, audit.actorUserId);
        if (role !== "OWNER" && role !== "ADMIN")
          return { deleted: false as const, reason: "FORBIDDEN" as const };
        const [locked] = await tx.$queryRaw<
          Array<{ id: string; name: string }>
        >`
          SELECT location."id", location."name"
          FROM "Location" location
          WHERE location."id" = ${id}
            AND location."organizationId" = ${org}
          FOR UPDATE OF location`;
        if (!locked)
          return { deleted: false as const, reason: "NOT_FOUND" as const };
        const inUse = await tx.screen.findFirst({
          where: { organizationId: org, locationId: id },
          select: { id: true },
        });
        if (inUse)
          return { deleted: false as const, reason: "IN_USE" as const };
        await tx.location.delete({ where: { id } });
        await tx.auditEvent.create({
          data: {
            organizationId: org,
            actorUserId: audit.actorUserId,
            actorType: "user",
            action: "location.deleted",
            entityType: "location",
            entityId: id,
            ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
            ...(audit.requestId ? { requestId: audit.requestId } : {}),
            metadata: { name: locked.name },
          },
        });
        return { deleted: true as const };
      });
    } catch (error) {
      if (isForeignKeyConstraintError(error))
        return { deleted: false as const, reason: "IN_USE" as const };
      throw error;
    }
  }
  async listScreens(org: string) {
    return (
      await this.prisma.screen.findMany({
        where: { organizationId: org },
        include: { classifiedLocation: true },
        orderBy: { name: "asc" },
      })
    ).map((x) => screenDto(x));
  }
  async getScreen(org: string, id: string) {
    const x = await this.prisma.screen.findFirst({
      where: { id, organizationId: org },
      include: { classifiedLocation: true },
    });
    return x ? screenDto(x) : null;
  }
  async createScreen(org: string, data: ScreenMutationInput) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (
          data.locationId &&
          !(await this.lockLocationForClassification(tx, org, data.locationId))
        )
          throw new InvalidLocationClassificationError();
        const { locationId, ...screenData } = data;
        return screenDto(
          await tx.screen.create({
            data: {
              organizationId: org,
              ...screenData,
              ...(locationId ? { locationId } : {}),
              orientation: data.orientation.toUpperCase() as
                "LANDSCAPE" | "PORTRAIT",
            },
            include: { classifiedLocation: true },
          }),
        );
      });
    } catch (error) {
      if (isForeignKeyConstraintError(error))
        throw new InvalidLocationClassificationError();
      throw error;
    }
  }
  async createScreenAndAudit(
    org: string,
    data: ScreenMutationInput,
    audit: UserMutationAuditContext,
  ) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const role = await this.lockActiveActorRole(tx, org, audit.actorUserId);
        if (role !== "OWNER" && role !== "ADMIN")
          return { created: false as const, reason: "FORBIDDEN" as const };
        if (
          data.locationId &&
          !(await this.lockLocationForClassification(tx, org, data.locationId))
        )
          return {
            created: false as const,
            reason: "INVALID_LOCATION" as const,
          };
        const { locationId, ...screenData } = data;
        const screen = await tx.screen.create({
          data: {
            organizationId: org,
            ...screenData,
            ...(locationId ? { locationId } : {}),
            orientation: data.orientation.toUpperCase() as
              "LANDSCAPE" | "PORTRAIT",
          },
          include: { classifiedLocation: true },
        });
        await tx.auditEvent.create({
          data: {
            organizationId: org,
            actorUserId: audit.actorUserId,
            actorType: "user",
            action: "screen.created",
            entityType: "screen",
            entityId: screen.id,
            ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
            ...(audit.requestId ? { requestId: audit.requestId } : {}),
            metadata: { name: screen.name },
          },
        });
        return { created: true as const, value: screenDto(screen) };
      });
    } catch (error) {
      if (isForeignKeyConstraintError(error))
        return { created: false as const, reason: "INVALID_LOCATION" as const };
      throw error;
    }
  }
  async updateScreen(org: string, id: string, data: ScreenMutationPatch) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (
          data.locationId &&
          !(await this.lockLocationForClassification(tx, org, data.locationId))
        )
          return null;
        const existing = await tx.screen.findFirst({
          where: { id, organizationId: org },
          select: { id: true },
        });
        if (!existing) return null;
        const { orientation, locationId, ...rest } = data;
        return screenDto(
          await tx.screen.update({
            where: { id },
            data: {
              ...rest,
              ...(locationId !== undefined ? { locationId } : {}),
              ...(orientation
                ? {
                    orientation: orientation.toUpperCase() as
                      "LANDSCAPE" | "PORTRAIT",
                  }
                : {}),
            },
            include: { classifiedLocation: true },
          }),
        );
      });
    } catch (error) {
      if (isForeignKeyConstraintError(error)) return null;
      throw error;
    }
  }
  async updateScreenAndAudit(
    org: string,
    id: string,
    data: ScreenMutationPatch,
    audit: UserMutationAuditContext,
  ) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const role = await this.lockActiveActorRole(tx, org, audit.actorUserId);
        if (role !== "OWNER" && role !== "ADMIN")
          return { updated: false as const, reason: "FORBIDDEN" as const };
        if (
          data.locationId &&
          !(await this.lockLocationForClassification(tx, org, data.locationId))
        )
          return {
            updated: false as const,
            reason: "INVALID_LOCATION" as const,
          };
        const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT screen."id"
          FROM "Screen" screen
          WHERE screen."id" = ${id} AND screen."organizationId" = ${org}
          FOR UPDATE OF screen`;
        if (!locked)
          return { updated: false as const, reason: "NOT_FOUND" as const };
        const { orientation, locationId, ...rest } = data;
        const screen = await tx.screen.update({
          where: { id },
          data: {
            ...rest,
            ...(locationId !== undefined ? { locationId } : {}),
            ...(orientation
              ? {
                  orientation: orientation.toUpperCase() as
                    "LANDSCAPE" | "PORTRAIT",
                }
              : {}),
          },
          include: { classifiedLocation: true },
        });
        await tx.auditEvent.create({
          data: {
            organizationId: org,
            actorUserId: audit.actorUserId,
            actorType: "user",
            action: "screen.updated",
            entityType: "screen",
            entityId: id,
            ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
            ...(audit.requestId ? { requestId: audit.requestId } : {}),
            metadata: {},
          },
        });
        return { updated: true as const, value: screenDto(screen) };
      });
    } catch (error) {
      if (isForeignKeyConstraintError(error))
        return { updated: false as const, reason: "INVALID_LOCATION" as const };
      throw error;
    }
  }
  async deleteScreen(org: string, id: string) {
    const r = await this.prisma.screen.deleteMany({
      where: { id, organizationId: org },
    });
    return r.count > 0;
  }
  async deleteScreenAndAudit(
    org: string,
    id: string,
    audit: DeviceCredentialRevokeAuditContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const [actor] = await tx.$queryRaw<Array<{ role: string }>>`
        SELECT membership."role"::text AS "role"
        FROM "Membership" membership
        INNER JOIN "User" actor ON actor."id" = membership."userId"
        WHERE membership."organizationId" = ${org}
          AND membership."userId" = ${audit.actorUserId}
          AND actor."disabledAt" IS NULL
        FOR UPDATE OF membership, actor`;
      if (actor?.role !== "OWNER" && actor?.role !== "ADMIN")
        return "FORBIDDEN" as const;
      const [locked] = await tx.$queryRaw<
        Array<{ id: string; databaseNow: Date }>
      >`
        SELECT screen."id", CURRENT_TIMESTAMP AS "databaseNow"
        FROM "Screen" screen WHERE screen."id" = ${id} AND screen."organizationId" = ${org}
        FOR UPDATE OF screen`;
      if (!locked) return "NOT_FOUND" as const;
      const credentials = await tx.deviceCredential.findMany({
        where: { organizationId: org, screenId: id },
        select: { id: true },
      });
      const credentialIds = credentials.map((x) => x.id);
      await tx.deviceAuthChallenge.updateMany({
        where: {
          credentialId: { in: credentialIds },
          consumedAt: null,
          expiresAt: { gt: locked.databaseNow },
        },
        data: { consumedAt: locked.databaseNow },
      });
      await tx.deviceCredential.updateMany({
        where: { id: { in: credentialIds }, revokedAt: null },
        data: {
          revokedAt: locked.databaseNow,
          liveScreenId: null,
          liveScreenOrganizationId: null,
        },
      });
      const grants = await tx.pairingCode.findMany({
        where: { organizationId: org, targetScreenId: id, status: "PENDING" },
        select: { id: true },
      });
      await tx.pairingAttempt.updateMany({
        where: {
          pairingCodeId: { in: grants.map((g) => g.id) },
          consumedAt: null,
        },
        data: { cancelledAt: locked.databaseNow },
      });
      await tx.pairingCode.updateMany({
        where: { id: { in: grants.map((g) => g.id) } },
        data: { status: "REVOKED" },
      });
      await tx.screen.delete({ where: { id } });
      await tx.auditEvent.create({
        data: {
          organizationId: org,
          actorUserId: audit.actorUserId,
          actorType: "user",
          action: "screen.decommissioned",
          entityType: "screen",
          entityId: id,
          ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
          ...(audit.requestId ? { requestId: audit.requestId } : {}),
          metadata: { revokedCredentialCount: credentialIds.length },
        },
      });
      return "DELETED" as const;
    });
  }
  async createPairing(org: string, codeHash: string, expiresAt: string) {
    const result = await this.tryCreatePairing(org, codeHash, expiresAt);
    if (!result.created) throw new Error("Pairing code collision");
    return result.pairing;
  }
  async tryCreatePairing(
    org: string,
    codeHash: string,
    expiresAt: string,
  ): Promise<PairingCreateResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.pairingCode.updateMany({
          where: {
            codeHash,
            status: "PENDING",
            expiresAt: { lte: new Date() },
          },
          data: { status: "EXPIRED" },
        });
        const pairing = await tx.pairingCode.create({
          data: {
            organizationId: org,
            codeHash,
            expiresAt: new Date(expiresAt),
          },
        });
        return { created: true, pairing: pairingDto(pairing) };
      });
    } catch (error) {
      // PostgreSQL aborts a transaction after a uniqueness violation, so map
      // the collision only after Prisma has rolled the transaction back.
      if (isUniqueConstraintError(error))
        return { created: false, reason: "CODE_COLLISION" };
      throw error;
    }
  }
  async tryCreatePairingAndAudit(
    org: string,
    codeHash: string,
    expiresAt: string,
    audit: PairingCreateAuditContext,
  ): Promise<AuditedPairingCreateResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const role = await this.lockActiveActorRole(tx, org, audit.actorUserId);
        if (role !== "OWNER" && role !== "ADMIN")
          return { created: false as const, reason: "FORBIDDEN" as const };
        await tx.pairingCode.updateMany({
          where: {
            codeHash,
            status: "PENDING",
            expiresAt: { lte: new Date() },
          },
          data: { status: "EXPIRED" },
        });
        const pairing = await tx.pairingCode.create({
          data: {
            organizationId: org,
            codeHash,
            expiresAt: new Date(expiresAt),
          },
        });
        await tx.auditEvent.create({
          data: {
            organizationId: org,
            actorUserId: audit.actorUserId,
            actorType: "user",
            action: "pairing.created",
            entityType: "pairing",
            entityId: pairing.id,
            ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
            ...(audit.requestId ? { requestId: audit.requestId } : {}),
            metadata: { expiresAt },
          },
        });
        return { created: true, pairing: pairingDto(pairing) };
      });
    } catch (error) {
      // Map only after rollback: PostgreSQL keeps a transaction aborted after
      // the unique-index violation that represents a live-code collision.
      if (isUniqueConstraintError(error))
        return { created: false, reason: "CODE_COLLISION" };
      throw error;
    }
  }
  async requestScreenReenrollmentAndAudit(
    org: string,
    screenId: string,
    codeHash: string,
    expiresAt: string,
    reason: string,
    audit: PairingCreateAuditContext,
  ) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const [actor] = await tx.$queryRaw<Array<{ role: string }>>`
          SELECT membership."role"::text AS "role" FROM "Membership" membership
          INNER JOIN "User" actor ON actor."id" = membership."userId"
          WHERE membership."organizationId" = ${org} AND membership."userId" = ${audit.actorUserId}
            AND actor."disabledAt" IS NULL FOR UPDATE OF membership, actor`;
        if (actor?.role !== "OWNER" && actor?.role !== "ADMIN")
          return { created: false as const, reason: "FORBIDDEN" as const };
        const [locked] = await tx.$queryRaw<
          Array<{ id: string; credentialGeneration: number; databaseNow: Date }>
        >`
          SELECT screen."id", screen."credentialGeneration", CURRENT_TIMESTAMP AS "databaseNow"
          FROM "Screen" screen WHERE screen."id" = ${screenId} AND screen."organizationId" = ${org}
          FOR UPDATE OF screen`;
        if (!locked)
          return { created: false as const, reason: "NOT_FOUND" as const };
        await tx.pairingCode.updateMany({
          where: {
            organizationId: org,
            status: "PENDING",
            expiresAt: { lte: locked.databaseNow },
            OR: [{ codeHash }, { targetScreenId: screenId }],
          },
          data: { status: "EXPIRED" },
        });
        const superseded = await tx.pairingCode.findMany({
          where: {
            organizationId: org,
            targetScreenId: screenId,
            purpose: "REENROLL",
            status: "PENDING",
          },
          select: { id: true },
        });
        await tx.pairingAttempt.updateMany({
          where: {
            pairingCodeId: { in: superseded.map((grant) => grant.id) },
            consumedAt: null,
          },
          data: { cancelledAt: locked.databaseNow },
        });
        await tx.pairingCode.updateMany({
          where: { id: { in: superseded.map((grant) => grant.id) } },
          data: { status: "REVOKED" },
        });
        const live = await tx.deviceCredential.findFirst({
          where: {
            organizationId: org,
            screenId,
            liveScreenId: screenId,
            revokedAt: null,
          },
          orderBy: { createdAt: "desc" },
        });
        if (live) {
          await tx.deviceCredential.update({
            where: { id: live.id },
            data: {
              revokedAt: locked.databaseNow,
              liveScreenId: null,
              liveScreenOrganizationId: null,
            },
          });
          await tx.deviceAuthChallenge.updateMany({
            where: {
              credentialId: live.id,
              consumedAt: null,
              expiresAt: { gt: locked.databaseNow },
            },
            data: { consumedAt: locked.databaseNow },
          });
        }
        const generation = locked.credentialGeneration + 1;
        const grantExpiresAt = new Date(
          locked.databaseNow.getTime() + 10 * 60_000,
        );
        await tx.screen.update({
          where: { id: screenId },
          data: {
            credentialGeneration: generation,
            credentialRevokedAt: locked.databaseNow,
            deviceTokenHash: null,
            status: "OFFLINE",
          },
        });
        const pairing = await tx.pairingCode.create({
          data: {
            organizationId: org,
            codeHash,
            expiresAt: grantExpiresAt,
            purpose: "REENROLL",
            targetScreenId: screenId,
            targetScreenReferenceId: screenId,
            targetOrganizationId: org,
            expectedGeneration: generation,
            authorizedByUserId: audit.actorUserId,
            ...(live ? { priorCredentialId: live.id } : {}),
            requestReason: reason,
          },
        });
        await tx.auditEvent.create({
          data: {
            organizationId: org,
            actorUserId: audit.actorUserId,
            actorType: "user",
            action: "device.reenrollment.requested",
            entityType: "screen",
            entityId: screenId,
            ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
            ...(audit.requestId ? { requestId: audit.requestId } : {}),
            metadata: {
              grantId: pairing.id,
              expectedGeneration: generation,
              reason,
              supersededGrantIds: superseded.map((grant) => grant.id),
              ...(live
                ? { priorCredentialId: live.id, priorKeyId: live.keyId }
                : {}),
            },
          },
        });
        return { created: true as const, pairing: pairingDto(pairing) };
      });
    } catch (error) {
      if (isUniqueConstraintError(error))
        return { created: false as const, reason: "CODE_COLLISION" as const };
      throw error;
    }
  }
  async getReenrollmentStatus(
    org: string,
    screenId: string,
    grantId: string,
    actorUserId: string,
  ) {
    const actor = await this.prisma.membership.findFirst({
      where: {
        organizationId: org,
        userId: actorUserId,
        role: { in: ["OWNER", "ADMIN"] },
        user: { disabledAt: null },
      },
      select: { id: true },
    });
    if (!actor) return null;
    const grant = await this.prisma.pairingCode.findFirst({
      where: {
        id: grantId,
        organizationId: org,
        targetScreenId: screenId,
        purpose: "REENROLL",
      },
      select: { id: true, status: true, expiresAt: true },
    });
    if (!grant) return null;
    const attempts = await this.prisma.pairingAttempt.findMany({
      where: {
        pairingCodeId: grantId,
        organizationId: org,
        provedAt: { not: null },
        cancelledAt: null,
      },
      orderBy: { provedAt: "asc" },
    });
    const candidates = attempts.map((a) => ({
      id: a.id,
      grantId,
      screenId,
      keyId: a.keyId,
      fingerprint: a.keyId,
      securityLevel:
        a.securityLevel as ReenrollmentCandidateRecord["securityLevel"],
      installationId: a.installationId!,
      model: a.model!,
      osVersion: a.osVersion!,
      playerVersion: a.playerVersion!,
      provedAt: iso(a.provedAt)!,
      expiresAt: iso(a.expiresAt)!,
    }));
    return {
      grantId,
      screenId,
      status:
        grant.status === "PENDING" && grant.expiresAt <= new Date()
          ? ("EXPIRED" as const)
          : grant.status,
      expiresAt: iso(grant.expiresAt)!,
      candidates,
    };
  }
  async activateReenrollmentCandidateAndAudit(
    org: string,
    screenId: string,
    grantId: string,
    candidateId: string,
    audit: PairingCreateAuditContext,
  ): Promise<ReenrollmentActivationResult> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const [actor] = await tx.$queryRaw<
            Array<{ role: string }>
          >`SELECT membership."role"::text AS "role" FROM "Membership" membership INNER JOIN "User" actor ON actor."id" = membership."userId" WHERE membership."organizationId"=${org} AND membership."userId"=${audit.actorUserId} AND actor."disabledAt" IS NULL FOR UPDATE OF membership, actor`;
          if (actor?.role !== "OWNER" && actor?.role !== "ADMIN")
            return { activated: false as const, reason: "FORBIDDEN" as const };
          const [locked] = await tx.$queryRaw<
            Array<{
              id: string;
              credentialGeneration: number;
              databaseNow: Date;
            }>
          >`SELECT screen."id", screen."credentialGeneration", CURRENT_TIMESTAMP AS "databaseNow" FROM "Screen" screen WHERE screen."id"=${screenId} AND screen."organizationId"=${org} FOR UPDATE OF screen`;
          if (!locked)
            return { activated: false as const, reason: "NOT_FOUND" as const };
          const [grantLock] = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT pairing_grant."id" FROM "PairingCode" pairing_grant
            WHERE pairing_grant."id" = ${grantId} AND pairing_grant."organizationId" = ${org}
              AND pairing_grant."targetScreenId" = ${screenId}
              AND pairing_grant."purpose" = 'REENROLL'::"PairingPurpose"
            FOR UPDATE OF pairing_grant`;
          if (!grantLock)
            return { activated: false as const, reason: "NOT_FOUND" as const };
          const [attemptLock] = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT attempt."id" FROM "PairingAttempt" attempt
            WHERE attempt."id" = ${candidateId}
              AND attempt."pairingCodeId" = ${grantId}
              AND attempt."organizationId" = ${org}
            FOR UPDATE OF attempt`;
          if (!attemptLock)
            return { activated: false as const, reason: "NOT_FOUND" as const };
          const attempt = await tx.pairingAttempt.findUnique({
            where: { id: attemptLock.id },
            include: { pairingCode: true, boundCredential: true },
          });
          if (
            (attempt?.consumedAt || attempt?.activatedAt) &&
            attempt.boundCredential
          ) {
            if (
              attempt.boundCredential.revokedAt ||
              attempt.boundCredential.liveScreenId !== screenId ||
              attempt.pairingCode.expectedGeneration == null ||
              locked.credentialGeneration !==
                attempt.pairingCode.expectedGeneration + 1
            )
              return { activated: false as const, reason: "STALE" as const };
            return {
              activated: true as const,
              credential: deviceCredentialDto(attempt.boundCredential),
              screen: screenDto(
                await tx.screen.findUniqueOrThrow({ where: { id: screenId } }),
              ),
            };
          }
          if (
            !attempt ||
            !attempt.provedAt ||
            attempt.cancelledAt ||
            attempt.pairingCode.purpose !== "REENROLL" ||
            attempt.pairingCode.targetScreenId !== screenId
          )
            return { activated: false as const, reason: "NOT_FOUND" as const };
          const issuer = attempt.pairingCode.authorizedByUserId
            ? await tx.membership.findFirst({
                where: {
                  organizationId: org,
                  userId: attempt.pairingCode.authorizedByUserId,
                  role: { in: ["OWNER", "ADMIN"] },
                  user: { disabledAt: null },
                },
                select: { id: true },
              })
            : null;
          if (
            !issuer ||
            attempt.pairingCode.status !== "PENDING" ||
            attempt.pairingCode.expiresAt <= locked.databaseNow ||
            attempt.pairingCode.expectedGeneration !==
              locked.credentialGeneration
          )
            return { activated: false as const, reason: "STALE" as const };
          const claimed = await tx.pairingCode.updateMany({
            where: {
              id: grantId,
              organizationId: org,
              targetScreenId: screenId,
              purpose: "REENROLL",
              status: "PENDING",
              expectedGeneration: locked.credentialGeneration,
              expiresAt: { gt: locked.databaseNow },
            },
            data: { status: "CLAIMED", claimedAt: locked.databaseNow },
          });
          if (claimed.count !== 1)
            return { activated: false as const, reason: "STALE" as const };
          await tx.deviceKeyTombstone.create({
            data: { keyId: attempt.keyId },
          });
          const credential = await tx.deviceCredential.create({
            data: {
              organizationId: org,
              screenId,
              liveScreenId: screenId,
              liveScreenOrganizationId: org,
              keyId: attempt.keyId,
              publicKeySpki: attempt.publicKeySpki,
              algorithm: "ES256",
              securityLevel: attempt.securityLevel,
              expiresAt: attempt.credentialExpiresAt,
            },
          });
          const screen = await tx.screen.update({
            where: { id: screenId },
            data: {
              installationId: attempt.installationId,
              model: attempt.model,
              osVersion: attempt.osVersion,
              playerVersion: attempt.playerVersion,
              credentialRevokedAt: null,
              deviceTokenHash: null,
              credentialGeneration: { increment: 1 },
              status: "ONLINE",
              lastSeenAt: locked.databaseNow,
            },
          });
          await tx.pairingAttempt.update({
            where: { id: attempt.id },
            data: {
              activatedAt: locked.databaseNow,
              boundCredentialId: credential.id,
            },
          });
          await tx.pairingAttempt.updateMany({
            where: {
              pairingCodeId: grantId,
              id: { not: attempt.id },
              boundCredentialId: null,
            },
            data: { cancelledAt: locked.databaseNow },
          });
          await tx.pairingCode.update({
            where: { id: grantId },
            data: { screenId, screenOrganizationId: org },
          });
          const otherGrants = await tx.pairingCode.findMany({
            where: {
              organizationId: org,
              targetScreenId: screenId,
              status: "PENDING",
            },
            select: { id: true },
          });
          await tx.pairingAttempt.updateMany({
            where: {
              pairingCodeId: { in: otherGrants.map((g) => g.id) },
              boundCredentialId: null,
            },
            data: { cancelledAt: locked.databaseNow },
          });
          await tx.pairingCode.updateMany({
            where: { id: { in: otherGrants.map((g) => g.id) } },
            data: { status: "REVOKED" },
          });
          await tx.auditEvent.create({
            data: {
              organizationId: org,
              actorUserId: audit.actorUserId,
              actorType: "user",
              action: "device.reenrollment.activated",
              entityType: "screen",
              entityId: screenId,
              ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
              ...(audit.requestId ? { requestId: audit.requestId } : {}),
              metadata: {
                grantId,
                candidateId,
                credentialId: credential.id,
                keyId: credential.keyId,
                reason: attempt.pairingCode.requestReason,
              },
            },
          });
          return {
            activated: true as const,
            screen: screenDto(screen),
            credential: deviceCredentialDto(credential),
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isRetryableWriteConflict(error) || isUniqueConstraintError(error)) {
        const completed = await this.prisma.pairingAttempt.findFirst({
          where: {
            id: candidateId,
            pairingCodeId: grantId,
            organizationId: org,
            activatedAt: { not: null },
          },
          include: { pairingCode: true, boundCredential: true },
        });
        const screen = await this.prisma.screen.findFirst({
          where: { id: screenId, organizationId: org },
        });
        if (
          completed?.boundCredential &&
          screen &&
          !completed.boundCredential.revokedAt &&
          completed.boundCredential.liveScreenId === screenId &&
          completed.pairingCode.expectedGeneration != null &&
          screen.credentialGeneration ===
            completed.pairingCode.expectedGeneration + 1
        )
          return {
            activated: true,
            credential: deviceCredentialDto(completed.boundCredential),
            screen: screenDto(screen),
          };
        return { activated: false, reason: "STALE" };
      }
      throw error;
    }
  }
  async cancelScreenReenrollmentAndAudit(
    org: string,
    screenId: string,
    grantId: string,
    audit: PairingCreateAuditContext,
  ) {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const [actor] = await tx.$queryRaw<Array<{ role: string }>>`
          SELECT membership."role"::text AS "role" FROM "Membership" membership
          INNER JOIN "User" actor ON actor."id" = membership."userId"
          WHERE membership."organizationId" = ${org}
            AND membership."userId" = ${audit.actorUserId}
            AND actor."disabledAt" IS NULL
          FOR UPDATE OF membership, actor`;
          if (actor?.role !== "OWNER" && actor?.role !== "ADMIN")
            return { cancelled: false as const, reason: "FORBIDDEN" as const };
          const [screen] = await tx.$queryRaw<
            Array<{ id: string; databaseNow: Date }>
          >`
          SELECT screen."id", CURRENT_TIMESTAMP AS "databaseNow" FROM "Screen" screen
          WHERE screen."id" = ${screenId} AND screen."organizationId" = ${org}
          FOR UPDATE OF screen`;
          if (!screen)
            return { cancelled: false as const, reason: "NOT_FOUND" as const };
          const [grant] = await tx.$queryRaw<
            Array<{ id: string; status: string }>
          >`
          SELECT pairing_grant."id", pairing_grant."status"::text AS "status" FROM "PairingCode" pairing_grant
          WHERE pairing_grant."id" = ${grantId} AND pairing_grant."organizationId" = ${org}
            AND pairing_grant."targetScreenId" = ${screenId}
            AND pairing_grant."purpose" = 'REENROLL'::"PairingPurpose"
          FOR UPDATE OF pairing_grant`;
          if (!grant || grant.status !== "PENDING")
            return { cancelled: false as const, reason: "NOT_FOUND" as const };
          await tx.$queryRaw<Array<{ id: string }>>`
          SELECT attempt."id" FROM "PairingAttempt" attempt
          WHERE attempt."pairingCodeId" = ${grantId}
          ORDER BY attempt."id" FOR UPDATE OF attempt`;
          const revoked = await tx.pairingCode.updateMany({
            where: {
              id: grantId,
              organizationId: org,
              targetScreenId: screenId,
              purpose: "REENROLL",
              status: "PENDING",
            },
            data: { status: "REVOKED" },
          });
          if (revoked.count !== 1)
            return { cancelled: false as const, reason: "NOT_FOUND" as const };
          await tx.pairingAttempt.updateMany({
            where: { pairingCodeId: grantId, boundCredentialId: null },
            data: { cancelledAt: screen.databaseNow },
          });
          await tx.auditEvent.create({
            data: {
              organizationId: org,
              actorUserId: audit.actorUserId,
              actorType: "user",
              action: "device.reenrollment.cancelled",
              entityType: "screen",
              entityId: screenId,
              ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
              ...(audit.requestId ? { requestId: audit.requestId } : {}),
              metadata: { grantId },
            },
          });
          return { cancelled: true as const };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isRetryableWriteConflict(error))
        return { cancelled: false as const, reason: "NOT_FOUND" as const };
      throw error;
    }
  }
  async claimPairing(
    codeHash: string,
    device: {
      installationId: string;
      model: string;
      osVersion: string;
      playerVersion: string;
    },
    tokenHash: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const p = await tx.pairingCode.findFirst({
        where: { codeHash, status: "PENDING", purpose: "NEW_SCREEN" },
        orderBy: { createdAt: "desc" },
      });
      if (!p || p.status !== "PENDING" || p.expiresAt <= new Date())
        return null;
      const claimed = await tx.pairingCode.updateMany({
        where: { id: p.id, status: "PENDING", expiresAt: { gt: new Date() } },
        data: { status: "CLAIMED", claimedAt: new Date() },
      });
      if (claimed.count !== 1) return null;
      const x = await tx.screen.create({
        data: {
          organizationId: p.organizationId,
          name: `New screen ${device.installationId.slice(-6)}`,
          location: "Unassigned",
          installationId: device.installationId,
          model: device.model,
          osVersion: device.osVersion,
          playerVersion: device.playerVersion,
          deviceTokenHash: tokenHash,
          status: "ONLINE",
          lastSeenAt: new Date(),
        },
      });
      await tx.pairingCode.update({
        where: { id: p.id },
        data: { screenId: x.id, screenOrganizationId: p.organizationId },
      });
      return screenDto(x);
    });
  }
  async claimPairingAndAudit(
    codeHash: string,
    device: {
      installationId: string;
      model: string;
      osVersion: string;
      playerVersion: string;
    },
    tokenHash: string,
    audit: PairingClaimAuditContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const p = await tx.pairingCode.findFirst({
        where: { codeHash, status: "PENDING", purpose: "NEW_SCREEN" },
        orderBy: { createdAt: "desc" },
      });
      if (!p || p.expiresAt <= new Date()) return null;
      const claimed = await tx.pairingCode.updateMany({
        where: { id: p.id, status: "PENDING", expiresAt: { gt: new Date() } },
        data: { status: "CLAIMED", claimedAt: new Date() },
      });
      if (claimed.count !== 1) return null;
      const screen = await tx.screen.create({
        data: {
          organizationId: p.organizationId,
          name: `New screen ${device.installationId.slice(-6)}`,
          location: "Unassigned",
          installationId: device.installationId,
          model: device.model,
          osVersion: device.osVersion,
          playerVersion: device.playerVersion,
          deviceTokenHash: tokenHash,
          status: "ONLINE",
          lastSeenAt: new Date(),
        },
      });
      await tx.pairingCode.update({
        where: { id: p.id },
        data: {
          screenId: screen.id,
          screenOrganizationId: p.organizationId,
        },
      });
      await tx.auditEvent.create({
        data: {
          organizationId: p.organizationId,
          actorType: "device",
          action: "device.paired",
          entityType: "screen",
          entityId: screen.id,
          ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
          ...(audit.requestId ? { requestId: audit.requestId } : {}),
          metadata: {
            ...audit.metadata,
            installationId: device.installationId,
          },
        },
      });
      return screenDto(screen);
    });
  }
  async issuePairingChallenge(input: {
    codeHash: string;
    credential: DeviceCredentialEnrollment;
    challengeHashSha256: string;
    transcriptDigestSha256: string;
    expiresAt: string;
  }) {
    const expiresAt = new Date(input.expiresAt);
    if (!Number.isFinite(expiresAt.getTime())) return null;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<
          Array<{ id: string; databaseNow: Date }>
        >`
          SELECT pairing."id", CURRENT_TIMESTAMP AS "databaseNow"
          FROM "PairingCode" AS pairing
          WHERE pairing."codeHash" = ${input.codeHash}
            AND pairing."status" = 'PENDING'::"PairingStatus"
            AND pairing."expiresAt" > CURRENT_TIMESTAMP
          ORDER BY pairing."createdAt" DESC
          LIMIT 1
          FOR UPDATE OF pairing`;
        const pairing = locked
          ? await tx.pairingCode.findUnique({ where: { id: locked.id } })
          : null;
        if (!pairing) return null;
        if (
          expiresAt <= locked!.databaseNow ||
          expiresAt.getTime() - locked!.databaseNow.getTime() > 45_000
        )
          return null;
        if (
          await tx.deviceKeyTombstone.findUnique({
            where: { keyId: input.credential.keyId },
            select: { keyId: true },
          })
        )
          return null;
        if (
          (await tx.pairingAttempt.count({
            where: {
              pairingCodeId: pairing.id,
              keyId: input.credential.keyId,
              consumedAt: null,
              expiresAt: { gt: locked!.databaseNow },
            },
          })) >= 4
        )
          return null;
        const attempt = await tx.pairingAttempt.create({
          data: {
            id: randomToken(),
            organizationId: pairing.organizationId,
            pairingCodeId: pairing.id,
            keyId: input.credential.keyId,
            publicKeySpki: Buffer.from(
              input.credential.publicKeySpki,
              "base64url",
            ),
            algorithm: input.credential.algorithm,
            securityLevel: input.credential.securityLevel,
            credentialExpiresAt: input.credential.expiresAt
              ? new Date(input.credential.expiresAt)
              : null,
            challengeHashSha256: input.challengeHashSha256,
            transcriptDigestSha256: input.transcriptDigestSha256,
            expiresAt,
            createdAt: locked!.databaseNow,
          },
        });
        return pairingAttemptDto(attempt);
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) return null;
      throw error;
    }
  }
  async claimPairingWithCredentialAndAudit(
    input: {
      codeHash: string;
      pairingAttemptId: string;
      challengeHashSha256: string;
      transcriptDigestSha256: string;
      keyId: string;
      device: {
        installationId: string;
        model: string;
        osVersion: string;
        playerVersion: string;
      };
    },
    verify: PairingProofVerifier,
    audit: PairingClaimAuditContext,
  ) {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const [locked] = await tx.$queryRaw<
            Array<{ id: string; databaseNow: Date }>
          >`
            SELECT attempt."id", CURRENT_TIMESTAMP AS "databaseNow"
            FROM "PairingAttempt" AS attempt
            INNER JOIN "PairingCode" AS pairing
              ON pairing."id" = attempt."pairingCodeId"
              AND pairing."organizationId" = attempt."organizationId"
            WHERE attempt."id" = ${input.pairingAttemptId}
              AND pairing."codeHash" = ${input.codeHash}
            FOR UPDATE OF attempt, pairing`;
          if (!locked)
            return { paired: false as const, reason: "INVALID" as const };
          const attempt = await tx.pairingAttempt.findUnique({
            where: { id: locked.id },
            include: {
              pairingCode: true,
              boundCredential: { include: { liveScreen: true } },
            },
          });
          if (
            !attempt ||
            attempt.challengeHashSha256 !== input.challengeHashSha256 ||
            attempt.transcriptDigestSha256 !== input.transcriptDigestSha256 ||
            attempt.keyId !== input.keyId
          )
            return { paired: false as const, reason: "INVALID" as const };
          const enrollment: DeviceCredentialEnrollment = {
            keyId: attempt.keyId,
            publicKeySpki: Buffer.from(attempt.publicKeySpki).toString(
              "base64url",
            ),
            algorithm: "ES256",
            securityLevel:
              attempt.securityLevel as DeviceCredentialEnrollment["securityLevel"],
            ...(attempt.credentialExpiresAt
              ? { expiresAt: iso(attempt.credentialExpiresAt) }
              : {}),
          };
          if (!(await verify(enrollment)))
            return { paired: false as const, reason: "INVALID" as const };

          if (
            (attempt.consumedAt || attempt.activatedAt) &&
            attempt.boundCredential &&
            !attempt.boundCredential.revokedAt &&
            (!attempt.boundCredential.expiresAt ||
              attempt.boundCredential.expiresAt > locked.databaseNow)
          ) {
            const screen = attempt.boundCredential.liveScreen;
            return screen
              ? {
                  paired: true as const,
                  screen: screenDto(screen),
                  credential: deviceCredentialDto(attempt.boundCredential),
                }
              : { paired: false as const, reason: "INVALID" as const };
          }
          if (
            attempt.pairingCode.purpose === "REENROLL" &&
            attempt.provedAt &&
            !attempt.cancelledAt &&
            attempt.pairingCode.status === "PENDING" &&
            attempt.pairingCode.expiresAt > locked.databaseNow
          ) {
            return {
              paired: false as const,
              reason: "PENDING_APPROVAL" as const,
              grantId: attempt.pairingCode.id,
              candidateId: attempt.id,
              keyId: attempt.keyId,
              expiresAt: iso(attempt.pairingCode.expiresAt)!,
            };
          }
          const currentTime = locked.databaseNow;
          if (
            attempt.consumedAt ||
            attempt.expiresAt <= currentTime ||
            attempt.pairingCode.status !== "PENDING" ||
            attempt.pairingCode.expiresAt <= currentTime
          )
            return { paired: false as const, reason: "INVALID" as const };
          if (attempt.pairingCode.purpose === "REENROLL") {
            const issuer = attempt.pairingCode.authorizedByUserId
              ? await tx.membership.findFirst({
                  where: {
                    organizationId: attempt.organizationId,
                    userId: attempt.pairingCode.authorizedByUserId,
                    role: { in: ["OWNER", "ADMIN"] },
                    user: { disabledAt: null },
                  },
                  select: { id: true },
                })
              : null;
            if (
              !attempt.pairingCode.targetScreenId ||
              !issuer ||
              attempt.cancelledAt ||
              (await tx.pairingAttempt.count({
                where: {
                  pairingCodeId: attempt.pairingCodeId,
                  provedAt: { not: null },
                  cancelledAt: null,
                },
              })) >= 4
            )
              return { paired: false as const, reason: "INVALID" as const };
            await tx.pairingAttempt.update({
              where: { id: attempt.id },
              data: {
                provedAt: currentTime,
                installationId: input.device.installationId,
                model: input.device.model,
                osVersion: input.device.osVersion,
                playerVersion: input.device.playerVersion,
              },
            });
            await tx.auditEvent.create({
              data: {
                organizationId: attempt.organizationId,
                actorType: "device",
                action: "device.reenrollment.candidate_proved",
                entityType: "screen",
                entityId: attempt.pairingCode.targetScreenId,
                ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
                ...(audit.requestId ? { requestId: audit.requestId } : {}),
                metadata: {
                  grantId: attempt.pairingCode.id,
                  candidateId: attempt.id,
                  keyId: attempt.keyId,
                  installationId: input.device.installationId,
                },
              },
            });
            return {
              paired: false as const,
              reason: "PENDING_APPROVAL" as const,
              grantId: attempt.pairingCode.id,
              candidateId: attempt.id,
              keyId: attempt.keyId,
              expiresAt: iso(attempt.pairingCode.expiresAt)!,
            };
          }
          const claimed = await tx.pairingCode.updateMany({
            where: {
              id: attempt.pairingCodeId,
              organizationId: attempt.organizationId,
              status: "PENDING",
              expiresAt: { gt: currentTime },
            },
            data: { status: "CLAIMED", claimedAt: currentTime },
          });
          if (claimed.count !== 1)
            return { paired: false as const, reason: "INVALID" as const };
          const screen = await tx.screen.create({
            data: {
              organizationId: attempt.organizationId,
              name: `New screen ${input.device.installationId.slice(-6)}`,
              location: "Unassigned",
              installationId: input.device.installationId,
              model: input.device.model,
              osVersion: input.device.osVersion,
              playerVersion: input.device.playerVersion,
              status: "ONLINE",
              lastSeenAt: currentTime,
            },
          });
          await tx.deviceKeyTombstone.create({
            data: { keyId: attempt.keyId },
          });
          const credential = await tx.deviceCredential.create({
            data: {
              organizationId: attempt.organizationId,
              screenId: screen.id,
              liveScreenId: screen.id,
              liveScreenOrganizationId: attempt.organizationId,
              keyId: attempt.keyId,
              publicKeySpki: attempt.publicKeySpki,
              algorithm: "ES256",
              securityLevel: attempt.securityLevel,
              expiresAt: attempt.credentialExpiresAt,
            },
          });
          await tx.pairingCode.update({
            where: { id: attempt.pairingCodeId },
            data: {
              screenId: screen.id,
              screenOrganizationId: attempt.organizationId,
            },
          });
          await tx.pairingAttempt.update({
            where: { id: attempt.id },
            data: {
              consumedAt: currentTime,
              boundCredentialId: credential.id,
            },
          });
          await tx.auditEvent.create({
            data: {
              organizationId: attempt.organizationId,
              actorType: "device",
              action: "device.paired",
              entityType: "screen",
              entityId: screen.id,
              ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
              ...(audit.requestId ? { requestId: audit.requestId } : {}),
              metadata: {
                ...audit.metadata,
                installationId: input.device.installationId,
                credentialId: credential.id,
                keyId: credential.keyId,
                pairingAttemptId: attempt.id,
              },
            },
          });
          return {
            paired: true as const,
            screen: screenDto(screen),
            credential: deviceCredentialDto(credential),
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    } catch (error) {
      if (isUniqueConstraintError(error) || isRetryableWriteConflict(error))
        return { paired: false as const, reason: "INVALID" as const };
      throw error;
    }
  }
  async authenticateDevice(id: string) {
    const x = await this.prisma.screen.findFirst({
      where: { id, credentialRevokedAt: null },
    });
    return x?.deviceTokenHash ? screenDto(x, true) : null;
  }
  async authenticateDeviceCredential(screenId: string, keyId: string) {
    const currentTime = new Date();
    const credential = await this.prisma.deviceCredential.findFirst({
      where: {
        screenId,
        liveScreenId: screenId,
        keyId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: currentTime } }],
      },
      include: { liveScreen: true },
    });
    return credential?.liveScreen
      ? {
          authenticated: true as const,
          credential: deviceCredentialDto(credential),
          screen: screenDto(credential.liveScreen),
        }
      : { authenticated: false as const, reason: "INVALID_PROOF" as const };
  }
  async issueDeviceAuthChallenge(input: {
    screenId: string;
    keyId: string;
    challengeHashSha256: string;
    operation: "heartbeat" | "manifest";
    requestDigestSha256: string;
    expiresAt: string;
  }) {
    const expiresAt = new Date(input.expiresAt);
    if (!Number.isFinite(expiresAt.getTime())) return null;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const [screenLock] = await tx.$queryRaw<
          Array<{ id: string; organizationId: string; databaseNow: Date }>
        >`
          SELECT screen."id", screen."organizationId", CURRENT_TIMESTAMP AS "databaseNow"
          FROM "Screen" screen WHERE screen."id" = ${input.screenId}
          FOR UPDATE OF screen`;
        if (!screenLock) return null;
        const [locked] = await tx.$queryRaw<
          Array<{ id: string; organizationId: string; databaseNow: Date }>
        >`
          SELECT credential."id", credential."organizationId",
            CURRENT_TIMESTAMP AS "databaseNow"
          FROM "DeviceCredential" AS credential
          WHERE credential."screenId" = ${input.screenId}
            AND credential."liveScreenId" = ${input.screenId}
            AND credential."liveScreenOrganizationId" = ${screenLock.organizationId}
            AND credential."keyId" = ${input.keyId}
            AND credential."revokedAt" IS NULL
            AND (credential."expiresAt" IS NULL OR credential."expiresAt" > CURRENT_TIMESTAMP)
          FOR UPDATE OF credential`;
        if (!locked) return null;
        if (
          expiresAt <= locked.databaseNow ||
          expiresAt.getTime() - locked.databaseNow.getTime() > 60_000
        )
          return null;
        const operation = input.operation.toUpperCase() as
          "HEARTBEAT" | "MANIFEST";
        if (
          (await tx.deviceAuthChallenge.count({
            where: {
              credentialId: locked.id,
              operation,
              consumedAt: null,
              expiresAt: { gt: locked.databaseNow },
            },
          })) >= 4
        )
          return null;
        const challenge = await tx.deviceAuthChallenge.create({
          data: {
            id: randomToken(),
            organizationId: locked.organizationId,
            credentialId: locked.id,
            challengeHashSha256: input.challengeHashSha256,
            operation,
            requestDigestSha256: input.requestDigestSha256,
            expiresAt,
            createdAt: locked.databaseNow,
          },
        });
        return deviceChallengeDto(challenge);
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) return null;
      throw error;
    }
  }
  private async consumeDeviceProofInTransaction(
    tx: Prisma.TransactionClient,
    input: DeviceProofInput,
    verify: DeviceProofVerifier,
  ) {
    const candidate = await tx.deviceCredential.findUnique({
      where: { id: input.credentialId },
      select: { liveScreenId: true, liveScreenOrganizationId: true },
    });
    if (!candidate?.liveScreenId || !candidate.liveScreenOrganizationId)
      return null;
    const [screenLock] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT screen."id" FROM "Screen" screen
      WHERE screen."id" = ${candidate.liveScreenId}
        AND screen."organizationId" = ${candidate.liveScreenOrganizationId}
      FOR UPDATE OF screen`;
    if (!screenLock) return null;
    const [lockedCredential] = await tx.$queryRaw<
      Array<{ id: string; databaseNow: Date }>
    >`
      SELECT credential."id", CURRENT_TIMESTAMP AS "databaseNow"
      FROM "DeviceCredential" AS credential
      WHERE credential."id" = ${input.credentialId}
        AND credential."liveScreenId" = ${candidate.liveScreenId}
        AND credential."liveScreenOrganizationId" = ${candidate.liveScreenOrganizationId}
        AND credential."revokedAt" IS NULL
        AND (credential."expiresAt" IS NULL OR credential."expiresAt" > CURRENT_TIMESTAMP)
      FOR UPDATE OF credential`;
    if (!lockedCredential) return null;
    const [lockedChallenge] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT challenge."id"
      FROM "DeviceAuthChallenge" AS challenge
      WHERE challenge."id" = ${input.challengeId}
        AND challenge."credentialId" = ${input.credentialId}
      FOR UPDATE OF challenge`;
    if (!lockedChallenge) return null;
    const [credential, challenge] = await Promise.all([
      tx.deviceCredential.findUnique({
        where: { id: lockedCredential.id },
        include: { liveScreen: true },
      }),
      tx.deviceAuthChallenge.findUnique({
        where: { id: lockedChallenge.id },
      }),
    ]);
    const currentTime = lockedCredential.databaseNow;
    if (
      !credential?.liveScreen ||
      !challenge ||
      challenge.organizationId !== credential.organizationId ||
      challenge.consumedAt ||
      challenge.expiresAt <= currentTime ||
      challenge.challengeHashSha256 !== input.challengeHashSha256 ||
      enumLower(challenge.operation) !== input.operation ||
      challenge.requestDigestSha256 !== input.requestDigestSha256 ||
      !(await verify(deviceCredentialDto(credential)))
    )
      return null;
    const consumed = await tx.deviceAuthChallenge.updateMany({
      where: {
        id: challenge.id,
        credentialId: credential.id,
        consumedAt: null,
        expiresAt: { gt: currentTime },
      },
      data: { consumedAt: currentTime },
    });
    return consumed.count === 1
      ? { credential, screen: credential.liveScreen }
      : null;
  }
  async consumeDeviceAuthChallenge(
    input: DeviceProofInput,
    verify: DeviceProofVerifier,
  ) {
    const consumed = await this.prisma.$transaction((tx) =>
      this.consumeDeviceProofInTransaction(tx, input, verify),
    );
    return consumed
      ? {
          authenticated: true as const,
          credential: deviceCredentialDto(consumed.credential),
          screen: screenDto(consumed.screen),
        }
      : { authenticated: false as const, reason: "INVALID_PROOF" as const };
  }
  async heartbeatWithDeviceProof(
    input: DeviceProofInput,
    data: HeartbeatUpdateInput,
    verify: DeviceProofVerifier,
  ) {
    const consumed = await this.prisma.$transaction(async (tx) => {
      const authenticated = await this.consumeDeviceProofInTransaction(
        tx,
        input,
        verify,
      );
      if (!authenticated) return null;
      const allowed = {
        playerVersion: data.playerVersion,
        manifestVersion: data.manifestVersion,
        nowPlayingAssetId: data.nowPlayingAssetId,
        uptimeSeconds: BigInt(data.uptimeSeconds),
        freeStorageBytes: BigInt(data.freeStorageBytes),
        networkType: data.networkType,
        lastSeenAt: new Date(),
        status: "ONLINE" as const,
      };
      const screen = await tx.screen.update({
        where: { id: authenticated.screen.id },
        data: allowed,
      });
      return { credential: authenticated.credential, screen };
    });
    return consumed
      ? {
          authenticated: true as const,
          credential: deviceCredentialDto(consumed.credential),
          screen: screenDto(consumed.screen),
        }
      : { authenticated: false as const, reason: "INVALID_PROOF" as const };
  }
  async revokeDeviceCredentialAndAudit(
    org: string,
    screenId: string,
    audit: DeviceCredentialRevokeAuditContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const [actor] = await tx.$queryRaw<Array<{ role: string }>>`
        SELECT membership."role"::text AS "role"
        FROM "Membership" AS membership
        INNER JOIN "User" AS actor ON actor."id" = membership."userId"
        WHERE membership."organizationId" = ${org}
          AND membership."userId" = ${audit.actorUserId}
          AND actor."disabledAt" IS NULL
        FOR UPDATE OF membership, actor`;
      if (actor?.role !== "OWNER" && actor?.role !== "ADMIN")
        return { revoked: false as const, reason: "FORBIDDEN" as const };
      const [screenLock] = await tx.$queryRaw<
        Array<{ id: string; databaseNow: Date }>
      >`
        SELECT screen."id", CURRENT_TIMESTAMP AS "databaseNow"
        FROM "Screen" screen
        WHERE screen."id" = ${screenId} AND screen."organizationId" = ${org}
        FOR UPDATE OF screen`;
      if (!screenLock)
        return { revoked: false as const, reason: "NOT_FOUND" as const };
      const [locked] = await tx.$queryRaw<
        Array<{ id: string; databaseNow: Date }>
      >`
        SELECT credential."id", CURRENT_TIMESTAMP AS "databaseNow"
        FROM "DeviceCredential" AS credential
        WHERE credential."organizationId" = ${org}
          AND credential."screenId" = ${screenId}
          AND credential."liveScreenId" = ${screenId}
          AND credential."revokedAt" IS NULL
        ORDER BY credential."createdAt" DESC
        LIMIT 1
        FOR UPDATE OF credential`;
      if (!locked) {
        const existing = await tx.deviceCredential.findFirst({
          where: { organizationId: org, screenId, revokedAt: { not: null } },
          orderBy: { createdAt: "desc" },
        });
        const grants = await tx.pairingCode.findMany({
          where: {
            organizationId: org,
            targetScreenId: screenId,
            purpose: "REENROLL",
            status: "PENDING",
          },
          select: { id: true },
        });
        if (grants.length === 0 && !existing)
          return { revoked: false as const, reason: "NOT_FOUND" as const };
        if (grants.length === 0)
          return {
            revoked: false as const,
            reason: "ALREADY_REVOKED" as const,
          };
        await tx.pairingAttempt.updateMany({
          where: {
            pairingCodeId: { in: grants.map((grant) => grant.id) },
            consumedAt: null,
          },
          data: { cancelledAt: screenLock.databaseNow },
        });
        await tx.pairingCode.updateMany({
          where: { id: { in: grants.map((grant) => grant.id) } },
          data: { status: "REVOKED" },
        });
        await tx.screen.update({
          where: { id: screenId },
          data: {
            credentialGeneration: { increment: 1 },
            credentialRevokedAt: screenLock.databaseNow,
            deviceTokenHash: null,
            status: "OFFLINE",
          },
        });
        await tx.auditEvent.create({
          data: {
            organizationId: org,
            actorUserId: audit.actorUserId,
            actorType: "user",
            action: "device.credential.revocation_reasserted",
            entityType: existing ? "device_credential" : "screen",
            entityId: existing?.id ?? screenId,
            ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
            ...(audit.requestId ? { requestId: audit.requestId } : {}),
            metadata: {
              screenId,
              cancelledGrantIds: grants.map((grant) => grant.id),
            },
          },
        });
        return {
          revoked: true as const,
          ...(existing ? { credential: deviceCredentialDto(existing) } : {}),
        };
      }
      const revokedAt = locked.databaseNow;
      const credential = await tx.deviceCredential.update({
        where: { id: locked.id },
        data: {
          revokedAt,
          liveScreenId: null,
          liveScreenOrganizationId: null,
        },
      });
      await tx.screen.update({
        where: { id: screenId },
        data: {
          credentialRevokedAt: revokedAt,
          deviceTokenHash: null,
          credentialGeneration: { increment: 1 },
          status: "OFFLINE",
        },
      });
      await tx.deviceAuthChallenge.updateMany({
        where: {
          credentialId: credential.id,
          consumedAt: null,
          expiresAt: { gt: revokedAt },
        },
        data: { consumedAt: revokedAt },
      });
      const grants = await tx.pairingCode.findMany({
        where: {
          organizationId: org,
          targetScreenId: screenId,
          purpose: "REENROLL",
          status: "PENDING",
        },
        select: { id: true },
      });
      await tx.pairingAttempt.updateMany({
        where: {
          pairingCodeId: { in: grants.map((grant) => grant.id) },
          consumedAt: null,
        },
        data: { cancelledAt: revokedAt },
      });
      await tx.pairingCode.updateMany({
        where: { id: { in: grants.map((grant) => grant.id) } },
        data: { status: "REVOKED" },
      });
      await tx.auditEvent.create({
        data: {
          organizationId: org,
          actorUserId: audit.actorUserId,
          actorType: "user",
          action: "device.credential.revoked",
          entityType: "device_credential",
          entityId: credential.id,
          ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
          ...(audit.requestId ? { requestId: audit.requestId } : {}),
          metadata: { screenId, keyId: credential.keyId },
        },
      });
      return {
        revoked: true as const,
        credential: deviceCredentialDto(credential),
      };
    });
  }
  async heartbeat(id: string, data: HeartbeatUpdateInput) {
    const x = await this.prisma.screen.findUnique({ where: { id } });
    if (!x) return null;
    const allowed = {
      playerVersion: data.playerVersion,
      manifestVersion: data.manifestVersion,
      nowPlayingAssetId: data.nowPlayingAssetId,
      uptimeSeconds: BigInt(data.uptimeSeconds),
      freeStorageBytes: BigInt(data.freeStorageBytes),
      networkType: data.networkType,
      lastSeenAt: new Date(),
      status: "ONLINE" as const,
    };
    return screenDto(
      await this.prisma.screen.update({ where: { id }, data: allowed }),
    );
  }
  async listMedia(org: string) {
    return (
      await this.prisma.mediaAsset.findMany({
        where: { organizationId: org },
        orderBy: { createdAt: "desc" },
      })
    ).map((x) => mediaDto(x));
  }
  async createMedia(
    org: string,
    data: Omit<
      MediaRecord,
      "id" | "organizationId" | "createdAt" | "updatedAt"
    >,
  ) {
    const assetId = randomUUID();
    return mediaDto(
      await this.prisma.mediaAsset.create({
        data: {
          id: assetId,
          organizationId: org,
          storageKey: mediaStorageKey(org, assetId, data.checksumSha256),
          name: data.name,
          kind: data.kind.toUpperCase() as
            "IMAGE" | "VIDEO" | "WEB" | "TEMPLATE",
          mimeType: data.mimeType,
          url: data.url,
          checksumSha256: data.checksumSha256,
          sizeBytes: BigInt(data.sizeBytes),
          durationSeconds: data.durationSeconds ?? null,
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        },
      }),
    );
  }
  async createMediaAndAudit(
    org: string,
    data: Omit<
      MediaRecord,
      "id" | "organizationId" | "createdAt" | "updatedAt"
    >,
    audit: UserMutationAuditContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const role = await this.lockActiveActorRole(tx, org, audit.actorUserId);
      if (role !== "OWNER" && role !== "ADMIN" && role !== "PUBLISHER")
        return { created: false as const, reason: "FORBIDDEN" as const };
      const assetId = randomUUID();
      const media = await tx.mediaAsset.create({
        data: {
          id: assetId,
          organizationId: org,
          storageKey: mediaStorageKey(org, assetId, data.checksumSha256),
          name: data.name,
          kind: data.kind.toUpperCase() as
            "IMAGE" | "VIDEO" | "WEB" | "TEMPLATE",
          mimeType: data.mimeType,
          url: data.url,
          checksumSha256: data.checksumSha256,
          sizeBytes: BigInt(data.sizeBytes),
          durationSeconds: data.durationSeconds ?? null,
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        },
      });
      await tx.auditEvent.create({
        data: {
          organizationId: org,
          actorUserId: audit.actorUserId,
          actorType: "user",
          action: "media.created",
          entityType: "media",
          entityId: media.id,
          ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
          ...(audit.requestId ? { requestId: audit.requestId } : {}),
          metadata: { name: media.name },
        },
      });
      return { created: true as const, value: mediaDto(media) };
    });
  }
  async getMedia(org: string, id: string) {
    const x = await this.prisma.mediaAsset.findFirst({
      where: { id, organizationId: org },
    });
    return x ? mediaDto(x) : null;
  }
  async deleteMedia(org: string, id: string): Promise<DeleteResult> {
    try {
      const r = await this.prisma.mediaAsset.deleteMany({
        where: { id, organizationId: org },
      });
      return r.count > 0 ? "DELETED" : "NOT_FOUND";
    } catch (error) {
      if (isForeignKeyConstraintError(error)) return "IN_USE";
      throw error;
    }
  }
  async deleteMediaAndAudit(
    org: string,
    id: string,
    audit: UserMutationAuditContext,
  ) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const role = await this.lockActiveActorRole(tx, org, audit.actorUserId);
        if (role !== "OWNER" && role !== "ADMIN" && role !== "PUBLISHER")
          return { deleted: false as const, reason: "FORBIDDEN" as const };
        const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT media."id"
          FROM "MediaAsset" media
          WHERE media."id" = ${id} AND media."organizationId" = ${org}
          FOR UPDATE OF media`;
        if (!locked)
          return { deleted: false as const, reason: "NOT_FOUND" as const };
        const playlistReference = await tx.playlistItem.findFirst({
          where: { organizationId: org, assetId: id },
          select: { id: true },
        });
        if (playlistReference)
          return { deleted: false as const, reason: "IN_USE" as const };
        const releaseReference = await tx.frozenReleaseItem.findFirst({
          where: { organizationId: org, sourceAssetId: id },
          select: { id: true },
        });
        if (releaseReference)
          return { deleted: false as const, reason: "IN_USE" as const };
        await tx.mediaAsset.delete({ where: { id } });
        await tx.auditEvent.create({
          data: {
            organizationId: org,
            actorUserId: audit.actorUserId,
            actorType: "user",
            action: "media.deleted",
            entityType: "media",
            entityId: id,
            ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
            ...(audit.requestId ? { requestId: audit.requestId } : {}),
            metadata: {},
          },
        });
        return { deleted: true as const };
      });
    } catch (error) {
      if (isForeignKeyConstraintError(error))
        return { deleted: false as const, reason: "IN_USE" as const };
      throw error;
    }
  }
  async listPlaylists(org: string) {
    return (
      await this.prisma.playlist.findMany({
        where: { organizationId: org },
        include: { items: true },
      })
    ).map((x) => playlistDto(x));
  }
  async createPlaylist(
    org: string,
    data: Pick<PlaylistRecord, "name" | "description" | "items">,
  ) {
    return playlistDto(
      await this.prisma.playlist.create({
        data: {
          organizationId: org,
          name: data.name,
          description: data.description,
          items: {
            create: data.items.map((i) => ({
              assetId: i.assetId,
              position: i.position,
              durationSeconds: i.durationSeconds,
            })),
          },
        },
        include: { items: true },
      }),
    );
  }
  async createPlaylistAndAudit(
    org: string,
    data: Pick<PlaylistRecord, "name" | "description" | "items">,
    audit: UserMutationAuditContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const role = await this.lockActiveActorRole(tx, org, audit.actorUserId);
      if (role !== "OWNER" && role !== "ADMIN" && role !== "PUBLISHER")
        return { created: false as const, reason: "FORBIDDEN" as const };
      const assetIds = [
        ...new Set(data.items.map((item) => item.assetId)),
      ].sort();
      if (assetIds.length > 0) {
        const assets = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT media."id"
          FROM "MediaAsset" media
          WHERE media."organizationId" = ${org}
            AND media."id" IN (${Prisma.join(assetIds)})
          ORDER BY media."id" ASC
          FOR KEY SHARE OF media`;
        if (assets.length !== assetIds.length)
          return { created: false as const, reason: "INVALID_ASSET" as const };
      }
      const playlist = await tx.playlist.create({
        data: {
          organizationId: org,
          name: data.name,
          description: data.description,
          items: {
            create: data.items.map((item) => ({
              assetId: item.assetId,
              position: item.position,
              durationSeconds: item.durationSeconds,
            })),
          },
        },
        include: { items: true },
      });
      await tx.auditEvent.create({
        data: {
          organizationId: org,
          actorUserId: audit.actorUserId,
          actorType: "user",
          action: "playlist.created",
          entityType: "playlist",
          entityId: playlist.id,
          ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
          ...(audit.requestId ? { requestId: audit.requestId } : {}),
          metadata: { itemCount: playlist.items.length },
        },
      });
      return { created: true as const, value: playlistDto(playlist) };
    });
  }
  async getPlaylist(org: string, id: string) {
    const x = await this.prisma.playlist.findFirst({
      where: { id, organizationId: org },
      include: { items: true },
    });
    return x ? playlistDto(x) : null;
  }
  async deletePlaylist(org: string, id: string): Promise<DeleteResult> {
    try {
      const r = await this.prisma.playlist.deleteMany({
        where: { id, organizationId: org },
      });
      return r.count > 0 ? "DELETED" : "NOT_FOUND";
    } catch (error) {
      if (isForeignKeyConstraintError(error)) return "IN_USE";
      throw error;
    }
  }
  async deletePlaylistAndAudit(
    org: string,
    id: string,
    audit: UserMutationAuditContext,
  ) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const role = await this.lockActiveActorRole(tx, org, audit.actorUserId);
        if (role !== "OWNER" && role !== "ADMIN" && role !== "PUBLISHER")
          return { deleted: false as const, reason: "FORBIDDEN" as const };
        const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT playlist."id"
          FROM "Playlist" playlist
          WHERE playlist."id" = ${id} AND playlist."organizationId" = ${org}
          FOR UPDATE OF playlist`;
        if (!locked)
          return { deleted: false as const, reason: "NOT_FOUND" as const };
        const scheduleReference = await tx.schedule.findFirst({
          where: { organizationId: org, playlistId: id },
          select: { id: true },
        });
        if (scheduleReference)
          return { deleted: false as const, reason: "IN_USE" as const };
        const releaseReference = await tx.publishedRelease.findFirst({
          where: { organizationId: org, sourcePlaylistId: id },
          select: { id: true },
        });
        if (releaseReference)
          return { deleted: false as const, reason: "IN_USE" as const };
        await tx.playlist.delete({ where: { id } });
        await tx.auditEvent.create({
          data: {
            organizationId: org,
            actorUserId: audit.actorUserId,
            actorType: "user",
            action: "playlist.deleted",
            entityType: "playlist",
            entityId: id,
            ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
            ...(audit.requestId ? { requestId: audit.requestId } : {}),
            metadata: {},
          },
        });
        return { deleted: true as const };
      });
    } catch (error) {
      if (isForeignKeyConstraintError(error))
        return { deleted: false as const, reason: "IN_USE" as const };
      throw error;
    }
  }
  async listSchedules(org: string) {
    return (
      await this.prisma.schedule.findMany({
        where: { organizationId: org },
        include: { targets: true },
      })
    ).map((x) => scheduleDto(x));
  }
  async createSchedule(
    org: string,
    data: Omit<
      ScheduleRecord,
      "id" | "organizationId" | "createdAt" | "updatedAt"
    >,
  ) {
    return scheduleDto(
      await this.prisma.schedule.create({
        data: {
          organizationId: org,
          playlistId: data.playlistId,
          name: data.name,
          priority: data.priority.toUpperCase() as
            "NORMAL" | "CAMPAIGN" | "PRIORITY" | "EMERGENCY",
          startsAt: new Date(data.startsAt),
          endsAt: data.endsAt ? new Date(data.endsAt) : null,
          timezone: data.timezone,
          daysOfWeek: data.daysOfWeek,
          dailyStartMinutes: data.dailyStartMinutes ?? null,
          dailyEndMinutes: data.dailyEndMinutes ?? null,
          enabled: data.enabled,
          targets: {
            create: data.screenIds.map((screenId) => ({
              screenId,
            })),
          },
        },
        include: { targets: true },
      }),
    );
  }
  async deleteSchedule(org: string, id: string) {
    const r = await this.prisma.schedule.deleteMany({
      where: { id, organizationId: org },
    });
    return r.count > 0;
  }
  async publishScheduleAndAudit(
    org: string,
    data: SchedulePublicationInput,
    audit: ReleaseAuditContext,
    policy: ReleasePublicationPolicy,
  ): Promise<SchedulePublicationResult> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const [actorMembership] = await tx.$queryRaw<
              Array<{ role: string }>
            >`SELECT m."role"::text AS "role"
              FROM "Membership" AS m
              INNER JOIN "User" AS u ON u."id" = m."userId"
              WHERE m."organizationId" = ${org}
                AND m."userId" = ${audit.actorUserId}
                AND u."disabledAt" IS NULL
              FOR UPDATE OF m, u`;
            if (
              !hasCapability(actorMembership?.role, CAPABILITIES.releasePublish)
            )
              return { published: false, reason: "FORBIDDEN" };
            const playlist = await tx.playlist.findFirst({
              where: { id: data.playlistId, organizationId: org },
              include: {
                items: {
                  orderBy: [{ position: "asc" }, { id: "asc" }],
                  include: { asset: true },
                },
              },
            });
            if (!playlist)
              return { published: false, reason: "PLAYLIST_NOT_FOUND" };

            const screenIds = [...new Set(data.screenIds)].sort();
            if (screenIds.length === 0)
              return { published: false, reason: "SCREEN_NOT_FOUND" };
            const screens = await tx.screen.findMany({
              where: { organizationId: org, id: { in: screenIds } },
              select: { id: true },
            });
            if (screens.length !== screenIds.length)
              return { published: false, reason: "SCREEN_NOT_FOUND" };

            const [clock] = await tx.$queryRaw<Array<{ databaseNow: Date }>>`
              SELECT CURRENT_TIMESTAMP AS "databaseNow"`;
            if (!clock) throw new Error("Database clock is unavailable");

            const playlistRecord = playlistDto(playlist);
            const assets = playlist.items.map((item) => mediaDto(item.asset));
            if (
              assets.some(
                (asset) =>
                  !mediaUrlMatchesAllowedOrigin(
                    asset.url,
                    policy.mediaAllowedOrigins,
                  ),
              )
            )
              return { published: false, reason: "ASSET_NOT_ALLOWED" };
            const mediaFailure = mediaPublicationFailure(
              assets,
              clock.databaseNow,
            );
            if (mediaFailure) return { published: false, reason: mediaFailure };

            let snapshot;
            try {
              snapshot = canonicalReleaseSnapshot(playlistRecord, assets);
            } catch (error) {
              if (error instanceof ReleaseSnapshotError)
                return { published: false, reason: error.reason };
              throw error;
            }
            const digestSha256 = releaseSnapshotDigest(snapshot);
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`release:${org}:${digestSha256}`}, 0))`;
            let release = await tx.publishedRelease.findUnique({
              where: {
                organizationId_digestSha256: {
                  organizationId: org,
                  digestSha256,
                },
              },
              include: { items: { orderBy: { position: "asc" } } },
            });
            if (!release) {
              release = await tx.publishedRelease.create({
                data: {
                  organizationId: org,
                  sourcePlaylistId: snapshot.sourcePlaylistId,
                  sourcePlaylistName: snapshot.playlistName,
                  sourcePlaylistDescription: snapshot.playlistDescription,
                  sourcePlaylistUpdatedAt: new Date(
                    snapshot.sourcePlaylistUpdatedAt,
                  ),
                  digestSha256,
                  createdById: audit.actorUserId,
                  items: {
                    create: snapshot.items.map((item) => ({
                      sourcePlaylistItemId: item.id,
                      sourceAssetId: item.asset.id,
                      assetName: item.asset.name,
                      assetKind: item.asset.kind.toUpperCase() as
                        "IMAGE" | "VIDEO" | "WEB" | "TEMPLATE",
                      assetMimeType: item.asset.mimeType,
                      assetUrl: item.asset.url,
                      assetStorageKey:
                        item.asset.storageKey ??
                        mediaStorageKey(
                          org,
                          item.asset.id,
                          item.asset.checksumSha256,
                        ),
                      assetChecksumSha256: item.asset.checksumSha256,
                      assetSizeBytes: BigInt(item.asset.sizeBytes),
                      assetCreatedAt: new Date(item.asset.createdAt),
                      assetExpiresAt: item.asset.expiresAt
                        ? new Date(item.asset.expiresAt)
                        : null,
                      position: item.position,
                      durationSeconds: item.durationSeconds,
                    })),
                  },
                },
                include: { items: { orderBy: { position: "asc" } } },
              });
            }

            const frozenSchedule = {
              name: data.name,
              priority: data.priority,
              startsAt: data.startsAt,
              ...(data.endsAt ? { endsAt: data.endsAt } : {}),
              timezone: data.timezone,
              daysOfWeek: [...data.daysOfWeek],
              ...(data.dailyStartMinutes !== undefined
                ? { dailyStartMinutes: data.dailyStartMinutes }
                : {}),
              ...(data.dailyEndMinutes !== undefined
                ? { dailyEndMinutes: data.dailyEndMinutes }
                : {}),
              enabled: data.enabled,
            };
            const assignmentDigest = assignmentSnapshotDigest(
              canonicalAssignmentSnapshot({
                releaseDigestSha256: digestSha256,
                state: "ASSIGNED",
                schedule: frozenSchedule,
                screenIds,
              }),
            );
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`assignment:${org}:${assignmentDigest}`}, 0))`;
            const existingAssignment = await tx.releaseAssignment.findFirst({
              where: {
                organizationId: org,
                digestSha256: assignmentDigest,
                state: "ASSIGNED",
                nextAssignments: { none: {} },
              },
              include: {
                targets: true,
                schedule: { include: { targets: true } },
                release: {
                  include: { items: { orderBy: { position: "asc" } } },
                },
              },
            });
            if (existingAssignment) {
              return {
                published: true,
                schedule: {
                  ...scheduleDto(existingAssignment.schedule),
                  releaseId: existingAssignment.releaseId,
                  assignmentId: existingAssignment.id,
                },
                release: publishedReleaseDto(existingAssignment.release),
                assignment: releaseAssignmentDto(existingAssignment),
              };
            }
            const schedule = await tx.schedule.create({
              data: {
                organizationId: org,
                playlistId: data.playlistId,
                name: data.name,
                priority: data.priority.toUpperCase() as
                  "NORMAL" | "CAMPAIGN" | "PRIORITY" | "EMERGENCY",
                startsAt: new Date(data.startsAt),
                endsAt: data.endsAt ? new Date(data.endsAt) : null,
                timezone: data.timezone,
                daysOfWeek: data.daysOfWeek,
                dailyStartMinutes: data.dailyStartMinutes ?? null,
                dailyEndMinutes: data.dailyEndMinutes ?? null,
                enabled: data.enabled,
                targets: {
                  create: screenIds.map((screenId) => ({ screenId })),
                },
              },
              include: { targets: true },
            });
            const assignment = await tx.releaseAssignment.create({
              data: {
                organizationId: org,
                releaseId: release.id,
                scheduleId: schedule.id,
                state: "ASSIGNED",
                digestSha256: assignmentDigest,
                createdById: audit.actorUserId,
                scheduleName: frozenSchedule.name,
                priority: frozenSchedule.priority.toUpperCase() as
                  "NORMAL" | "CAMPAIGN" | "PRIORITY" | "EMERGENCY",
                startsAt: new Date(frozenSchedule.startsAt),
                endsAt: frozenSchedule.endsAt
                  ? new Date(frozenSchedule.endsAt)
                  : null,
                timezone: frozenSchedule.timezone,
                daysOfWeek: frozenSchedule.daysOfWeek,
                dailyStartMinutes: frozenSchedule.dailyStartMinutes ?? null,
                dailyEndMinutes: frozenSchedule.dailyEndMinutes ?? null,
                enabled: frozenSchedule.enabled,
                targets: {
                  create: screenIds.map((screenId) => ({
                    screenId,
                    liveScreenId: screenId,
                    liveScreenOrganizationId: org,
                  })),
                },
              },
              include: { targets: true },
            });
            await tx.auditEvent.create({
              data: {
                organizationId: org,
                actorUserId: audit.actorUserId,
                actorType: "user",
                action: "release.published",
                entityType: "published_release",
                entityId: release.id,
                ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
                ...(audit.requestId ? { requestId: audit.requestId } : {}),
                metadata: {
                  scheduleId: schedule.id,
                  assignmentId: assignment.id,
                  digestSha256,
                  assignmentDigestSha256: assignmentDigest,
                  screenCount: screenIds.length,
                },
              },
            });

            return {
              published: true,
              schedule: {
                ...scheduleDto(schedule),
                releaseId: release.id,
                assignmentId: assignment.id,
              },
              release: publishedReleaseDto(release),
              assignment: releaseAssignmentDto(assignment),
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
        );
      } catch (error) {
        if (
          attempt < 2 &&
          (isUniqueConstraintError(error) || isRetryableWriteConflict(error))
        )
          continue;
        throw error;
      }
    }
    throw new Error("Publication retry budget exhausted");
  }
  async withdrawScheduleAndAudit(
    org: string,
    scheduleId: string,
    audit: ReleaseAuditContext,
  ): Promise<ScheduleWithdrawalResult> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const [actorMembership] = await tx.$queryRaw<
            Array<{ role: string }>
          >`SELECT m."role"::text AS "role"
            FROM "Membership" AS m
            INNER JOIN "User" AS u ON u."id" = m."userId"
            WHERE m."organizationId" = ${org}
              AND m."userId" = ${audit.actorUserId}
              AND u."disabledAt" IS NULL
            FOR UPDATE OF m, u`;
          if (
            !hasCapability(actorMembership?.role, CAPABILITIES.releaseWithdraw)
          )
            return { withdrawn: false, reason: "FORBIDDEN" };
          const schedule = await tx.schedule.findFirst({
            where: { id: scheduleId, organizationId: org },
            select: { id: true },
          });
          if (!schedule) return { withdrawn: false, reason: "NOT_FOUND" };
          const previous = await tx.releaseAssignment.findFirst({
            where: {
              organizationId: org,
              scheduleId,
              nextAssignments: { none: {} },
            },
            include: { targets: true, release: true },
          });
          if (!previous) return { withdrawn: false, reason: "NOT_FOUND" };
          if (previous.state === "WITHDRAWN")
            return { withdrawn: false, reason: "ALREADY_WITHDRAWN" };

          const previousDto = releaseAssignmentDto(previous);
          const digestSha256 = assignmentSnapshotDigest(
            canonicalAssignmentSnapshot({
              releaseDigestSha256: previous.release.digestSha256,
              state: "WITHDRAWN",
              schedule: previousDto.schedule,
              screenIds: previousDto.screenIds,
              previousAssignmentId: previous.id,
            }),
          );
          const assignment = await tx.releaseAssignment.create({
            data: {
              organizationId: org,
              releaseId: previous.releaseId,
              scheduleId,
              state: "WITHDRAWN",
              digestSha256,
              previousAssignmentId: previous.id,
              createdById: audit.actorUserId,
              scheduleName: previous.scheduleName,
              priority: previous.priority,
              startsAt: previous.startsAt,
              endsAt: previous.endsAt,
              timezone: previous.timezone,
              daysOfWeek: previous.daysOfWeek,
              dailyStartMinutes: previous.dailyStartMinutes,
              dailyEndMinutes: previous.dailyEndMinutes,
              enabled: previous.enabled,
              targets: {
                create: previous.targets.map((target) => ({
                  screenId: target.screenId,
                  liveScreenId: target.liveScreenId,
                  liveScreenOrganizationId: target.liveScreenOrganizationId,
                })),
              },
            },
            include: { targets: true },
          });
          await tx.auditEvent.create({
            data: {
              organizationId: org,
              actorUserId: audit.actorUserId,
              actorType: "user",
              action: "release.withdrawn",
              entityType: "release_assignment",
              entityId: assignment.id,
              ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
              ...(audit.requestId ? { requestId: audit.requestId } : {}),
              metadata: {
                scheduleId,
                releaseId: previous.releaseId,
                previousAssignmentId: previous.id,
                assignmentDigestSha256: digestSha256,
                screenCount: previous.targets.length,
              },
            },
          });
          return {
            withdrawn: true,
            assignment: releaseAssignmentDto(assignment),
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isUniqueConstraintError(error))
        return { withdrawn: false, reason: "ALREADY_WITHDRAWN" };
      throw error;
    }
  }
  async activeOrdinaryReleases(
    org: string,
    screenId: string,
    at: string,
  ): Promise<ActiveOrdinaryRelease[]> {
    const targetedScheduleIds = (
      await this.prisma.releaseAssignmentTarget.findMany({
        where: { organizationId: org, screenId },
        select: { assignment: { select: { scheduleId: true } } },
        distinct: ["assignmentId"],
      })
    ).map((target) => target.assignment.scheduleId);
    if (targetedScheduleIds.length === 0) return [];
    const assignments = await this.prisma.releaseAssignment.findMany({
      where: {
        organizationId: org,
        scheduleId: { in: [...new Set(targetedScheduleIds)] },
        nextAssignments: { none: {} },
      },
      include: {
        targets: true,
        release: { include: { items: { orderBy: { position: "asc" } } } },
      },
    });
    const instant = new Date(at);
    return assignments.flatMap((assignment) => {
      const assignmentDto = releaseAssignmentDto(assignment);
      if (
        assignmentDto.state !== "ASSIGNED" ||
        !assignmentDto.screenIds.includes(screenId) ||
        !assignmentDto.schedule.enabled ||
        assignmentDto.schedule.startsAt > at ||
        (assignmentDto.schedule.endsAt && assignmentDto.schedule.endsAt <= at)
      )
        return [];
      const scheduleForWindow: ScheduleRecord = {
        id: assignment.scheduleId,
        organizationId: org,
        playlistId: assignment.release.sourcePlaylistId,
        ...assignmentDto.schedule,
        screenIds: assignmentDto.screenIds,
        releaseId: assignment.releaseId,
        assignmentId: assignment.id,
        createdAt: assignmentDto.createdAt,
        updatedAt: assignmentDto.createdAt,
      };
      if (!matchesScheduleWindow(scheduleForWindow, instant)) return [];
      return [
        {
          release: publishedReleaseDto(assignment.release),
          assignment: assignmentDto,
        },
      ];
    });
  }
  async authorizeMediaDelivery(
    input: MediaDeliveryAuthorizationInput,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1)
      return false;
    const at = new Date(input.at);
    if (!Number.isFinite(at.getTime())) return false;
    const assignment = await this.prisma.releaseAssignment.findFirst({
      where: {
        id: input.assignmentId,
        organizationId: input.organizationId,
        digestSha256: input.assignmentDigestSha256,
        state: "ASSIGNED",
        enabled: true,
        startsAt: { lte: at },
        OR: [{ endsAt: null }, { endsAt: { gt: at } }],
        nextAssignments: { none: {} },
        targets: { some: { screenId: input.screenId } },
        release: {
          items: {
            some: {
              sourceAssetId: input.assetId,
              assetStorageKey: input.storageKey,
              assetChecksumSha256: input.checksumSha256,
              assetSizeBytes: BigInt(input.sizeBytes),
              OR: [{ assetExpiresAt: null }, { assetExpiresAt: { gt: at } }],
            },
          },
        },
      },
      select: {
        endsAt: true,
        timezone: true,
        daysOfWeek: true,
        dailyStartMinutes: true,
        dailyEndMinutes: true,
      },
    });
    return Boolean(
      assignment &&
      matchesScheduleWindow(
        {
          ...(assignment.endsAt
            ? { endsAt: assignment.endsAt.toISOString() }
            : {}),
          timezone: assignment.timezone,
          daysOfWeek: assignment.daysOfWeek,
          ...(assignment.dailyStartMinutes != null
            ? { dailyStartMinutes: assignment.dailyStartMinutes }
            : {}),
          ...(assignment.dailyEndMinutes != null
            ? { dailyEndMinutes: assignment.dailyEndMinutes }
            : {}),
        },
        at,
      ),
    );
  }
  async activeSchedules(org: string, screenId: string, at: string) {
    const d = new Date(at);
    const xs = await this.prisma.schedule.findMany({
      where: {
        organizationId: org,
        enabled: true,
        startsAt: { lte: d },
        OR: [{ endsAt: null }, { endsAt: { gt: d } }],
        targets: { some: { screenId } },
      },
      include: { targets: true },
    });
    return xs
      .map((x) => scheduleDto(x))
      .filter((x) => matchesScheduleWindow(x, d));
  }
  async activeEmergency(org: string, screenId: string, at: string) {
    const d = new Date(at);
    const x = await this.prisma.emergencyOverride.findFirst({
      where: {
        organizationId: org,
        targetScreenIds: { has: screenId },
        startsAt: { lte: d },
        expiresAt: { gt: d },
        clearedAt: null,
      },
      orderBy: { createdAt: "desc" },
    });
    return x ? emergencyDto(x) : null;
  }
  async activateEmergencyAndAudit(
    org: string,
    data: Pick<
      EmergencyRecord,
      "title" | "message" | "backgroundColor" | "targetScreenIds" | "expiresAt"
    >,
    audit: UserMutationAuditContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const role = await this.lockActiveActorRole(tx, org, audit.actorUserId);
      if (!hasCapability(role, CAPABILITIES.emergencyActivate))
        return { activated: false as const, reason: "FORBIDDEN" as const };
      const targetScreenIds = [...new Set(data.targetScreenIds)].sort();
      if (targetScreenIds.length === 0)
        return { activated: false as const, reason: "INVALID_SCREEN" as const };
      const targets = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT screen."id"
        FROM "Screen" screen
        WHERE screen."organizationId" = ${org}
          AND screen."id" IN (${Prisma.join(targetScreenIds)})
        ORDER BY screen."id" ASC
        FOR KEY SHARE OF screen`;
      if (targets.length !== targetScreenIds.length)
        return { activated: false as const, reason: "INVALID_SCREEN" as const };
      const emergency = await tx.emergencyOverride.create({
        data: {
          organizationId: org,
          createdById: audit.actorUserId,
          ...data,
          targetScreenIds,
          expiresAt: new Date(data.expiresAt),
        },
      });
      await tx.auditEvent.create({
        data: {
          organizationId: org,
          actorUserId: audit.actorUserId,
          actorType: "user",
          action: "emergency.activated",
          entityType: "emergency",
          entityId: emergency.id,
          ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
          ...(audit.requestId ? { requestId: audit.requestId } : {}),
          metadata: {
            targetCount: targetScreenIds.length,
            expiresAt: data.expiresAt,
          },
        },
      });
      return {
        activated: true as const,
        emergency: emergencyDto(emergency),
      };
    });
  }
  async clearEmergencyAndAudit(
    org: string,
    id: string,
    audit: UserMutationAuditContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const role = await this.lockActiveActorRole(tx, org, audit.actorUserId);
      if (!hasCapability(role, CAPABILITIES.emergencyClear))
        return { cleared: false as const, reason: "FORBIDDEN" as const };
      const [locked] = await tx.$queryRaw<
        Array<{ id: string; databaseNow: Date }>
      >`
        SELECT emergency."id", CURRENT_TIMESTAMP AS "databaseNow"
        FROM "EmergencyOverride" emergency
        WHERE emergency."id" = ${id}
          AND emergency."organizationId" = ${org}
        FOR UPDATE OF emergency`;
      if (!locked)
        return { cleared: false as const, reason: "NOT_FOUND" as const };
      const emergency = await tx.emergencyOverride.update({
        where: { id },
        data: { clearedAt: locked.databaseNow },
      });
      await tx.auditEvent.create({
        data: {
          organizationId: org,
          actorUserId: audit.actorUserId,
          actorType: "user",
          action: "emergency.cleared",
          entityType: "emergency",
          entityId: id,
          ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
          ...(audit.requestId ? { requestId: audit.requestId } : {}),
          metadata: {},
        },
      });
      return { cleared: true as const, emergency: emergencyDto(emergency) };
    });
  }
  async listAudits(org: string, limit: number) {
    return (
      await this.prisma.auditEvent.findMany({
        where: { organizationId: org },
        orderBy: { createdAt: "desc" },
        take: limit,
      })
    ).map((x) => ({
      id: x.id,
      organizationId: x.organizationId,
      ...(x.actorUserId ? { actorUserId: x.actorUserId } : {}),
      actorType: x.actorType,
      action: x.action,
      entityType: x.entityType,
      ...(x.entityId ? { entityId: x.entityId } : {}),
      ...(x.ipAddress ? { ipAddress: x.ipAddress } : {}),
      ...(x.requestId ? { requestId: x.requestId } : {}),
      metadata: x.metadata as Record<string, unknown>,
      createdAt: iso(x.createdAt)!,
    }));
  }
  async audit(event: Omit<AuditRecord, "id" | "createdAt">) {
    await this.prisma.auditEvent.create({
      data: {
        organizationId: event.organizationId,
        actorType: event.actorType,
        action: event.action,
        entityType: event.entityType,
        metadata: event.metadata as never,
        ...(event.actorUserId ? { actorUserId: event.actorUserId } : {}),
        ...(event.entityId ? { entityId: event.entityId } : {}),
        ...(event.ipAddress ? { ipAddress: event.ipAddress } : {}),
        ...(event.requestId ? { requestId: event.requestId } : {}),
      },
    });
  }
}
