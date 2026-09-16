import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  CAPABILITIES,
  type AuthorizationScopeType,
  type ScopedAuthorizationGrant,
  type ScopedAuthorizationScreenTarget,
} from "@screengoblin/contracts";
import { mediaStorageKey } from "../media/delivery.js";
import { isApprovedPasswordHash } from "../utils/crypto.js";
import type {
  ActiveOrdinaryRelease,
  AuditRecord,
  BootstrapPasswordRotationInput,
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
  ScreenEnrollmentActivationIdempotencyInput,
  ScreenEnrollmentActivationResult,
  ScreenEnrollmentIdempotencyInput,
  ScreenEnrollmentRequestResult,
  PlaylistRecord,
  PublishedReleaseRecord,
  ReleaseCandidateIdempotencyInput,
  ReleaseCandidateRecord,
  ReleaseCandidateResult,
  ReleaseAssignmentRecord,
  ReleaseAuditContext,
  ReleasePublicationPolicy,
  ScheduleRecord,
  SchedulePublicationInput,
  SchedulePublicationIdempotencyInput,
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
  SCHEDULE_PUBLICATION_IDEMPOTENCY_OPERATION,
  SCHEDULE_PUBLICATION_RESPONSE_RETENTION_MS,
  DATABASE_MAINTENANCE_BATCH_SIZE,
  DEVICE_AUTH_CHALLENGE_RETENTION_MS,
  DEVICE_ENROLLMENT_AUTHORITY_RETENTION_MS,
  LOGIN_FAILURE_MAX_RECORDS,
  LOGIN_FAILURE_RETENTION_MS,
  RELEASE_CANDIDATE_RESPONSE_RETENTION_MS,
} from "../domain/types.js";
import {
  assignmentSnapshotDigest,
  canonicalAssignmentSnapshot,
  canonicalReleaseSnapshot,
  canonicalUtcInstant,
  hasValidStoredAssignmentDigest,
  hasValidStoredReleaseDigest,
  ReleaseSnapshotError,
  releaseSnapshotDigest,
  canonicalReleaseCandidateSnapshot,
  releaseCandidateDigest,
} from "../releases/canonical.js";
import { hasCapability } from "../authorization/policy.js";
import { evaluateScopedAuthorization } from "../authorization/scoped.js";
import {
  evaluatedAuthorizationShadow,
  RELEASE_SHADOW_MAX_GRANTS,
  RELEASE_SHADOW_MAX_GROUP_EDGES,
  unavailableAuthorizationShadow,
  type AuthorizationShadowMetadata,
} from "../authorization/shadow.js";
import {
  COMPATIBILITY_GRANT_SYSTEM_KEY,
  compatibilityGrantCapabilities,
  compatibilityGrantId,
} from "../authorization/compatibility.js";
import { mediaUrlMatchesAllowedOrigin } from "../utils/media-url.js";
import { mediaPublicationFailure } from "../utils/media-policy.js";
import { matchesScheduleWindow } from "../utils/schedule.js";
import { randomToken } from "../utils/crypto.js";
import { assertAuditEventIntegrity } from "../audit/integrity.js";

const iso = (v: Date | null | undefined) => v?.toISOString();
const lowercaseSha256 = /^[0-9a-f]{64}$/;
const publicationResponseJson = (
  result: Extract<SchedulePublicationResult, { published: true }>,
): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(result.schedule)) as Prisma.InputJsonValue;
const publicationResponseFromJson = (value: Prisma.JsonValue): ScheduleRecord =>
  structuredClone(value as unknown as ScheduleRecord);
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
): ReleaseAssignmentRecord => {
  const state = String(x.state);
  if (state !== "ASSIGNED" && state !== "WITHDRAWN")
    throw new Error(
      "Internal release assignment state cannot cross the DTO boundary",
    );
  return {
    id: String(x.id),
    organizationId: String(x.organizationId),
    releaseId: String(x.releaseId),
    scheduleId: String(x.scheduleId),
    screenIds: ((x.targets ?? []) as Array<{ screenId: string }>)
      .map((target) => target.screenId)
      .sort(),
    state,
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
  };
};

const releaseCandidateDto = (
  x: Record<string, unknown>,
): ReleaseCandidateRecord => {
  const approval = x.approval as Record<string, unknown> | null | undefined;
  const publication = x.publication as
    Record<string, unknown> | null | undefined;
  return {
    id: String(x.id),
    organizationId: String(x.organizationId),
    releaseId: String(x.releaseId),
    releaseDigestSha256: String(
      (x.release as Record<string, unknown> | undefined)?.digestSha256 ??
        x.releaseDigestSha256,
    ),
    sourcePlaylistId: String(
      (x.release as Record<string, unknown> | undefined)?.sourcePlaylistId ??
        x.sourcePlaylistId,
    ),
    state: String(x.state) as ReleaseCandidateRecord["state"],
    digestSha256: String(x.digestSha256),
    authorUserId: String(x.authorUserId),
    items: publishedReleaseDto(x.release as Record<string, unknown>).items,
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
    screenIds: ((x.targets ?? []) as Array<{ screenId: string }>)
      .map(({ screenId }) => screenId)
      .sort(),
    policyVersion: Number(x.policyVersion),
    expiresAt: iso(x.expiresAt as Date)!,
    ...(x.submittedAt ? { submittedAt: iso(x.submittedAt as Date) } : {}),
    ...(x.approvedAt ? { approvedAt: iso(x.approvedAt as Date) } : {}),
    ...(x.publishedAt ? { publishedAt: iso(x.publishedAt as Date) } : {}),
    ...(publication
      ? {
          scheduleId: String(publication.scheduleId),
          assignmentId: String(publication.assignmentId),
        }
      : {}),
    ...(approval
      ? {
          approval: {
            id: String(approval.id),
            organizationId: String(approval.organizationId),
            candidateId: String(approval.candidateId),
            candidateDigestSha256: String(approval.candidateDigestSha256),
            approverUserId: String(approval.approverUserId),
            authenticationEpoch: Number(approval.authenticationEpoch),
            authorizationEpoch: Number(approval.authorizationEpoch),
            approvedAt: iso(approval.approvedAt as Date)!,
          },
        }
      : {}),
    createdAt: iso(x.createdAt as Date)!,
  };
};

const verifiedReleaseAssignmentDtos = (x: Record<string, unknown>) => {
  try {
    const assignment = releaseAssignmentDto(x);
    const release = publishedReleaseDto(x.release as Record<string, unknown>);
    return hasValidStoredAssignmentDigest(assignment, release)
      ? { assignment, release }
      : undefined;
  } catch {
    return undefined;
  }
};

const hasPublishedAssignmentProvenance = (
  assignment: Record<string, unknown>,
) => {
  if (!assignment.approvalRequired) return true;
  const publication = assignment.finalPublication as
    Record<string, unknown> | null | undefined;
  const candidate = publication?.publishedCandidate as
    Record<string, unknown> | null | undefined;
  const targets = (assignment.targets ?? []) as Array<Record<string, unknown>>;
  return (
    assignment.candidatePublicationId != null &&
    publication?.id === assignment.candidatePublicationId &&
    publication.assignmentId === assignment.id &&
    candidate?.state === "PUBLISHED" &&
    candidate.publicationId === assignment.candidatePublicationId &&
    targets.length > 0 &&
    targets.every(
      (target) =>
        target.liveScreenId === target.screenId &&
        target.liveScreenOrganizationId === assignment.organizationId,
    )
  );
};

const targetSnapshotKey = (target: Record<string, unknown>) =>
  JSON.stringify([
    String(target.screenId),
    target.liveScreenId == null ? null : String(target.liveScreenId),
    target.liveScreenOrganizationId == null
      ? null
      : String(target.liveScreenOrganizationId),
  ]);

const isValidWithdrawalSuccessor = (
  previous: Record<string, unknown>,
  successor: Record<string, unknown>,
) => {
  if (
    previous.state !== "ASSIGNED" ||
    successor.state !== "WITHDRAWN" ||
    successor.previousAssignmentId !== previous.id ||
    successor.organizationId !== previous.organizationId ||
    successor.releaseId !== previous.releaseId ||
    successor.scheduleId !== previous.scheduleId
  )
    return false;
  const previousVerified = verifiedReleaseAssignmentDtos(previous);
  const successorVerified = verifiedReleaseAssignmentDtos(successor);
  if (!previousVerified || !successorVerified) return false;
  const expectedDigest = assignmentSnapshotDigest(
    canonicalAssignmentSnapshot({
      releaseDigestSha256: previousVerified.release.digestSha256,
      state: "WITHDRAWN",
      schedule: previousVerified.assignment.schedule,
      screenIds: previousVerified.assignment.screenIds,
      previousAssignmentId: previousVerified.assignment.id,
    }),
  );
  if (successorVerified.assignment.digestSha256 !== expectedDigest)
    return false;
  const previousTargets = (
    (previous.targets ?? []) as Array<Record<string, unknown>>
  )
    .map(targetSnapshotKey)
    .sort();
  const successorTargets = (
    (successor.targets ?? []) as Array<Record<string, unknown>>
  )
    .map(targetSnapshotKey)
    .sort();
  return JSON.stringify(previousTargets) === JSON.stringify(successorTargets);
};

const hasValidWithdrawalSuccessor = (assignment: Record<string, unknown>) =>
  ((assignment.nextAssignments ?? []) as Array<Record<string, unknown>>).some(
    (successor) => isValidWithdrawalSuccessor(assignment, successor),
  );

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
  authorizedByMembershipId?: string | null;
  authorizedByAuthenticationEpoch?: number | null;
  authorizedByAuthorizationEpoch?: number | null;
  priorCredentialId?: string | null;
  requestReason?: string | null;
  createdAt?: Date;
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
  ...(x.authorizedByMembershipId
    ? { authorizedByMembershipId: x.authorizedByMembershipId }
    : {}),
  ...(x.authorizedByAuthenticationEpoch != null
    ? { authorizedByAuthenticationEpoch: x.authorizedByAuthenticationEpoch }
    : {}),
  ...(x.authorizedByAuthorizationEpoch != null
    ? { authorizedByAuthorizationEpoch: x.authorizedByAuthorizationEpoch }
    : {}),
  ...(x.priorCredentialId ? { priorCredentialId: x.priorCredentialId } : {}),
  ...(x.requestReason ? { requestReason: x.requestReason } : {}),
  ...(x.createdAt ? { createdAt: iso(x.createdAt)! } : {}),
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
  private async lockReleaseActor(
    tx: Prisma.TransactionClient,
    organizationId: string,
    actorUserId: string,
  ) {
    const [actor] = await tx.$queryRaw<
      Array<{
        membershipId: string;
        role: string;
        authenticationEpoch: number;
        bootstrapPasswordExpiresAt: Date | null;
        authorizationEpoch: number;
      }>
    >`SELECT membership."id" AS "membershipId",
             membership."role"::text AS "role",
             actor."authenticationEpoch" AS "authenticationEpoch",
             membership."authorizationEpoch" AS "authorizationEpoch"
      FROM "Membership" membership
      INNER JOIN "User" actor ON actor."id" = membership."userId"
      WHERE membership."organizationId" = ${organizationId}
        AND membership."userId" = ${actorUserId}
        AND actor."disabledAt" IS NULL
      FOR UPDATE OF membership, actor`;
    return actor;
  }
  private async releaseCandidateCreateAuthorizationShadow(
    tx: Prisma.TransactionClient,
    input: {
      organizationId: string;
      actorUserId: string;
      actor: {
        membershipId: string;
        role: string;
        authorizationEpoch: number;
      };
      screenIds: string[];
      databaseNow: Date;
    },
  ): Promise<AuthorizationShadowMetadata> {
    const [timeoutSetting] = await tx.$queryRaw<
      Array<{ statementTimeout: string }>
    >`SELECT current_setting('statement_timeout') AS "statementTimeout"`;
    if (!timeoutSetting)
      throw new Error("Database timeout setting is unavailable");
    await tx.$executeRaw`SAVEPOINT release_authorization_shadow`;
    try {
      await tx.$queryRaw`SELECT set_config('statement_timeout', '250ms', true)`;
      const screens = await tx.$queryRaw<
        Array<{ screenId: string; locationId: string | null }>
      >`
        SELECT screen."id" AS "screenId", screen."locationId"
        FROM "Screen" screen
        WHERE screen."organizationId" = ${input.organizationId}
          AND screen."id" = ANY(${input.screenIds}::text[])
        ORDER BY screen."id" ASC
        FOR SHARE OF screen NOWAIT`;
      if (screens.length !== input.screenIds.length) {
        await tx.$queryRaw`SELECT set_config('statement_timeout', ${timeoutSetting.statementTimeout}, true)`;
        await tx.$executeRaw`RELEASE SAVEPOINT release_authorization_shadow`;
        return unavailableAuthorizationShadow(
          "TARGET_UNRESOLVED",
          input.screenIds.length,
        );
      }
      const groupEdges = await tx.$queryRaw<
        Array<{ screenId: string; groupId: string }>
      >`
        SELECT member."screenId", member."groupId"
        FROM "ScreenGroupMember" member
        INNER JOIN "ScreenGroup" screen_group
          ON screen_group."id" = member."groupId"
         AND screen_group."organizationId" = member."organizationId"
         AND screen_group."deletedAt" IS NULL
        WHERE member."organizationId" = ${input.organizationId}
          AND member."screenId" = ANY(${input.screenIds}::text[])
        ORDER BY member."screenId" ASC, member."groupId" ASC
        LIMIT ${RELEASE_SHADOW_MAX_GROUP_EDGES + 1}
        FOR SHARE OF member, screen_group NOWAIT`;
      const locationIds = screens.flatMap(({ locationId }) =>
        locationId === null ? [] : [locationId],
      );
      const groupIds = groupEdges.map(({ groupId }) => groupId);
      const grants = await tx.$queryRaw<
        Array<{
          id: string;
          capability: string;
          scopeType: AuthorizationScopeType;
          scopeId: string | null;
          startsAt: Date;
          expiresAt: Date | null;
          revokedAt: Date | null;
        }>
      >`
        SELECT grant_row."id", grant_row."capability",
               grant_row."scopeType"::text AS "scopeType",
               CASE grant_row."scopeType"::text
                 WHEN 'LOCATION' THEN grant_row."locationId"
                 WHEN 'SCREEN_GROUP' THEN grant_row."screenGroupId"
                 WHEN 'SCREEN' THEN grant_row."screenId"
                 ELSE NULL
               END AS "scopeId",
               grant_row."startsAt", grant_row."expiresAt", grant_row."revokedAt"
        FROM "AccessGrant" grant_row
        WHERE grant_row."organizationId" = ${input.organizationId}
          AND grant_row."subjectUserId" = ${input.actorUserId}
          AND grant_row."subjectMembershipId" = ${input.actor.membershipId}
          AND grant_row."capability" = ${CAPABILITIES.releaseCandidateCreate}
          AND grant_row."revokedAt" IS NULL
          AND grant_row."startsAt" <= ${input.databaseNow}
          AND (grant_row."expiresAt" IS NULL OR grant_row."expiresAt" > ${input.databaseNow})
          AND (
            grant_row."scopeType" = 'ORGANIZATION'::"AuthorizationScopeType"
            OR grant_row."locationId" = ANY(${locationIds}::text[])
            OR grant_row."screenGroupId" = ANY(${groupIds}::text[])
            OR grant_row."screenId" = ANY(${input.screenIds}::text[])
          )
        ORDER BY grant_row."id" ASC
        LIMIT ${RELEASE_SHADOW_MAX_GRANTS + 1}
        FOR SHARE OF grant_row NOWAIT`;
      if (
        groupEdges.length > RELEASE_SHADOW_MAX_GROUP_EDGES ||
        grants.length > RELEASE_SHADOW_MAX_GRANTS
      ) {
        await tx.$queryRaw`SELECT set_config('statement_timeout', ${timeoutSetting.statementTimeout}, true)`;
        await tx.$executeRaw`RELEASE SAVEPOINT release_authorization_shadow`;
        return unavailableAuthorizationShadow(
          "CONTEXT_LIMIT",
          input.screenIds.length,
        );
      }
      const groupsByScreen = new Map<string, string[]>();
      for (const edge of groupEdges) {
        const groupIds = groupsByScreen.get(edge.screenId) ?? [];
        groupIds.push(edge.groupId);
        groupsByScreen.set(edge.screenId, groupIds);
      }
      const targets: ScopedAuthorizationScreenTarget[] = screens.map(
        (screen) => ({
          organizationId: input.organizationId,
          screenId: screen.screenId,
          locationId: screen.locationId,
          screenGroupIds: groupsByScreen.get(screen.screenId) ?? [],
        }),
      );
      const normalizedGrants = grants.map(
        (grant): ScopedAuthorizationGrant => ({
          id: grant.id,
          organizationId: input.organizationId,
          subjectUserId: input.actorUserId,
          subjectMembershipId: input.actor.membershipId,
          capability:
            grant.capability as ScopedAuthorizationGrant["capability"],
          scopeType: grant.scopeType,
          scopeId: grant.scopeId,
          startsAt: grant.startsAt.toISOString(),
          expiresAt: grant.expiresAt?.toISOString() ?? null,
          revokedAt: grant.revokedAt?.toISOString() ?? null,
        }),
      );
      const decision = evaluateScopedAuthorization({
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        membershipId: input.actor.membershipId,
        role: input.actor.role,
        authorizationEpoch: input.actor.authorizationEpoch,
        capability: CAPABILITIES.releaseCandidateCreate,
        evaluatedAt: input.databaseNow.toISOString(),
        grants: normalizedGrants,
        targets,
      });
      await tx.$queryRaw`SELECT set_config('statement_timeout', ${timeoutSetting.statementTimeout}, true)`;
      await tx.$executeRaw`RELEASE SAVEPOINT release_authorization_shadow`;
      return evaluatedAuthorizationShadow(decision, targets.length);
    } catch (error) {
      try {
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT release_authorization_shadow`;
        await tx.$executeRaw`RELEASE SAVEPOINT release_authorization_shadow`;
      } catch {
        throw error;
      }
      if (isRetryableWriteConflict(error)) throw error;
      return unavailableAuthorizationShadow(
        "LOAD_FAILED",
        input.screenIds.length,
      );
    }
  }
  private async replaceCompatibilityGrants(
    tx: Prisma.TransactionClient,
    input: {
      organizationId: string;
      userId: string;
      membershipId: string;
      role: SessionUser["role"];
      authorizationEpoch: number;
      databaseNow: Date;
    },
  ) {
    await tx.$executeRaw`UPDATE "AccessGrant"
      SET "revokedAt" = GREATEST(${input.databaseNow}, "createdAt")
      WHERE "organizationId" = ${input.organizationId}
        AND "subjectUserId" = ${input.userId}
        AND "subjectMembershipId" = ${input.membershipId}
        AND "creatorKind" = 'SYSTEM'::"AccessGrantCreatorKind"
        AND "createdBySystemKey" = ${COMPATIBILITY_GRANT_SYSTEM_KEY}
        AND "revokedAt" IS NULL`;
    const activeOrganizationGrants = await tx.accessGrant.findMany({
      where: {
        organizationId: input.organizationId,
        subjectUserId: input.userId,
        subjectMembershipId: input.membershipId,
        scopeType: "ORGANIZATION",
        revokedAt: null,
      },
      select: { capability: true },
    });
    const coveredCapabilities = new Set(
      activeOrganizationGrants.map(({ capability }) => capability),
    );
    const nextEpoch = input.authorizationEpoch + 1;
    const data = compatibilityGrantCapabilities(input.role)
      .filter((capability) => !coveredCapabilities.has(capability))
      .map((capability) => ({
        id: compatibilityGrantId(
          input.organizationId,
          input.membershipId,
          nextEpoch,
          capability,
        ),
        organizationId: input.organizationId,
        subjectUserId: input.userId,
        subjectMembershipId: input.membershipId,
        capability,
        scopeType: "ORGANIZATION" as const,
        startsAt: input.databaseNow,
        creatorKind: "SYSTEM" as const,
        createdBySystemKey: COMPATIBILITY_GRANT_SYSTEM_KEY,
        createdAt: input.databaseNow,
      }));
    if (data.length > 0) await tx.accessGrant.createMany({ data });
  }
  private async pruneOldDeviceAuthChallenges(
    tx: Prisma.TransactionClient,
    databaseNow: Date,
  ) {
    const cutoff = new Date(
      databaseNow.getTime() - DEVICE_AUTH_CHALLENGE_RETENTION_MS,
    );
    await tx.$executeRaw`
      WITH removable AS (
        SELECT challenge."id"
        FROM "DeviceAuthChallenge" challenge
        WHERE challenge."expiresAt" <= ${cutoff}
        ORDER BY challenge."expiresAt" ASC, challenge."id" ASC
        LIMIT ${DATABASE_MAINTENANCE_BATCH_SIZE}
        FOR UPDATE OF challenge SKIP LOCKED
      )
      DELETE FROM "DeviceAuthChallenge" challenge
      USING removable
      WHERE challenge."id" = removable."id"`;
  }
  private async compactExpiredIdempotencyResponses(
    tx: Prisma.TransactionClient,
    databaseNow: Date,
  ) {
    await tx.$executeRaw`
      WITH compactable AS (
        SELECT record."id"
        FROM "IdempotencyRecord" record
        WHERE record."responseBody" IS NOT NULL
          AND record."expiresAt" <= ${databaseNow}
        ORDER BY record."expiresAt" ASC, record."id" ASC
        LIMIT ${DATABASE_MAINTENANCE_BATCH_SIZE}
        FOR UPDATE OF record SKIP LOCKED
      )
      UPDATE "IdempotencyRecord" record
      SET "responseBody" = NULL
      FROM compactable
      WHERE record."id" = compactable."id"`;
  }
  private async verifiedReleaseCandidateReplay(
    tx: Prisma.TransactionClient,
    organizationId: string,
    operation: "create" | "submit" | "approve" | "publish",
    responseBody: Prisma.JsonValue,
  ) {
    if (
      !responseBody ||
      Array.isArray(responseBody) ||
      typeof responseBody !== "object"
    )
      return undefined;
    const response = responseBody as unknown as ReleaseCandidateRecord;
    const expectedState = {
      create: "DRAFT",
      submit: "IN_REVIEW",
      approve: "APPROVED",
      publish: "PUBLISHED",
    } as const;
    if (
      typeof response.id !== "string" ||
      response.organizationId !== organizationId ||
      response.state !== expectedState[operation] ||
      !lowercaseSha256.test(response.digestSha256 ?? "")
    )
      return undefined;
    const candidate = await tx.releaseCandidate.findFirst({
      where: { id: response.id, organizationId },
      include: {
        targets: true,
        release: { include: { items: { orderBy: { position: "asc" } } } },
        approval: true,
        publication: true,
      },
    });
    if (!candidate) return undefined;
    const live = releaseCandidateDto(candidate);
    const liveStateRank = {
      DRAFT: 0,
      IN_REVIEW: 1,
      APPROVED: 2,
      PUBLISHED: 3,
    } as const;
    if (
      liveStateRank[live.state] < liveStateRank[expectedState[operation]] ||
      (operation !== "create" && !live.submittedAt) ||
      ((operation === "approve" || operation === "publish") && !live.approvedAt)
    )
      return undefined;
    const operationResponse = { ...live };
    if (operation === "create") {
      operationResponse.state = "DRAFT";
      delete operationResponse.submittedAt;
      delete operationResponse.approvedAt;
      delete operationResponse.publishedAt;
      delete operationResponse.scheduleId;
      delete operationResponse.assignmentId;
      delete operationResponse.approval;
    } else if (operation === "submit") {
      operationResponse.state = "IN_REVIEW";
      delete operationResponse.approvedAt;
      delete operationResponse.publishedAt;
      delete operationResponse.scheduleId;
      delete operationResponse.assignmentId;
      delete operationResponse.approval;
    } else if (operation === "approve") {
      operationResponse.state = "APPROVED";
      delete operationResponse.publishedAt;
      delete operationResponse.scheduleId;
      delete operationResponse.assignmentId;
    }
    const release = publishedReleaseDto(candidate.release);
    const validCandidateDigest =
      live.digestSha256 ===
      releaseCandidateDigest(
        canonicalReleaseCandidateSnapshot({
          releaseDigestSha256: live.releaseDigestSha256,
          schedule: live.schedule,
          screenIds: live.screenIds,
          expiresAt: live.expiresAt,
        }),
      );
    if (
      live.digestSha256 !== response.digestSha256 ||
      !isDeepStrictEqual(responseBody, operationResponse) ||
      !validCandidateDigest ||
      !hasValidStoredReleaseDigest(release) ||
      ((operation === "approve" || operation === "publish") &&
        (!live.approval ||
          live.approval.candidateDigestSha256 !== live.digestSha256)) ||
      (operation === "publish" &&
        (!live.scheduleId || !live.assignmentId || live.state !== "PUBLISHED"))
    )
      return undefined;
    return operationResponse;
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
  private async lockOwnerContinuity(
    tx: Prisma.TransactionClient,
    organizationIds: readonly string[],
  ) {
    // Every current owner promotion/removal path uses the same durable tenant
    // row as its invariant lock. Sorting also gives multi-tenant user disables
    // one lock order. No public membership-creation route exists yet; a future
    // creation path must take this lock before changing OWNER membership state.
    for (const organizationId of [...new Set(organizationIds)].sort()) {
      const [organization] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT organization."id"
        FROM "Organization" organization
        WHERE organization."id" = ${organizationId}
        FOR NO KEY UPDATE OF organization`;
      if (!organization) return false;
    }
    return true;
  }
  private async hasOtherActiveOwner(
    tx: Prisma.TransactionClient,
    organizationId: string,
    userId: string,
  ) {
    const [result] = await tx.$queryRaw<Array<{ present: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM "Membership" membership
        INNER JOIN "User" owner ON owner."id" = membership."userId"
        WHERE membership."organizationId" = ${organizationId}
          AND membership."userId" <> ${userId}
          AND membership."role" = 'OWNER'::"OrgRole"
          AND owner."disabledAt" IS NULL
      ) AS "present"`;
    return result?.present === true;
  }
  private async revokePendingIssuerGrants(
    tx: Prisma.TransactionClient,
    userId: string,
    organizationIds: readonly string[],
    at: Date,
  ) {
    const grants = await tx.pairingCode.findMany({
      where: {
        organizationId: { in: [...organizationIds] },
        authorizedByUserId: userId,
        status: "PENDING",
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    await tx.pairingAttempt.updateMany({
      where: {
        pairingCodeId: { in: grants.map(({ id }) => id) },
        boundCredentialId: null,
        cancelledAt: null,
      },
      data: { cancelledAt: at },
    });
    await tx.pairingCode.updateMany({
      where: { id: { in: grants.map(({ id }) => id) } },
      data: { status: "REVOKED" },
    });
    return grants.length;
  }
  private async pruneDeviceEnrollmentAuthority(
    tx: Prisma.TransactionClient,
    organizationId: string,
    databaseNow: Date,
    preserveIdempotencyKeyHash?: string,
  ) {
    await tx.$executeRaw`
      WITH compactable AS (
        SELECT record."id"
        FROM "IdempotencyRecord" record
        WHERE record."organizationId" = ${organizationId}
          AND record."responseBody" IS NOT NULL
          AND record."expiresAt" <= ${databaseNow}
          ${preserveIdempotencyKeyHash ? Prisma.sql`AND record."keyHash" <> ${preserveIdempotencyKeyHash}` : Prisma.empty}
        ORDER BY record."expiresAt" ASC, record."id" ASC
        LIMIT ${DATABASE_MAINTENANCE_BATCH_SIZE}
        FOR UPDATE OF record SKIP LOCKED
      )
      UPDATE "IdempotencyRecord" record
      SET "responseBody" = NULL
      FROM compactable
      WHERE record."id" = compactable."id"`;
    const expiredPendingGrants = await tx.pairingCode.findMany({
      where: {
        organizationId,
        status: "PENDING",
        expiresAt: { lte: databaseNow },
      },
      select: { id: true },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: DATABASE_MAINTENANCE_BATCH_SIZE,
    });
    await tx.pairingCode.updateMany({
      where: { id: { in: expiredPendingGrants.map(({ id }) => id) } },
      data: { status: "EXPIRED" },
    });
    const authorityCutoff = new Date(
      databaseNow.getTime() - DEVICE_ENROLLMENT_AUTHORITY_RETENTION_MS,
    );
    const terminalGrants = await tx.pairingCode.findMany({
      where: {
        organizationId,
        status: { not: "PENDING" },
        expiresAt: { lte: authorityCutoff },
      },
      select: { id: true },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: DATABASE_MAINTENANCE_BATCH_SIZE,
    });
    await tx.pairingCode.deleteMany({
      where: { id: { in: terminalGrants.map(({ id }) => id) } },
    });
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
        bootstrapPasswordExpiresAt: Date | null;
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
             identity."bootstrapPasswordExpiresAt",
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
          ...(x.bootstrapPasswordExpiresAt
            ? {
                bootstrapPasswordExpiresAt:
                  x.bootstrapPasswordExpiresAt.toISOString(),
              }
            : {}),
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
          ...(x.bootstrapPasswordExpiresAt
            ? {
                bootstrapPasswordExpiresAt:
                  x.bootstrapPasswordExpiresAt.toISOString(),
              }
            : {}),
        }
      : null;
  }
  async createUserSessionAndAudit(
    organizationId: string,
    input: UserSessionCreateInput,
    audit: UserMutationAuditContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const purpose = input.purpose ?? "FULL";
      const [current] = await tx.$queryRaw<
        Array<{
          id: string;
          passwordHash: string;
          role: string;
          authenticationEpoch: number;
          authorizationEpoch: number;
          bootstrapPasswordExpiresAt: Date | null;
          databaseNow: Date;
        }>
      >`
        SELECT actor."id",
               actor."passwordHash",
               actor."authenticationEpoch",
               membership."role"::text AS "role",
               membership."authorizationEpoch",
               actor."bootstrapPasswordExpiresAt",
               CURRENT_TIMESTAMP AS "databaseNow"
        FROM "Membership" membership
        INNER JOIN "User" actor ON actor."id" = membership."userId"
        WHERE membership."organizationId" = ${organizationId}
          AND membership."userId" = ${audit.actorUserId}
          AND actor."disabledAt" IS NULL
        FOR UPDATE OF membership, actor`;
      const expiresAt = new Date(input.expiresAt);
      const expectedBootstrapPasswordExpiresAt =
        input.expectedBootstrapPasswordExpiresAt === undefined
          ? null
          : new Date(input.expectedBootstrapPasswordExpiresAt);
      if (
        !current ||
        current.passwordHash !== input.expectedPasswordHash ||
        current.role !== input.expectedRole ||
        current.authenticationEpoch !== input.expectedAuthenticationEpoch ||
        current.authorizationEpoch !== input.expectedAuthorizationEpoch ||
        current.bootstrapPasswordExpiresAt?.getTime() !==
          expectedBootstrapPasswordExpiresAt?.getTime() ||
        (purpose === "FULL" && current.bootstrapPasswordExpiresAt !== null) ||
        (purpose === "BOOTSTRAP_PASSWORD_ROTATION" &&
          (!current.bootstrapPasswordExpiresAt ||
            current.bootstrapPasswordExpiresAt <= current.databaseNow ||
            expiresAt > current.bootstrapPasswordExpiresAt ||
            expiresAt.getTime() - current.databaseNow.getTime() >
              10 * 60 * 1000)) ||
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
          purpose,
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
          metadata: { expiresAt: input.expiresAt, purpose },
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
          purpose: session.purpose,
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
        bootstrapPasswordExpiresAt: Date | null;
        sessionPurpose: "FULL" | "BOOTSTRAP_PASSWORD_ROTATION";
      }>
    >`
      SELECT actor."id",
             actor."email",
             actor."name",
             actor."passwordHash",
             membership."role"::text AS "role",
             actor."authenticationEpoch",
             membership."authorizationEpoch",
             actor."bootstrapPasswordExpiresAt",
             session."purpose"::text AS "sessionPurpose"
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
        AND (
          (session."purpose" = 'FULL'::"UserSessionPurpose"
            AND actor."bootstrapPasswordExpiresAt" IS NULL)
          OR
          (session."purpose" = 'BOOTSTRAP_PASSWORD_ROTATION'::"UserSessionPurpose"
            AND actor."bootstrapPasswordExpiresAt" > CURRENT_TIMESTAMP
            AND session."expiresAt" <= actor."bootstrapPasswordExpiresAt")
        )
    `;
    if (!current) return null;
    const { bootstrapPasswordExpiresAt, ...principal } = current;
    return {
      ...principal,
      organizationId,
      ...(bootstrapPasswordExpiresAt
        ? {
            bootstrapPasswordExpiresAt:
              bootstrapPasswordExpiresAt.toISOString(),
          }
        : {}),
    };
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
      const [principal] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT membership."id"
        FROM "Membership" membership
        INNER JOIN "User" actor ON actor."id" = membership."userId"
        WHERE membership."organizationId" = ${organizationId}
          AND membership."userId" = ${userId}
          AND actor."disabledAt" IS NULL
        FOR UPDATE OF membership, actor`;
      if (!principal)
        return { revoked: false as const, reason: "NOT_FOUND" as const };
      const [session] = await tx.$queryRaw<
        Array<{ id: string; databaseNow: Date }>
      >`
        SELECT session."id", CURRENT_TIMESTAMP AS "databaseNow"
        FROM "UserSession" session
        WHERE session."tokenHash" = ${tokenHash}
          AND session."userId" = ${userId}
          AND session."organizationId" = ${organizationId}
          AND session."revokedAt" IS NULL
          AND session."expiresAt" > CURRENT_TIMESTAMP
        FOR UPDATE OF session`;
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
  async rotateBootstrapPasswordAndAudit(
    userId: string,
    organizationId: string,
    input: BootstrapPasswordRotationInput,
    audit: UserMutationAuditContext,
  ) {
    if (!isApprovedPasswordHash(input.passwordHash))
      throw new Error("An approved bcrypt password hash is required");
    if (audit.actorUserId !== userId)
      return { rotated: false as const, reason: "FORBIDDEN" as const };
    return this.prisma.$transaction(async (tx) => {
      const memberships = await tx.$queryRaw<
        Array<{
          organizationId: string;
          passwordHash: string;
          authenticationEpoch: number;
          bootstrapPasswordExpiresAt: Date | null;
          authorizationEpoch: number;
          disabledAt: Date | null;
          databaseNow: Date;
        }>
      >`
        SELECT membership."organizationId",
               actor."passwordHash",
               actor."authenticationEpoch",
               actor."bootstrapPasswordExpiresAt",
               membership."authorizationEpoch",
               actor."disabledAt",
               CURRENT_TIMESTAMP AS "databaseNow"
        FROM "User" actor
        INNER JOIN "Membership" membership
          ON membership."userId" = actor."id"
        WHERE actor."id" = ${userId}
        ORDER BY membership."organizationId" ASC
        FOR UPDATE OF actor, membership`;
      const current = memberships.find(
        (membership) => membership.organizationId === organizationId,
      );
      const expectedMarker = new Date(input.expectedBootstrapPasswordExpiresAt);
      if (
        !current ||
        current.disabledAt ||
        current.passwordHash !== input.expectedPasswordHash ||
        current.authenticationEpoch !== input.expectedAuthenticationEpoch ||
        current.authorizationEpoch !== input.expectedAuthorizationEpoch ||
        !Number.isFinite(expectedMarker.getTime()) ||
        current.bootstrapPasswordExpiresAt?.getTime() !==
          expectedMarker.getTime() ||
        !current.bootstrapPasswordExpiresAt ||
        current.bootstrapPasswordExpiresAt <= current.databaseNow
      )
        return { rotated: false as const, reason: "FORBIDDEN" as const };
      const [session] = await tx.$queryRaw<
        Array<{
          id: string;
          authenticationEpoch: number;
          authorizationEpoch: number;
        }>
      >`
        SELECT session."id",
               session."authenticationEpoch",
               session."authorizationEpoch"
        FROM "UserSession" session
        WHERE session."tokenHash" = ${input.tokenHash}
          AND session."userId" = ${userId}
          AND session."organizationId" = ${organizationId}
          AND session."purpose" = 'BOOTSTRAP_PASSWORD_ROTATION'::"UserSessionPurpose"
          AND session."revokedAt" IS NULL
          AND session."expiresAt" > CURRENT_TIMESTAMP
        FOR UPDATE OF session`;
      if (
        !session ||
        session.authenticationEpoch !== input.expectedAuthenticationEpoch ||
        session.authorizationEpoch !== input.expectedAuthorizationEpoch
      )
        return { rotated: false as const, reason: "FORBIDDEN" as const };
      const organizationIds = memberships.map(({ organizationId: id }) => id);
      await this.revokePendingIssuerGrants(
        tx,
        userId,
        organizationIds,
        current.databaseNow,
      );
      await tx.user.update({
        where: { id: userId },
        data: {
          passwordHash: input.passwordHash,
          bootstrapPasswordExpiresAt: null,
          authenticationEpoch: { increment: 1 },
        },
      });
      await tx.userSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: current.databaseNow },
      });
      await tx.auditEvent.createMany({
        data: organizationIds.map((id) => ({
          organizationId: id,
          actorUserId: userId,
          actorType: "user" as const,
          action: "auth.bootstrap_password_rotated",
          entityType: "user",
          entityId: userId,
          ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
          ...(audit.requestId ? { requestId: audit.requestId } : {}),
          metadata: {},
        })),
      });
      return {
        rotated: true as const,
        affectedOrganizationIds: organizationIds,
      };
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
      await this.revokePendingIssuerGrants(
        tx,
        userId,
        memberships.map(({ organizationId }) => organizationId),
        clock,
      );
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
      const organizationIds = (
        await tx.membership.findMany({
          where: { userId },
          select: { organizationId: true },
          orderBy: { organizationId: "asc" },
        })
      ).map(({ organizationId }) => organizationId);
      if (organizationIds.length === 0)
        return { updated: false as const, reason: "NOT_FOUND" as const };
      if (!(await this.lockOwnerContinuity(tx, organizationIds)))
        return { updated: false as const, reason: "NOT_FOUND" as const };
      const memberships = await tx.$queryRaw<
        Array<{
          organizationId: string;
          role: SessionUser["role"];
          disabledAt: Date | null;
          databaseNow: Date;
        }>
      >`
        SELECT membership."organizationId",
               membership."role"::text AS "role",
               actor."disabledAt",
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
      for (const membership of memberships)
        if (
          !membership.disabledAt &&
          membership.role === "OWNER" &&
          !(await this.hasOtherActiveOwner(
            tx,
            membership.organizationId,
            userId,
          ))
        )
          return {
            updated: false as const,
            reason: "OWNER_CONTINUITY_REQUIRED" as const,
          };
      await this.revokePendingIssuerGrants(
        tx,
        userId,
        memberships.map(({ organizationId }) => organizationId),
        clock,
      );
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
      if (!(await this.lockOwnerContinuity(tx, [organizationId])))
        return { updated: false as const, reason: "NOT_FOUND" as const };
      const [membership] = await tx.$queryRaw<
        Array<{
          id: string;
          role: SessionUser["role"];
          authorizationEpoch: number;
          disabledAt: Date | null;
          databaseNow: Date;
        }>
      >`
        SELECT membership."id",
               membership."role"::text AS "role",
               membership."authorizationEpoch",
               actor."disabledAt",
               CURRENT_TIMESTAMP AS "databaseNow"
        FROM "Membership" membership
        INNER JOIN "User" actor ON actor."id" = membership."userId"
        WHERE membership."organizationId" = ${organizationId}
          AND membership."userId" = ${userId}
        FOR UPDATE OF membership, actor`;
      if (!membership)
        return { updated: false as const, reason: "NOT_FOUND" as const };
      if (
        membership.role === "OWNER" &&
        role !== "OWNER" &&
        !membership.disabledAt &&
        !(await this.hasOtherActiveOwner(tx, organizationId, userId))
      )
        return {
          updated: false as const,
          reason: "OWNER_CONTINUITY_REQUIRED" as const,
        };
      await this.revokePendingIssuerGrants(
        tx,
        userId,
        [organizationId],
        membership.databaseNow,
      );
      await this.replaceCompatibilityGrants(tx, {
        organizationId,
        userId,
        membershipId: membership.id,
        role,
        authorizationEpoch: membership.authorizationEpoch,
        databaseNow: membership.databaseNow,
      });
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
      if (!(await this.lockOwnerContinuity(tx, [organizationId])))
        return { updated: false as const, reason: "NOT_FOUND" as const };
      const [membership] = await tx.$queryRaw<
        Array<{
          id: string;
          role: SessionUser["role"];
          disabledAt: Date | null;
          databaseNow: Date;
        }>
      >`
        SELECT membership."id",
               membership."role"::text AS "role",
               actor."disabledAt",
               CURRENT_TIMESTAMP AS "databaseNow"
        FROM "Membership" membership
        INNER JOIN "User" actor ON actor."id" = membership."userId"
        WHERE membership."organizationId" = ${organizationId}
          AND membership."userId" = ${userId}
        FOR UPDATE OF membership, actor`;
      if (!membership)
        return { updated: false as const, reason: "NOT_FOUND" as const };
      if (
        membership.role === "OWNER" &&
        !membership.disabledAt &&
        !(await this.hasOtherActiveOwner(tx, organizationId, userId))
      )
        return {
          updated: false as const,
          reason: "OWNER_CONTINUITY_REQUIRED" as const,
        };
      await this.revokePendingIssuerGrants(
        tx,
        userId,
        [organizationId],
        membership.databaseNow,
      );
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
  async requestScreenEnrollmentAndAudit(
    org: string,
    screenId: string,
    _expiresAt: string,
    reason: string,
    audit: PairingCreateAuditContext,
    idempotency: ScreenEnrollmentIdempotencyInput,
  ): Promise<ScreenEnrollmentRequestResult> {
    if (
      !lowercaseSha256.test(idempotency.keyHash) ||
      !lowercaseSha256.test(idempotency.requestDigestSha256) ||
      idempotency.codeCandidates.length < 1 ||
      idempotency.codeCandidates.length > 8
    )
      throw new Error("Canonical enrollment idempotency input is required");
    for (let writeAttempt = 0; writeAttempt < 3; writeAttempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const [organization] = await tx.$queryRaw<Array<{ id: string }>>`
              SELECT organization."id" FROM "Organization" organization
              WHERE organization."id" = ${org}
              FOR NO KEY UPDATE OF organization`;
            if (!organization)
              return { created: false as const, reason: "NOT_FOUND" as const };
            const [actor] = await tx.$queryRaw<
              Array<{
                membershipId: string;
                role: string;
                authenticationEpoch: number;
                authorizationEpoch: number;
                databaseNow: Date;
              }>
            >`
              SELECT membership."id" AS "membershipId",
                     membership."role"::text AS "role",
                     actor."authenticationEpoch",
                     membership."authorizationEpoch",
                     CURRENT_TIMESTAMP AS "databaseNow"
              FROM "Membership" membership
              INNER JOIN "User" actor ON actor."id" = membership."userId"
              WHERE membership."organizationId" = ${org}
                AND membership."userId" = ${audit.actorUserId}
                AND actor."disabledAt" IS NULL
              FOR UPDATE OF membership, actor`;
            if (actor?.role !== "OWNER" && actor?.role !== "ADMIN")
              return { created: false as const, reason: "FORBIDDEN" as const };
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`idempotency:${org}:screen-enrollment-create:${idempotency.keyHash}`}, 0))`;
            const existing = await tx.idempotencyRecord.findUnique({
              where: {
                organizationId_operation_keyHash: {
                  organizationId: org,
                  operation: "SCREEN_ENROLLMENT_CREATE",
                  keyHash: idempotency.keyHash,
                },
              },
            });
            if (existing) {
              if (
                existing.actorUserId !== audit.actorUserId ||
                existing.requestDigestSha256 !== idempotency.requestDigestSha256
              )
                return {
                  created: false as const,
                  reason: "IDEMPOTENCY_KEY_REUSED" as const,
                };
              if (
                existing.expiresAt <= actor.databaseNow ||
                existing.responseBody === null
              )
                return {
                  created: false as const,
                  reason: "IDEMPOTENCY_KEY_EXPIRED" as const,
                };
              const response = existing.responseBody as Record<string, unknown>;
              const pairing = await tx.pairingCode.findFirst({
                where: {
                  id: String(response.grantId),
                  organizationId: org,
                  targetScreenId: screenId,
                  purpose: "NEW_SCREEN",
                },
              });
              if (!pairing)
                throw new Error("Enrollment idempotency target is missing");
              await this.pruneDeviceEnrollmentAuthority(
                tx,
                org,
                actor.databaseNow,
                idempotency.keyHash,
              );
              return {
                created: true as const,
                pairing: pairingDto(pairing),
                codeCounter: Number(response.codeCounter),
                replayed: true as const,
              };
            }
            const [target] = await tx.$queryRaw<
              Array<{
                id: string;
                credentialGeneration: number;
                installationId: string | null;
                deviceTokenHash: string | null;
              }>
            >`
              SELECT screen."id", screen."credentialGeneration",
                     screen."installationId", screen."deviceTokenHash"
              FROM "Screen" screen
              WHERE screen."id" = ${screenId} AND screen."organizationId" = ${org}
              FOR UPDATE OF screen`;
            if (!target)
              return { created: false as const, reason: "NOT_FOUND" as const };
            if (
              target.credentialGeneration !== 0 ||
              target.installationId ||
              target.deviceTokenHash ||
              (await tx.deviceCredential.count({
                where: { organizationId: org, screenId },
              })) !== 0
            )
              return {
                created: false as const,
                reason: "SCREEN_NOT_ELIGIBLE" as const,
              };
            let available: { counter: number; codeHash: string } | undefined;
            for (const candidate of idempotency.codeCandidates) {
              const collision = await tx.pairingCode.findFirst({
                where: {
                  codeHash: candidate.codeHash,
                  status: "PENDING",
                  expiresAt: { gt: actor.databaseNow },
                },
                select: { id: true },
              });
              if (!collision) {
                available = candidate;
                break;
              }
              available = undefined;
            }
            if (!available)
              return {
                created: false as const,
                reason: "CODE_COLLISION" as const,
              };
            const competitors = await tx.pairingCode.findMany({
              where: {
                organizationId: org,
                targetScreenId: screenId,
                purpose: "NEW_SCREEN",
                status: "PENDING",
              },
              select: { id: true },
              orderBy: { id: "asc" },
            });
            await this.pruneDeviceEnrollmentAuthority(
              tx,
              org,
              actor.databaseNow,
              idempotency.keyHash,
            );
            await tx.pairingAttempt.updateMany({
              where: {
                pairingCodeId: { in: competitors.map(({ id }) => id) },
                boundCredentialId: null,
              },
              data: { cancelledAt: actor.databaseNow },
            });
            await tx.pairingCode.updateMany({
              where: { id: { in: competitors.map(({ id }) => id) } },
              data: { status: "REVOKED" },
            });
            const grantExpiresAt = new Date(
              actor.databaseNow.getTime() + 10 * 60_000,
            );
            const pairing = await tx.pairingCode.create({
              data: {
                organizationId: org,
                codeHash: available.codeHash,
                expiresAt: grantExpiresAt,
                purpose: "NEW_SCREEN",
                targetScreenId: screenId,
                targetScreenReferenceId: screenId,
                targetOrganizationId: org,
                expectedGeneration: 0,
                authorizedByUserId: audit.actorUserId,
                authorizedByMembershipId: actor.membershipId,
                authorizedByAuthenticationEpoch: actor.authenticationEpoch,
                authorizedByAuthorizationEpoch: actor.authorizationEpoch,
                requestReason: reason,
              },
            });
            await tx.auditEvent.create({
              data: {
                organizationId: org,
                actorUserId: audit.actorUserId,
                actorType: "user",
                action: "device.enrollment.requested",
                entityType: "screen",
                entityId: screenId,
                ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
                ...(audit.requestId ? { requestId: audit.requestId } : {}),
                metadata: {
                  grantId: pairing.id,
                  expectedGeneration: 0,
                  reason,
                },
              },
            });
            await tx.idempotencyRecord.create({
              data: {
                organizationId: org,
                operation: "SCREEN_ENROLLMENT_CREATE",
                keyHash: idempotency.keyHash,
                actorUserId: audit.actorUserId,
                requestDigestSha256: idempotency.requestDigestSha256,
                statusCode: 201,
                responseBody: {
                  grantId: pairing.id,
                  codeCounter: available.counter,
                },
                expiresAt: new Date(
                  actor.databaseNow.getTime() +
                    DEVICE_ENROLLMENT_AUTHORITY_RETENTION_MS,
                ),
              },
            });
            return {
              created: true as const,
              pairing: pairingDto(pairing),
              codeCounter: available.counter,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (isRetryableWriteConflict(error) || isUniqueConstraintError(error))
          continue;
        throw error;
      }
    }
    return { created: false, reason: "CODE_COLLISION" };
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
      return await this.prisma.$transaction(
        async (tx) => {
          const [organization] = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT organization."id" FROM "Organization" organization
          WHERE organization."id" = ${org}
          FOR NO KEY UPDATE OF organization`;
          if (!organization)
            return { created: false as const, reason: "NOT_FOUND" as const };
          const [actor] = await tx.$queryRaw<
            Array<{
              membershipId: string;
              role: string;
              authenticationEpoch: number;
              authorizationEpoch: number;
            }>
          >`
          SELECT membership."id" AS "membershipId",
                 membership."role"::text AS "role",
                 actor."authenticationEpoch",
                 membership."authorizationEpoch"
          FROM "Membership" membership
          INNER JOIN "User" actor ON actor."id" = membership."userId"
          WHERE membership."organizationId" = ${org} AND membership."userId" = ${audit.actorUserId}
            AND actor."disabledAt" IS NULL FOR UPDATE OF membership, actor`;
          if (actor?.role !== "OWNER" && actor?.role !== "ADMIN")
            return { created: false as const, reason: "FORBIDDEN" as const };
          const [locked] = await tx.$queryRaw<
            Array<{
              id: string;
              credentialGeneration: number;
              databaseNow: Date;
            }>
          >`
          SELECT screen."id", screen."credentialGeneration", CURRENT_TIMESTAMP AS "databaseNow"
          FROM "Screen" screen WHERE screen."id" = ${screenId} AND screen."organizationId" = ${org}
          FOR UPDATE OF screen`;
          if (!locked)
            return { created: false as const, reason: "NOT_FOUND" as const };
          await this.pruneDeviceEnrollmentAuthority(
            tx,
            org,
            locked.databaseNow,
          );
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
              lastSeenAt: null,
              manifestVersion: null,
              nowPlayingAssetId: null,
              uptimeSeconds: null,
              freeStorageBytes: null,
              networkType: null,
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
              authorizedByMembershipId: actor.membershipId,
              authorizedByAuthenticationEpoch: actor.authenticationEpoch,
              authorizedByAuthorizationEpoch: actor.authorizationEpoch,
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
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isUniqueConstraintError(error) || isRetryableWriteConflict(error))
        return { created: false as const, reason: "CODE_COLLISION" as const };
      throw error;
    }
  }
  async getReenrollmentStatus(
    org: string,
    screenId: string,
    grantId: string,
    actorUserId: string,
    purpose: "NEW_SCREEN" | "REENROLL" = "REENROLL",
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
        purpose,
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
  async activateScreenEnrollmentCandidateAndAudit(
    org: string,
    screenId: string,
    grantId: string,
    candidateId: string,
    fingerprint: string,
    audit: PairingCreateAuditContext,
    idempotency: ScreenEnrollmentActivationIdempotencyInput,
  ): Promise<ScreenEnrollmentActivationResult> {
    for (let writeAttempt = 0; writeAttempt < 3; writeAttempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const [organization] = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT organization."id" FROM "Organization" organization
            WHERE organization."id" = ${org}
            FOR NO KEY UPDATE OF organization`;
            if (!organization)
              return {
                activated: false as const,
                reason: "NOT_FOUND" as const,
              };
            // Discover the immutable issuer identifier, then lock every involved
            // principal in stable order before any Screen/grant/attempt lock.
            // Identity lifecycle mutations use the same organization -> user /
            // membership order, preventing crossed activator/issuer deadlocks.
            const discoveredGrant = await tx.pairingCode.findFirst({
              where: {
                id: grantId,
                organizationId: org,
                targetScreenId: screenId,
                purpose: "NEW_SCREEN",
              },
              select: { authorizedByUserId: true },
            });
            const principalIds = [
              ...new Set(
                [audit.actorUserId, discoveredGrant?.authorizedByUserId].filter(
                  (value): value is string => Boolean(value),
                ),
              ),
            ].sort();
            const principals = await tx.$queryRaw<
              Array<{
                userId: string;
                membershipId: string;
                role: string;
                authenticationEpoch: number;
                authorizationEpoch: number;
                databaseNow: Date;
              }>
            >`
            SELECT actor."id" AS "userId", membership."id" AS "membershipId",
                   membership."role"::text AS "role", actor."authenticationEpoch",
                   membership."authorizationEpoch", CURRENT_TIMESTAMP AS "databaseNow"
            FROM "Membership" membership
            INNER JOIN "User" actor ON actor."id" = membership."userId"
            WHERE membership."organizationId" = ${org}
              AND membership."userId" IN (${Prisma.join(principalIds)})
              AND actor."disabledAt" IS NULL
            ORDER BY actor."id" ASC
            FOR UPDATE OF membership, actor`;
            const actor = principals.find(
              (principal) => principal.userId === audit.actorUserId,
            );
            if (actor?.role !== "OWNER" && actor?.role !== "ADMIN")
              return {
                activated: false as const,
                reason: "FORBIDDEN" as const,
              };
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`idempotency:${org}:screen-enrollment-activate:${idempotency.keyHash}`}, 0))`;
            const existing = await tx.idempotencyRecord.findUnique({
              where: {
                organizationId_operation_keyHash: {
                  organizationId: org,
                  operation: "SCREEN_ENROLLMENT_ACTIVATE",
                  keyHash: idempotency.keyHash,
                },
              },
            });
            if (existing) {
              if (
                existing.actorUserId !== audit.actorUserId ||
                existing.requestDigestSha256 !== idempotency.requestDigestSha256
              )
                return {
                  activated: false as const,
                  reason: "IDEMPOTENCY_KEY_REUSED" as const,
                };
              if (
                existing.expiresAt <= actor.databaseNow ||
                existing.responseBody === null
              )
                return {
                  activated: false as const,
                  reason: "IDEMPOTENCY_KEY_EXPIRED" as const,
                };
              const response = existing.responseBody as Record<string, unknown>;
              const [screen, credential] = await Promise.all([
                tx.screen.findFirst({
                  where: { id: screenId, organizationId: org },
                }),
                tx.deviceCredential.findFirst({
                  where: {
                    id: String(response.credentialId),
                    organizationId: org,
                    screenId,
                  },
                }),
              ]);
              if (!screen || !credential)
                throw new Error(
                  "Enrollment activation replay target is missing",
                );
              await this.pruneDeviceEnrollmentAuthority(
                tx,
                org,
                actor.databaseNow,
                idempotency.keyHash,
              );
              return {
                activated: true as const,
                screen: screenDto(screen),
                credential: deviceCredentialDto(credential),
                replayed: true as const,
              };
            }
            const [target] = await tx.$queryRaw<
              Array<{
                id: string;
                credentialGeneration: number;
                installationId: string | null;
                deviceTokenHash: string | null;
              }>
            >`
            SELECT screen."id", screen."credentialGeneration",
                   screen."installationId", screen."deviceTokenHash"
            FROM "Screen" screen
            WHERE screen."id" = ${screenId} AND screen."organizationId" = ${org}
            FOR UPDATE OF screen`;
            if (!target)
              return {
                activated: false as const,
                reason: "NOT_FOUND" as const,
              };
            const [grantLock] = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT pairing_grant."id" FROM "PairingCode" pairing_grant
            WHERE pairing_grant."id" = ${grantId}
              AND pairing_grant."organizationId" = ${org}
              AND pairing_grant."targetScreenId" = ${screenId}
              AND pairing_grant."purpose" = 'NEW_SCREEN'::"PairingPurpose"
            FOR UPDATE OF pairing_grant`;
            if (!grantLock)
              return {
                activated: false as const,
                reason: "NOT_FOUND" as const,
              };
            const [attemptLock] = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT attempt."id" FROM "PairingAttempt" attempt
            WHERE attempt."id" = ${candidateId}
              AND attempt."pairingCodeId" = ${grantId}
              AND attempt."organizationId" = ${org}
            FOR UPDATE OF attempt`;
            if (!attemptLock)
              return {
                activated: false as const,
                reason: "NOT_FOUND" as const,
              };
            const attempt = await tx.pairingAttempt.findUnique({
              where: { id: candidateId },
              include: { pairingCode: true },
            });
            if (!attempt || attempt.keyId !== fingerprint)
              return {
                activated: false as const,
                reason: "FINGERPRINT_MISMATCH" as const,
              };
            const grant = attempt.pairingCode;
            const issuer = principals.find(
              (principal) => principal.userId === grant.authorizedByUserId,
            );
            if (
              !issuer ||
              grant.authorizedByUserId !==
                discoveredGrant?.authorizedByUserId ||
              (issuer.role !== "OWNER" && issuer.role !== "ADMIN") ||
              issuer.membershipId !== grant.authorizedByMembershipId ||
              issuer.authenticationEpoch !==
                grant.authorizedByAuthenticationEpoch ||
              issuer.authorizationEpoch !==
                grant.authorizedByAuthorizationEpoch ||
              grant.status !== "PENDING" ||
              grant.expiresAt <= actor.databaseNow ||
              grant.expectedGeneration !== 0 ||
              target.credentialGeneration !== 0 ||
              target.installationId ||
              target.deviceTokenHash ||
              !attempt.provedAt ||
              attempt.cancelledAt ||
              attempt.activatedAt ||
              (await tx.deviceCredential.count({
                where: { organizationId: org, screenId },
              })) !== 0
            )
              return { activated: false as const, reason: "STALE" as const };
            const claimed = await tx.pairingCode.updateMany({
              where: {
                id: grantId,
                organizationId: org,
                targetScreenId: screenId,
                purpose: "NEW_SCREEN",
                status: "PENDING",
                expectedGeneration: 0,
                expiresAt: { gt: actor.databaseNow },
              },
              data: {
                status: "CLAIMED",
                claimedAt: actor.databaseNow,
                screenId,
                screenOrganizationId: org,
              },
            });
            if (claimed.count !== 1)
              return { activated: false as const, reason: "STALE" as const };
            await this.pruneDeviceEnrollmentAuthority(
              tx,
              org,
              actor.databaseNow,
              idempotency.keyHash,
            );
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
                credentialGeneration: 1,
                status: "OFFLINE",
                lastSeenAt: null,
                manifestVersion: null,
                nowPlayingAssetId: null,
                uptimeSeconds: null,
                freeStorageBytes: null,
                networkType: null,
              },
            });
            await tx.pairingAttempt.update({
              where: { id: candidateId },
              data: {
                activatedAt: actor.databaseNow,
                boundCredentialId: credential.id,
              },
            });
            const competitors = await tx.pairingCode.findMany({
              where: {
                organizationId: org,
                targetScreenId: screenId,
                id: { not: grantId },
                status: "PENDING",
              },
              select: { id: true },
            });
            await tx.pairingAttempt.updateMany({
              where: {
                OR: [
                  { pairingCodeId: grantId, id: { not: candidateId } },
                  { pairingCodeId: { in: competitors.map(({ id }) => id) } },
                ],
                boundCredentialId: null,
              },
              data: { cancelledAt: actor.databaseNow },
            });
            await tx.pairingCode.updateMany({
              where: { id: { in: competitors.map(({ id }) => id) } },
              data: { status: "REVOKED" },
            });
            await tx.auditEvent.create({
              data: {
                organizationId: org,
                actorUserId: audit.actorUserId,
                actorType: "user",
                action: "device.enrollment.activated",
                entityType: "screen",
                entityId: screenId,
                ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
                ...(audit.requestId ? { requestId: audit.requestId } : {}),
                metadata: {
                  grantId,
                  candidateId,
                  credentialId: credential.id,
                  keyId: credential.keyId,
                  reason: grant.requestReason,
                },
              },
            });
            await tx.idempotencyRecord.create({
              data: {
                organizationId: org,
                operation: "SCREEN_ENROLLMENT_ACTIVATE",
                keyHash: idempotency.keyHash,
                actorUserId: audit.actorUserId,
                requestDigestSha256: idempotency.requestDigestSha256,
                statusCode: 200,
                responseBody: { credentialId: credential.id },
                expiresAt: new Date(
                  actor.databaseNow.getTime() +
                    DEVICE_ENROLLMENT_AUTHORITY_RETENTION_MS,
                ),
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
        if (isRetryableWriteConflict(error)) continue;
        if (isUniqueConstraintError(error))
          return { activated: false, reason: "STALE" };
        throw error;
      }
    }
    return { activated: false, reason: "STALE" };
  }
  async activateReenrollmentCandidateAndAudit(
    org: string,
    screenId: string,
    grantId: string,
    candidateId: string,
    audit: PairingCreateAuditContext,
  ): Promise<ReenrollmentActivationResult> {
    for (let writeAttempt = 0; writeAttempt < 3; writeAttempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const [organization] = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT organization."id" FROM "Organization" organization
            WHERE organization."id" = ${org}
            FOR NO KEY UPDATE OF organization`;
            if (!organization)
              return {
                activated: false as const,
                reason: "NOT_FOUND" as const,
              };
            const discoveredGrant = await tx.pairingCode.findFirst({
              where: {
                id: grantId,
                organizationId: org,
                targetScreenId: screenId,
                purpose: "REENROLL",
              },
              select: { authorizedByUserId: true },
            });
            const principalIds = [
              ...new Set(
                [audit.actorUserId, discoveredGrant?.authorizedByUserId].filter(
                  (value): value is string => Boolean(value),
                ),
              ),
            ].sort();
            const principals = await tx.$queryRaw<
              Array<{
                userId: string;
                membershipId: string;
                role: string;
                authenticationEpoch: number;
                authorizationEpoch: number;
              }>
            >`SELECT actor."id" AS "userId", membership."id" AS "membershipId",
                   membership."role"::text AS "role", actor."authenticationEpoch",
                   membership."authorizationEpoch"
             FROM "Membership" membership
             INNER JOIN "User" actor ON actor."id" = membership."userId"
             WHERE membership."organizationId"=${org}
               AND membership."userId" IN (${Prisma.join(principalIds)})
               AND actor."disabledAt" IS NULL
             ORDER BY actor."id" ASC
             FOR UPDATE OF membership, actor`;
            const actor = principals.find(
              (principal) => principal.userId === audit.actorUserId,
            );
            if (actor?.role !== "OWNER" && actor?.role !== "ADMIN")
              return {
                activated: false as const,
                reason: "FORBIDDEN" as const,
              };
            const [locked] = await tx.$queryRaw<
              Array<{
                id: string;
                credentialGeneration: number;
                databaseNow: Date;
              }>
            >`SELECT screen."id", screen."credentialGeneration", CURRENT_TIMESTAMP AS "databaseNow" FROM "Screen" screen WHERE screen."id"=${screenId} AND screen."organizationId"=${org} FOR UPDATE OF screen`;
            if (!locked)
              return {
                activated: false as const,
                reason: "NOT_FOUND" as const,
              };
            const [grantLock] = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT pairing_grant."id" FROM "PairingCode" pairing_grant
            WHERE pairing_grant."id" = ${grantId} AND pairing_grant."organizationId" = ${org}
              AND pairing_grant."targetScreenId" = ${screenId}
              AND pairing_grant."purpose" = 'REENROLL'::"PairingPurpose"
            FOR UPDATE OF pairing_grant`;
            if (!grantLock)
              return {
                activated: false as const,
                reason: "NOT_FOUND" as const,
              };
            const [attemptLock] = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT attempt."id" FROM "PairingAttempt" attempt
            WHERE attempt."id" = ${candidateId}
              AND attempt."pairingCodeId" = ${grantId}
              AND attempt."organizationId" = ${org}
            FOR UPDATE OF attempt`;
            if (!attemptLock)
              return {
                activated: false as const,
                reason: "NOT_FOUND" as const,
              };
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
                  await tx.screen.findUniqueOrThrow({
                    where: { id: screenId },
                  }),
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
              return {
                activated: false as const,
                reason: "NOT_FOUND" as const,
              };
            const issuer = principals.find(
              (principal) =>
                principal.userId === attempt.pairingCode.authorizedByUserId,
            );
            if (
              !issuer ||
              attempt.pairingCode.authorizedByUserId !==
                discoveredGrant?.authorizedByUserId ||
              (issuer.role !== "OWNER" && issuer.role !== "ADMIN") ||
              issuer.membershipId !==
                attempt.pairingCode.authorizedByMembershipId ||
              issuer.authenticationEpoch !==
                attempt.pairingCode.authorizedByAuthenticationEpoch ||
              issuer.authorizationEpoch !==
                attempt.pairingCode.authorizedByAuthorizationEpoch ||
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
                status: "OFFLINE",
                lastSeenAt: null,
                manifestVersion: null,
                nowPlayingAssetId: null,
                uptimeSeconds: null,
                freeStorageBytes: null,
                networkType: null,
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
        if (isRetryableWriteConflict(error) && writeAttempt < 2) continue;
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
    return { activated: false, reason: "STALE" };
  }
  async cancelScreenReenrollmentAndAudit(
    org: string,
    screenId: string,
    grantId: string,
    audit: PairingCreateAuditContext,
    purpose: "NEW_SCREEN" | "REENROLL" = "REENROLL",
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
            AND pairing_grant."purpose" = ${purpose}::"PairingPurpose"
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
              purpose,
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
              action:
                purpose === "REENROLL"
                  ? "device.reenrollment.cancelled"
                  : "device.enrollment.cancelled",
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
        where: {
          codeHash,
          status: "PENDING",
          purpose: "NEW_SCREEN",
          targetScreenId: null,
          authorizedByUserId: null,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
        where: {
          codeHash,
          status: "PENDING",
          purpose: "NEW_SCREEN",
          targetScreenId: null,
          authorizedByUserId: null,
        },
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
        if (pairing.authorizedByUserId) {
          const issuer = await tx.membership.findFirst({
            where: {
              id: pairing.authorizedByMembershipId ?? "",
              organizationId: pairing.organizationId,
              userId: pairing.authorizedByUserId,
              authorizationEpoch: pairing.authorizedByAuthorizationEpoch ?? -1,
              role: { in: ["OWNER", "ADMIN"] },
              user: {
                disabledAt: null,
                authenticationEpoch:
                  pairing.authorizedByAuthenticationEpoch ?? -1,
              },
            },
            select: { id: true },
          });
          if (!issuer) return null;
        } else if (pairing.targetScreenId) return null;
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
    const authorityHint = await this.prisma.pairingAttempt.findFirst({
      where: {
        id: input.pairingAttemptId,
        pairingCode: { codeHash: input.codeHash },
      },
      select: {
        organizationId: true,
        pairingCode: { select: { authorizedByUserId: true } },
      },
    });
    if (!authorityHint)
      return { paired: false as const, reason: "INVALID" as const };
    for (let writeAttempt = 0; writeAttempt < 3; writeAttempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const [organization] = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT organization."id" FROM "Organization" organization
            WHERE organization."id" = ${authorityHint.organizationId}
            FOR NO KEY UPDATE OF organization`;
            if (!organization)
              return { paired: false as const, reason: "INVALID" as const };
            if (authorityHint.pairingCode.authorizedByUserId) {
              const [issuerLock] = await tx.$queryRaw<Array<{ id: string }>>`
              SELECT membership."id" FROM "Membership" membership
              INNER JOIN "User" issuer ON issuer."id" = membership."userId"
              WHERE membership."organizationId" = ${authorityHint.organizationId}
                AND membership."userId" = ${authorityHint.pairingCode.authorizedByUserId}
              FOR UPDATE OF membership, issuer`;
              if (!issuerLock)
                return { paired: false as const, reason: "INVALID" as const };
            }
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
              (attempt.pairingCode.purpose === "REENROLL" ||
                attempt.pairingCode.purpose === "NEW_SCREEN") &&
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
            if (
              attempt.pairingCode.purpose === "REENROLL" ||
              attempt.pairingCode.purpose === "NEW_SCREEN"
            ) {
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
                (attempt.pairingCode.authorizedByMembershipId != null &&
                  (issuer.id !== attempt.pairingCode.authorizedByMembershipId ||
                    attempt.pairingCode.authorizedByAuthenticationEpoch ==
                      null ||
                    attempt.pairingCode.authorizedByAuthorizationEpoch ==
                      null ||
                    (await tx.user.count({
                      where: {
                        id: attempt.pairingCode.authorizedByUserId!,
                        disabledAt: null,
                        authenticationEpoch:
                          attempt.pairingCode.authorizedByAuthenticationEpoch,
                      },
                    })) !== 1 ||
                    (await tx.membership.count({
                      where: {
                        id: attempt.pairingCode.authorizedByMembershipId,
                        authorizationEpoch:
                          attempt.pairingCode.authorizedByAuthorizationEpoch,
                      },
                    })) !== 1)) ||
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
                  action:
                    attempt.pairingCode.purpose === "REENROLL"
                      ? "device.reenrollment.candidate_proved"
                      : "device.enrollment.candidate_proved",
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
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (isRetryableWriteConflict(error) && writeAttempt < 2) continue;
        if (isUniqueConstraintError(error) || isRetryableWriteConflict(error))
          return { paired: false as const, reason: "INVALID" as const };
        throw error;
      }
    }
    return { paired: false as const, reason: "INVALID" as const };
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
        await this.pruneOldDeviceAuthChallenges(tx, locked.databaseNow);
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
            lastSeenAt: null,
            manifestVersion: null,
            nowPlayingAssetId: null,
            uptimeSeconds: null,
            freeStorageBytes: null,
            networkType: null,
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
          lastSeenAt: null,
          manifestVersion: null,
          nowPlayingAssetId: null,
          uptimeSeconds: null,
          freeStorageBytes: null,
          networkType: null,
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
    const schedules = await this.prisma.schedule.findMany({
      where: { organizationId: org },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: {
        targets: true,
        releaseAssignments: { take: 1, select: { id: true } },
      },
    });
    if (schedules.length === 0) return [];
    const assignments = await this.prisma.releaseAssignment.findMany({
      where: {
        organizationId: org,
        scheduleId: { in: schedules.map(({ id }) => id) },
        state: "ASSIGNED",
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: {
        targets: true,
        release: { include: { items: { orderBy: { position: "asc" } } } },
        finalPublication: { include: { publishedCandidate: true } },
        nextAssignments: {
          include: {
            targets: true,
            release: { include: { items: { orderBy: { position: "asc" } } } },
          },
        },
      },
    });
    const activeAssignments = new Map(
      assignments
        .filter(
          (assignment) =>
            hasPublishedAssignmentProvenance(assignment) &&
            verifiedReleaseAssignmentDtos(assignment) &&
            !hasValidWithdrawalSuccessor(assignment),
        )
        .map((assignment) => [assignment.scheduleId, assignment] as const),
    );
    return schedules
      .filter(
        (schedule) =>
          schedule.releaseAssignments.length === 0 ||
          activeAssignments.has(schedule.id),
      )
      .map((schedule) => {
        const assignment = activeAssignments.get(schedule.id);
        return {
          ...scheduleDto(schedule),
          withdrawable: Boolean(assignment),
          ...(assignment
            ? { releaseId: assignment.releaseId, assignmentId: assignment.id }
            : {}),
        };
      });
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
  async listReleaseCandidates(org: string) {
    const candidates = await this.prisma.releaseCandidate.findMany({
      where: { organizationId: org },
      include: {
        targets: true,
        release: { include: { items: { orderBy: { position: "asc" } } } },
        approval: true,
        publication: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return candidates.map((candidate) => releaseCandidateDto(candidate));
  }

  async getReleaseCandidate(org: string, candidateId: string) {
    const candidate = await this.prisma.releaseCandidate.findFirst({
      where: { id: candidateId, organizationId: org },
      include: {
        targets: true,
        release: { include: { items: { orderBy: { position: "asc" } } } },
        approval: true,
        publication: true,
      },
    });
    return candidate ? releaseCandidateDto(candidate) : null;
  }

  async createReleaseCandidateAndAudit(
    org: string,
    data: SchedulePublicationInput & { expiresAt: string },
    audit: ReleaseAuditContext,
    policy: ReleasePublicationPolicy,
    idempotency: ReleaseCandidateIdempotencyInput,
  ): Promise<ReleaseCandidateResult> {
    if (
      !lowercaseSha256.test(idempotency.keyHash) ||
      !lowercaseSha256.test(idempotency.requestDigestSha256)
    )
      throw new Error("Canonical candidate idempotency hashes are required");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const actor = await this.lockReleaseActor(
              tx,
              org,
              audit.actorUserId,
            );
            if (
              !hasCapability(actor?.role, CAPABILITIES.releaseCandidateCreate)
            )
              return { completed: false, reason: "FORBIDDEN" };
            const [clock] = await tx.$queryRaw<Array<{ databaseNow: Date }>>`
              SELECT CURRENT_TIMESTAMP AS "databaseNow"`;
            if (!clock) throw new Error("Database clock is unavailable");
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`candidate-idempotency:${org}:create:${idempotency.keyHash}`}, 0))`;
            const existing = await tx.idempotencyRecord.findUnique({
              where: {
                organizationId_operation_keyHash: {
                  organizationId: org,
                  operation: "RELEASE_CANDIDATE_CREATE",
                  keyHash: idempotency.keyHash,
                },
              },
            });
            if (existing) {
              if (
                existing.actorUserId !== audit.actorUserId ||
                existing.requestDigestSha256 !== idempotency.requestDigestSha256
              )
                return { completed: false, reason: "IDEMPOTENCY_KEY_REUSED" };
              if (
                existing.expiresAt <= clock.databaseNow ||
                existing.responseBody === null
              )
                return {
                  completed: false,
                  reason: "IDEMPOTENCY_KEY_EXPIRED",
                };
              const replay = await this.verifiedReleaseCandidateReplay(
                tx,
                org,
                "create",
                existing.responseBody,
              );
              if (!replay)
                throw new Error(
                  "Idempotent candidate response references are invalid",
                );
              return { completed: true, candidate: replay, replayed: true };
            }
            const expiry = new Date(data.expiresAt);
            if (
              expiry <= clock.databaseNow ||
              expiry.getTime() >
                clock.databaseNow.getTime() + 7 * 24 * 60 * 60_000
            )
              return { completed: false, reason: "EXPIRED" };
            const expired = await tx.releaseCandidate.findMany({
              where: {
                organizationId: org,
                state: { in: ["DRAFT", "IN_REVIEW", "APPROVED"] },
                expiresAt: {
                  lte: new Date(
                    clock.databaseNow.getTime() -
                      RELEASE_CANDIDATE_RESPONSE_RETENTION_MS,
                  ),
                },
                publication: null,
              },
              select: { id: true, releaseId: true },
              orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
              take: 20,
            });
            if (expired.length > 0) {
              const expiredIds = expired.map(
                ({ id: candidateId }) => candidateId,
              );
              const releaseIds = expired.map(({ releaseId }) => releaseId);
              await tx.$executeRaw`UPDATE "IdempotencyRecord"
                SET "responseBody"=NULL
                WHERE "organizationId"=${org}
                  AND "operation"::text IN ('RELEASE_CANDIDATE_CREATE','RELEASE_CANDIDATE_SUBMIT','RELEASE_CANDIDATE_APPROVE')
                  AND "responseBody"->>'id' = ANY(${expiredIds}::text[])`;
              for (const expiredCandidate of expired) {
                await tx.$executeRaw`SELECT set_config('screengoblin.candidate_gc_id', ${expiredCandidate.id}, true)`;
                await tx.releaseCandidate.delete({
                  where: { id: expiredCandidate.id },
                });
              }
              await tx.publishedRelease.deleteMany({
                where: {
                  organizationId: org,
                  id: { in: releaseIds },
                  candidates: { none: {} },
                  assignments: { none: {} },
                },
              });
              await tx.auditEvent.create({
                data: {
                  organizationId: org,
                  actorUserId: audit.actorUserId,
                  actorType: "user",
                  action: "release.candidate.expired_pruned",
                  entityType: "release_candidate",
                  metadata: { count: expired.length },
                },
              });
            }
            const screenIds = [...new Set(data.screenIds)].sort();
            if (screenIds.length === 0 || screenIds.length > 1000)
              return { completed: false, reason: "SCREEN_NOT_FOUND" };
            const outstanding = await tx.releaseCandidate.count({
              where: {
                organizationId: org,
                state: { not: "PUBLISHED" },
                expiresAt: { gt: clock.databaseNow },
              },
            });
            if (outstanding >= 100)
              return { completed: false, reason: "RELEASE_TOO_LARGE" };
            const retained = await tx.releaseCandidate.count({
              where: {
                organizationId: org,
                state: { not: "PUBLISHED" },
              },
            });
            if (retained >= 1000)
              return { completed: false, reason: "RELEASE_TOO_LARGE" };
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
              return { completed: false, reason: "PLAYLIST_NOT_FOUND" };
            const screens = await tx.screen.findMany({
              where: { organizationId: org, id: { in: screenIds } },
              select: { id: true },
            });
            if (screens.length !== screenIds.length)
              return { completed: false, reason: "SCREEN_NOT_FOUND" };
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
              return { completed: false, reason: "ASSET_NOT_ALLOWED" };
            const mediaFailure = mediaPublicationFailure(
              assets,
              clock.databaseNow,
            );
            if (mediaFailure) return { completed: false, reason: mediaFailure };
            let releaseSnapshot;
            try {
              releaseSnapshot = canonicalReleaseSnapshot(
                playlistRecord,
                assets,
              );
            } catch (error) {
              if (error instanceof ReleaseSnapshotError)
                return { completed: false, reason: error.reason };
              throw error;
            }
            const releaseDigestSha256 = releaseSnapshotDigest(releaseSnapshot);
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`release:${org}:${releaseDigestSha256}`}, 0))`;
            let release = await tx.publishedRelease.findUnique({
              where: {
                organizationId_digestSha256: {
                  organizationId: org,
                  digestSha256: releaseDigestSha256,
                },
              },
              include: { items: { orderBy: { position: "asc" } } },
            });
            if (!release) {
              release = await tx.publishedRelease.create({
                data: {
                  organizationId: org,
                  sourcePlaylistId: releaseSnapshot.sourcePlaylistId,
                  sourcePlaylistName: releaseSnapshot.playlistName,
                  sourcePlaylistDescription:
                    releaseSnapshot.playlistDescription,
                  sourcePlaylistUpdatedAt: new Date(
                    releaseSnapshot.sourcePlaylistUpdatedAt,
                  ),
                  digestSha256: releaseDigestSha256,
                  createdById: audit.actorUserId,
                  items: {
                    create: releaseSnapshot.items.map((item) => ({
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
            const schedule = {
              name: data.name,
              priority: data.priority,
              startsAt: canonicalUtcInstant(data.startsAt),
              ...(data.endsAt
                ? { endsAt: canonicalUtcInstant(data.endsAt) }
                : {}),
              timezone: data.timezone,
              daysOfWeek: [...new Set(data.daysOfWeek)].sort((a, b) => a - b),
              ...(data.dailyStartMinutes !== undefined
                ? { dailyStartMinutes: data.dailyStartMinutes }
                : {}),
              ...(data.dailyEndMinutes !== undefined
                ? { dailyEndMinutes: data.dailyEndMinutes }
                : {}),
              enabled: data.enabled,
            };
            const candidateSnapshot = canonicalReleaseCandidateSnapshot({
              releaseDigestSha256,
              schedule,
              screenIds,
              expiresAt: expiry.toISOString(),
            });
            const candidate = await tx.releaseCandidate.create({
              data: {
                organizationId: org,
                releaseId: release.id,
                digestSha256: releaseCandidateDigest(candidateSnapshot),
                authorUserId: audit.actorUserId,
                scheduleName: candidateSnapshot.schedule.name,
                priority: candidateSnapshot.schedule.priority.toUpperCase() as
                  "NORMAL" | "CAMPAIGN" | "PRIORITY",
                startsAt: new Date(candidateSnapshot.schedule.startsAt),
                endsAt: candidateSnapshot.schedule.endsAt
                  ? new Date(candidateSnapshot.schedule.endsAt)
                  : null,
                timezone: candidateSnapshot.schedule.timezone,
                daysOfWeek: candidateSnapshot.schedule.daysOfWeek,
                dailyStartMinutes:
                  candidateSnapshot.schedule.dailyStartMinutes ?? null,
                dailyEndMinutes:
                  candidateSnapshot.schedule.dailyEndMinutes ?? null,
                enabled: candidateSnapshot.schedule.enabled,
                expiresAt: expiry,
                targets: {
                  create: screenIds.map((screenId) => ({
                    screenId,
                    liveScreenId: screenId,
                    liveScreenOrganizationId: org,
                  })),
                },
              },
              include: {
                targets: true,
                release: {
                  include: { items: { orderBy: { position: "asc" } } },
                },
                approval: true,
                publication: true,
              },
            });
            const response = releaseCandidateDto(candidate);
            const authorizationShadow =
              await this.releaseCandidateCreateAuthorizationShadow(tx, {
                organizationId: org,
                actorUserId: audit.actorUserId,
                actor: actor!,
                screenIds,
                databaseNow: clock.databaseNow,
              });
            await tx.auditEvent.create({
              data: {
                organizationId: org,
                actorUserId: audit.actorUserId,
                actorType: "user",
                action: "release.candidate.created",
                entityType: "release_candidate",
                entityId: candidate.id,
                ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
                ...(audit.requestId ? { requestId: audit.requestId } : {}),
                metadata: {
                  digestSha256: response.digestSha256,
                  releaseDigestSha256,
                  screenCount: screenIds.length,
                  policyVersion: response.policyVersion,
                  authorizationShadow,
                },
              },
            });
            await tx.idempotencyRecord.create({
              data: {
                organizationId: org,
                operation: "RELEASE_CANDIDATE_CREATE",
                keyHash: idempotency.keyHash,
                actorUserId: audit.actorUserId,
                requestDigestSha256: idempotency.requestDigestSha256,
                statusCode: 201,
                responseBody: JSON.parse(JSON.stringify(response)),
                expiresAt: new Date(
                  clock.databaseNow.getTime() +
                    RELEASE_CANDIDATE_RESPONSE_RETENTION_MS,
                ),
              },
            });
            await this.compactExpiredIdempotencyResponses(
              tx,
              clock.databaseNow,
            );
            return { completed: true, candidate: response };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (attempt < 2 && isRetryableWriteConflict(error)) continue;
        throw error;
      }
    }
    throw new Error("Candidate creation retry budget exhausted");
  }

  async submitReleaseCandidateAndAudit(
    org: string,
    candidateId: string,
    expectedDigestSha256: string,
    audit: ReleaseAuditContext,
    idempotency: ReleaseCandidateIdempotencyInput,
  ) {
    return this.transitionReleaseCandidateAndAudit(
      org,
      "submit",
      candidateId,
      expectedDigestSha256,
      audit,
      idempotency,
    );
  }

  async approveReleaseCandidateAndAudit(
    org: string,
    candidateId: string,
    expectedDigestSha256: string,
    audit: ReleaseAuditContext,
    idempotency: ReleaseCandidateIdempotencyInput,
  ) {
    return this.transitionReleaseCandidateAndAudit(
      org,
      "approve",
      candidateId,
      expectedDigestSha256,
      audit,
      idempotency,
    );
  }

  private async transitionReleaseCandidateAndAudit(
    org: string,
    operation: "submit" | "approve",
    candidateId: string,
    expectedDigestSha256: string,
    audit: ReleaseAuditContext,
    idempotency: ReleaseCandidateIdempotencyInput,
  ): Promise<ReleaseCandidateResult> {
    if (
      !lowercaseSha256.test(expectedDigestSha256) ||
      !lowercaseSha256.test(idempotency.keyHash) ||
      !lowercaseSha256.test(idempotency.requestDigestSha256)
    )
      throw new Error("Canonical candidate hashes are required");
    const capability =
      operation === "submit"
        ? CAPABILITIES.releaseCandidateSubmit
        : CAPABILITIES.releaseApprove;
    const prismaOperation =
      operation === "submit"
        ? "RELEASE_CANDIDATE_SUBMIT"
        : "RELEASE_CANDIDATE_APPROVE";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const actor = await this.lockReleaseActor(
              tx,
              org,
              audit.actorUserId,
            );
            if (!hasCapability(actor?.role, capability))
              return { completed: false, reason: "FORBIDDEN" };
            const [clock] = await tx.$queryRaw<Array<{ databaseNow: Date }>>`
              SELECT CURRENT_TIMESTAMP AS "databaseNow"`;
            if (!clock) throw new Error("Database clock is unavailable");
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`candidate-idempotency:${org}:${operation}:${idempotency.keyHash}`}, 0))`;
            const existing = await tx.idempotencyRecord.findUnique({
              where: {
                organizationId_operation_keyHash: {
                  organizationId: org,
                  operation: prismaOperation,
                  keyHash: idempotency.keyHash,
                },
              },
            });
            if (existing) {
              if (
                existing.actorUserId !== audit.actorUserId ||
                existing.requestDigestSha256 !== idempotency.requestDigestSha256
              )
                return { completed: false, reason: "IDEMPOTENCY_KEY_REUSED" };
              if (
                existing.expiresAt <= clock.databaseNow ||
                existing.responseBody === null
              )
                return {
                  completed: false,
                  reason: "IDEMPOTENCY_KEY_EXPIRED",
                };
              const replay = await this.verifiedReleaseCandidateReplay(
                tx,
                org,
                operation,
                existing.responseBody,
              );
              if (!replay)
                throw new Error(
                  "Idempotent candidate response references are invalid",
                );
              return { completed: true, candidate: replay, replayed: true };
            }
            await tx.$queryRaw`SELECT "id" FROM "ReleaseCandidate"
              WHERE "id" = ${candidateId} AND "organizationId" = ${org}
              FOR UPDATE`;
            const candidate = await tx.releaseCandidate.findFirst({
              where: { id: candidateId, organizationId: org },
              include: {
                targets: true,
                release: {
                  include: { items: { orderBy: { position: "asc" } } },
                },
                approval: true,
                publication: true,
              },
            });
            if (!candidate) return { completed: false, reason: "NOT_FOUND" };
            const record = releaseCandidateDto(candidate);
            const validDigest =
              record.policyVersion === 1 &&
              record.digestSha256 ===
                releaseCandidateDigest(
                  canonicalReleaseCandidateSnapshot({
                    releaseDigestSha256: record.releaseDigestSha256,
                    schedule: record.schedule,
                    screenIds: record.screenIds,
                    expiresAt: record.expiresAt,
                  }),
                );
            if (
              record.digestSha256 !== expectedDigestSha256 ||
              !validDigest ||
              !hasValidStoredReleaseDigest(
                publishedReleaseDto(candidate.release),
              )
            )
              return { completed: false, reason: "STALE_DIGEST" };
            if (candidate.expiresAt <= clock.databaseNow)
              return { completed: false, reason: "EXPIRED" };
            if (operation === "submit") {
              if (candidate.authorUserId !== audit.actorUserId)
                return { completed: false, reason: "FORBIDDEN" };
              if (candidate.state !== "DRAFT")
                return { completed: false, reason: "INVALID_STATE" };
              await tx.releaseCandidate.update({
                where: { id: candidate.id },
                data: { state: "IN_REVIEW", submittedAt: clock.databaseNow },
              });
            } else {
              if (candidate.authorUserId === audit.actorUserId)
                return {
                  completed: false,
                  reason: "AUTHOR_CANNOT_APPROVE",
                };
              if (candidate.state !== "IN_REVIEW")
                return { completed: false, reason: "INVALID_STATE" };
              await tx.releaseApproval.create({
                data: {
                  organizationId: org,
                  candidateId: candidate.id,
                  candidateDigestSha256: candidate.digestSha256,
                  approverUserId: audit.actorUserId,
                  authenticationEpoch: actor!.authenticationEpoch,
                  authorizationEpoch: actor!.authorizationEpoch,
                  approvedAt: clock.databaseNow,
                },
              });
              await tx.releaseCandidate.update({
                where: { id: candidate.id },
                data: { state: "APPROVED", approvedAt: clock.databaseNow },
              });
            }
            await tx.auditEvent.create({
              data: {
                organizationId: org,
                actorUserId: audit.actorUserId,
                actorType: "user",
                action:
                  operation === "submit"
                    ? "release.candidate.submitted"
                    : "release.candidate.approved",
                entityType: "release_candidate",
                entityId: candidate.id,
                ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
                ...(audit.requestId ? { requestId: audit.requestId } : {}),
                metadata: { digestSha256: candidate.digestSha256 },
              },
            });
            const updated = await tx.releaseCandidate.findUniqueOrThrow({
              where: { id: candidate.id },
              include: {
                targets: true,
                release: {
                  include: { items: { orderBy: { position: "asc" } } },
                },
                approval: true,
                publication: true,
              },
            });
            const response = releaseCandidateDto(updated);
            await tx.idempotencyRecord.create({
              data: {
                organizationId: org,
                operation: prismaOperation,
                keyHash: idempotency.keyHash,
                actorUserId: audit.actorUserId,
                requestDigestSha256: idempotency.requestDigestSha256,
                statusCode: 200,
                responseBody: JSON.parse(JSON.stringify(response)),
                expiresAt: new Date(
                  clock.databaseNow.getTime() +
                    RELEASE_CANDIDATE_RESPONSE_RETENTION_MS,
                ),
              },
            });
            await this.compactExpiredIdempotencyResponses(
              tx,
              clock.databaseNow,
            );
            return { completed: true, candidate: response };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (attempt < 2 && isRetryableWriteConflict(error)) continue;
        throw error;
      }
    }
    throw new Error("Candidate transition retry budget exhausted");
  }

  async publishReleaseCandidateAndAudit(
    org: string,
    candidateId: string,
    expectedDigestSha256: string,
    audit: ReleaseAuditContext,
    policy: ReleasePublicationPolicy,
    idempotency: ReleaseCandidateIdempotencyInput,
  ): Promise<ReleaseCandidateResult> {
    if (
      !lowercaseSha256.test(expectedDigestSha256) ||
      !lowercaseSha256.test(idempotency.keyHash) ||
      !lowercaseSha256.test(idempotency.requestDigestSha256)
    )
      throw new Error("Canonical candidate hashes are required");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const actor = await this.lockReleaseActor(
              tx,
              org,
              audit.actorUserId,
            );
            if (!hasCapability(actor?.role, CAPABILITIES.releasePublish))
              return { completed: false, reason: "FORBIDDEN" };
            const [clock] = await tx.$queryRaw<Array<{ databaseNow: Date }>>`
              SELECT CURRENT_TIMESTAMP AS "databaseNow"`;
            if (!clock) throw new Error("Database clock is unavailable");
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`candidate-idempotency:${org}:publish:${idempotency.keyHash}`}, 0))`;
            const existing = await tx.idempotencyRecord.findUnique({
              where: {
                organizationId_operation_keyHash: {
                  organizationId: org,
                  operation: "RELEASE_CANDIDATE_PUBLISH",
                  keyHash: idempotency.keyHash,
                },
              },
            });
            if (existing) {
              if (
                existing.actorUserId !== audit.actorUserId ||
                existing.requestDigestSha256 !== idempotency.requestDigestSha256
              )
                return { completed: false, reason: "IDEMPOTENCY_KEY_REUSED" };
              if (
                existing.expiresAt <= clock.databaseNow ||
                existing.responseBody === null
              )
                return {
                  completed: false,
                  reason: "IDEMPOTENCY_KEY_EXPIRED",
                };
              const replay = await this.verifiedReleaseCandidateReplay(
                tx,
                org,
                "publish",
                existing.responseBody,
              );
              if (!replay)
                throw new Error(
                  "Idempotent candidate response references are invalid",
                );
              return { completed: true, candidate: replay, replayed: true };
            }
            await tx.$queryRaw`SELECT "id" FROM "ReleaseCandidate"
              WHERE "id" = ${candidateId} AND "organizationId" = ${org}
              FOR UPDATE`;
            const candidate = await tx.releaseCandidate.findFirst({
              where: { id: candidateId, organizationId: org },
              include: {
                targets: true,
                release: {
                  include: { items: { orderBy: { position: "asc" } } },
                },
                approval: true,
                publication: true,
              },
            });
            if (!candidate) return { completed: false, reason: "NOT_FOUND" };
            const record = releaseCandidateDto(candidate);
            const validDigest =
              record.policyVersion === 1 &&
              record.digestSha256 ===
                releaseCandidateDigest(
                  canonicalReleaseCandidateSnapshot({
                    releaseDigestSha256: record.releaseDigestSha256,
                    schedule: record.schedule,
                    screenIds: record.screenIds,
                    expiresAt: record.expiresAt,
                  }),
                );
            if (
              record.digestSha256 !== expectedDigestSha256 ||
              !validDigest ||
              !hasValidStoredReleaseDigest(
                publishedReleaseDto(candidate.release),
              )
            )
              return { completed: false, reason: "STALE_DIGEST" };
            const frozenRelease = publishedReleaseDto(candidate.release);
            const frozenAssets = frozenRelease.items.map((item) => item.asset);
            if (
              frozenAssets.some(
                (asset) =>
                  !mediaUrlMatchesAllowedOrigin(
                    asset.url,
                    policy.mediaAllowedOrigins,
                  ),
              )
            )
              return { completed: false, reason: "ASSET_NOT_ALLOWED" };
            const mediaFailure = mediaPublicationFailure(
              frozenAssets,
              clock.databaseNow,
            );
            if (mediaFailure) return { completed: false, reason: mediaFailure };
            if (candidate.expiresAt <= clock.databaseNow)
              return { completed: false, reason: "EXPIRED" };
            if (candidate.state !== "APPROVED" || !candidate.approval)
              return { completed: false, reason: "INVALID_STATE" };
            const approver = await this.lockReleaseActor(
              tx,
              org,
              candidate.approval.approverUserId,
            );
            if (
              candidate.approval.approverUserId === candidate.authorUserId ||
              candidate.approval.candidateDigestSha256 !==
                candidate.digestSha256 ||
              !hasCapability(approver?.role, CAPABILITIES.releaseApprove) ||
              approver?.authenticationEpoch !==
                candidate.approval.authenticationEpoch ||
              approver.authorizationEpoch !==
                candidate.approval.authorizationEpoch
            )
              return { completed: false, reason: "APPROVAL_STALE" };
            if (
              candidate.targets.length === 0 ||
              candidate.targets.some(
                (target) =>
                  target.liveScreenId === null ||
                  target.liveScreenOrganizationId !== org,
              )
            )
              return { completed: false, reason: "SCREEN_NOT_FOUND" };
            const schedule = await tx.schedule.create({
              data: {
                organizationId: org,
                playlistId: candidate.release.sourcePlaylistId,
                name: candidate.scheduleName,
                priority: candidate.priority,
                startsAt: candidate.startsAt,
                endsAt: candidate.endsAt,
                timezone: candidate.timezone,
                daysOfWeek: candidate.daysOfWeek,
                dailyStartMinutes: candidate.dailyStartMinutes,
                dailyEndMinutes: candidate.dailyEndMinutes,
                enabled: candidate.enabled,
                targets: {
                  create: candidate.targets.map(({ screenId }) => ({
                    screenId,
                  })),
                },
              },
              include: { targets: true },
            });
            const assignmentDigest = assignmentSnapshotDigest(
              canonicalAssignmentSnapshot({
                releaseDigestSha256: record.releaseDigestSha256,
                state: "ASSIGNED",
                schedule: record.schedule,
                screenIds: record.screenIds,
              }),
            );
            const assignmentId = randomUUID();
            const publicationId = randomUUID();
            const expectedWithdrawalDigestSha256 = assignmentSnapshotDigest(
              canonicalAssignmentSnapshot({
                releaseDigestSha256: record.releaseDigestSha256,
                state: "WITHDRAWN",
                schedule: record.schedule,
                screenIds: record.screenIds,
                previousAssignmentId: assignmentId,
              }),
            );
            const assignment = await tx.releaseAssignment.create({
              data: {
                id: assignmentId,
                organizationId: org,
                releaseId: candidate.releaseId,
                scheduleId: schedule.id,
                state: "ASSIGNED",
                digestSha256: assignmentDigest,
                createdById: audit.actorUserId,
                scheduleName: candidate.scheduleName,
                priority: candidate.priority,
                startsAt: candidate.startsAt,
                endsAt: candidate.endsAt,
                timezone: candidate.timezone,
                daysOfWeek: candidate.daysOfWeek,
                dailyStartMinutes: candidate.dailyStartMinutes,
                dailyEndMinutes: candidate.dailyEndMinutes,
                enabled: candidate.enabled,
                approvalRequired: true,
                candidatePublicationId: publicationId,
                expectedWithdrawalDigestSha256,
                targets: {
                  create: candidate.targets.map(({ screenId }) => ({
                    screenId,
                    liveScreenId: screenId,
                    liveScreenOrganizationId: org,
                  })),
                },
              },
            });
            await tx.releaseCandidate.update({
              where: { id: candidate.id },
              data: {
                state: "PUBLISHED",
                publicationId,
                publishedAt: clock.databaseNow,
              },
            });
            await tx.releaseCandidatePublication.create({
              data: {
                id: publicationId,
                organizationId: org,
                candidateId: candidate.id,
                scheduleId: schedule.id,
                assignmentId: assignment.id,
                publisherUserId: audit.actorUserId,
                publishedAt: clock.databaseNow,
              },
            });
            await tx.auditEvent.create({
              data: {
                organizationId: org,
                actorUserId: audit.actorUserId,
                actorType: "user",
                action: "release.candidate.published",
                entityType: "release_candidate",
                entityId: candidate.id,
                ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
                ...(audit.requestId ? { requestId: audit.requestId } : {}),
                metadata: {
                  digestSha256: candidate.digestSha256,
                  releaseDigestSha256: record.releaseDigestSha256,
                  scheduleId: schedule.id,
                  assignmentId: assignment.id,
                  assignmentDigestSha256: assignmentDigest,
                },
              },
            });
            await tx.auditEvent.create({
              data: {
                organizationId: org,
                actorUserId: audit.actorUserId,
                actorType: "user",
                action: "release.published",
                entityType: "published_release",
                entityId: candidate.releaseId,
                ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
                ...(audit.requestId ? { requestId: audit.requestId } : {}),
                metadata: {
                  candidateId: candidate.id,
                  candidateDigestSha256: candidate.digestSha256,
                  digestSha256: record.releaseDigestSha256,
                  scheduleId: schedule.id,
                  assignmentId: assignment.id,
                  assignmentDigestSha256: assignmentDigest,
                },
              },
            });
            const updated = await tx.releaseCandidate.findUniqueOrThrow({
              where: { id: candidate.id },
              include: {
                targets: true,
                release: {
                  include: { items: { orderBy: { position: "asc" } } },
                },
                approval: true,
                publication: true,
              },
            });
            const response = releaseCandidateDto(updated);
            await tx.idempotencyRecord.create({
              data: {
                organizationId: org,
                operation: "RELEASE_CANDIDATE_PUBLISH",
                keyHash: idempotency.keyHash,
                actorUserId: audit.actorUserId,
                requestDigestSha256: idempotency.requestDigestSha256,
                statusCode: 200,
                responseBody: JSON.parse(JSON.stringify(response)),
                expiresAt: new Date(
                  clock.databaseNow.getTime() +
                    RELEASE_CANDIDATE_RESPONSE_RETENTION_MS,
                ),
              },
            });
            await this.compactExpiredIdempotencyResponses(
              tx,
              clock.databaseNow,
            );
            return { completed: true, candidate: response };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (attempt < 2 && isRetryableWriteConflict(error)) continue;
        throw error;
      }
    }
    throw new Error("Candidate publication retry budget exhausted");
  }

  async publishScheduleAndAudit(
    org: string,
    data: SchedulePublicationInput,
    audit: ReleaseAuditContext,
    policy: ReleasePublicationPolicy,
    idempotency: SchedulePublicationIdempotencyInput,
  ): Promise<SchedulePublicationResult> {
    const directPublicationDisabled: boolean = true;
    if (directPublicationDisabled)
      return { published: false, reason: "FORBIDDEN" };
    /* c8 ignore start -- unreachable legacy implementation retained only as
       migration reference until the next schema contraction. */
    if (
      !lowercaseSha256.test(idempotency.keyHash) ||
      !lowercaseSha256.test(idempotency.requestDigestSha256)
    )
      throw new Error("Canonical publication idempotency hashes are required");
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
            const [clock] = await tx.$queryRaw<Array<{ databaseNow: Date }>>`
              SELECT CURRENT_TIMESTAMP AS "databaseNow"`;
            if (!clock) throw new Error("Database clock is unavailable");
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`idempotency:${org}:${SCHEDULE_PUBLICATION_IDEMPOTENCY_OPERATION}:${idempotency.keyHash}`}, 0))`;
            const existingIdempotency = await tx.idempotencyRecord.findUnique({
              where: {
                organizationId_operation_keyHash: {
                  organizationId: org,
                  operation: "SCHEDULE_PUBLISH",
                  keyHash: idempotency.keyHash,
                },
              },
            });
            if (existingIdempotency) {
              if (
                existingIdempotency.actorUserId !== audit.actorUserId ||
                existingIdempotency.requestDigestSha256 !==
                  idempotency.requestDigestSha256
              )
                return {
                  published: false,
                  reason: "IDEMPOTENCY_KEY_REUSED",
                };
              if (
                existingIdempotency.expiresAt <= clock.databaseNow ||
                existingIdempotency.responseBody === null
              ) {
                return {
                  published: false,
                  reason: "IDEMPOTENCY_KEY_EXPIRED",
                };
              }
              const schedule = publicationResponseFromJson(
                existingIdempotency.responseBody,
              );
              if (!schedule.releaseId || !schedule.assignmentId)
                throw new Error("Idempotent publication response is invalid");
              const [release, assignment] = await Promise.all([
                tx.publishedRelease.findFirst({
                  where: { id: schedule.releaseId, organizationId: org },
                  include: { items: { orderBy: { position: "asc" } } },
                }),
                tx.releaseAssignment.findFirst({
                  where: { id: schedule.assignmentId, organizationId: org },
                  include: { targets: true },
                }),
              ]);
              if (!release || !assignment)
                throw new Error(
                  "Idempotent publication references are missing",
                );
              await this.compactExpiredIdempotencyResponses(
                tx,
                clock.databaseNow,
              );
              return {
                published: true,
                schedule,
                release: publishedReleaseDto(release),
                assignment: releaseAssignmentDto(assignment),
                replayed: true,
              };
            }
            const rememberPublication = async (
              result: Extract<SchedulePublicationResult, { published: true }>,
            ) => {
              await this.compactExpiredIdempotencyResponses(
                tx,
                clock.databaseNow,
              );
              await tx.idempotencyRecord.create({
                data: {
                  organizationId: org,
                  operation: "SCHEDULE_PUBLISH",
                  keyHash: idempotency.keyHash,
                  actorUserId: audit.actorUserId,
                  requestDigestSha256: idempotency.requestDigestSha256,
                  statusCode: 201,
                  responseBody: publicationResponseJson(result),
                  expiresAt: new Date(
                    clock.databaseNow.getTime() +
                      SCHEDULE_PUBLICATION_RESPONSE_RETENTION_MS,
                  ),
                },
              });
              return result;
            };
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
              startsAt: canonicalUtcInstant(data.startsAt),
              ...(data.endsAt
                ? { endsAt: canonicalUtcInstant(data.endsAt) }
                : {}),
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
              return rememberPublication({
                published: true,
                schedule: {
                  ...scheduleDto(existingAssignment.schedule),
                  releaseId: existingAssignment.releaseId,
                  assignmentId: existingAssignment.id,
                },
                release: publishedReleaseDto(existingAssignment.release),
                assignment: releaseAssignmentDto(existingAssignment),
              });
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
                approvalRequired: true,
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

            return rememberPublication({
              published: true,
              schedule: {
                ...scheduleDto(schedule),
                releaseId: release.id,
                assignmentId: assignment.id,
              },
              release: publishedReleaseDto(release),
              assignment: releaseAssignmentDto(assignment),
            });
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
    /* c8 ignore stop */
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
          if (previous.state !== "ASSIGNED")
            return { withdrawn: false, reason: "NOT_FOUND" };

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
        state: "ASSIGNED",
      },
      include: {
        targets: true,
        release: { include: { items: { orderBy: { position: "asc" } } } },
        finalPublication: {
          include: { publishedCandidate: true },
        },
        nextAssignments: {
          include: {
            targets: true,
            release: { include: { items: { orderBy: { position: "asc" } } } },
          },
        },
      },
    });
    const instant = new Date(at);
    return assignments.flatMap((assignment) => {
      if (
        !hasPublishedAssignmentProvenance(assignment) ||
        hasValidWithdrawalSuccessor(assignment)
      )
        return [];
      const verified = verifiedReleaseAssignmentDtos(assignment);
      if (!verified) return [];
      const { assignment: assignmentDto, release: releaseDto } = verified;
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
          release: releaseDto,
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
      },
      include: {
        targets: true,
        release: { include: { items: { orderBy: { position: "asc" } } } },
        finalPublication: {
          include: { publishedCandidate: true },
        },
        nextAssignments: {
          include: {
            targets: true,
            release: { include: { items: { orderBy: { position: "asc" } } } },
          },
        },
      },
    });
    if (!assignment) return false;
    if (
      !hasPublishedAssignmentProvenance(assignment) ||
      hasValidWithdrawalSuccessor(assignment)
    )
      return false;
    const verified = verifiedReleaseAssignmentDtos(assignment);
    if (!verified) return false;
    const { assignment: assignmentDto, release: releaseDto } = verified;
    if (
      assignmentDto.digestSha256 !== input.assignmentDigestSha256 ||
      assignmentDto.state !== "ASSIGNED" ||
      !assignmentDto.screenIds.includes(input.screenId) ||
      !assignmentDto.schedule.enabled ||
      assignmentDto.schedule.startsAt > input.at ||
      (assignmentDto.schedule.endsAt &&
        assignmentDto.schedule.endsAt <= input.at) ||
      !matchesScheduleWindow(assignmentDto.schedule, at)
    )
      return false;
    return releaseDto.items.some(
      (item) =>
        item.asset.id === input.assetId &&
        item.asset.storageKey === input.storageKey &&
        item.asset.checksumSha256 === input.checksumSha256 &&
        item.asset.sizeBytes === input.sizeBytes &&
        (!item.asset.expiresAt || item.asset.expiresAt > input.at),
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
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
    assertAuditEventIntegrity(event);
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
