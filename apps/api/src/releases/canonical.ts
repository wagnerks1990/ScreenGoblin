import { createHash } from "node:crypto";
import type {
  FrozenReleaseItem,
  FrozenScheduleSnapshot,
  MediaRecord,
  PlaylistRecord,
  PublishedReleaseRecord,
  ReleaseAssignmentRecord,
  SchedulePublicationInput,
} from "../domain/types.js";

export type ReleaseSnapshotFailureReason =
  "ASSET_NOT_FOUND" | "NO_PLAYABLE_ITEMS";

export class ReleaseSnapshotError extends Error {
  constructor(readonly reason: ReleaseSnapshotFailureReason) {
    super(reason);
    this.name = "ReleaseSnapshotError";
  }
}

export interface CanonicalReleaseSnapshot {
  schemaVersion: 1;
  sourcePlaylistId: string;
  sourcePlaylistUpdatedAt: string;
  playlistName: string;
  playlistDescription: string;
  items: FrozenReleaseItem[];
}

export function canonicalReleaseSnapshot(
  playlist: PlaylistRecord,
  assets: readonly MediaRecord[],
): CanonicalReleaseSnapshot {
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const orderedItems = [...playlist.items].sort(
    (left, right) =>
      left.position - right.position || left.id.localeCompare(right.id),
  );
  if (orderedItems.length === 0)
    throw new ReleaseSnapshotError("NO_PLAYABLE_ITEMS");

  const positions = new Set<number>();
  const items = orderedItems.map((item): FrozenReleaseItem => {
    if (positions.has(item.position))
      throw new ReleaseSnapshotError("NO_PLAYABLE_ITEMS");
    positions.add(item.position);
    const asset = assetsById.get(item.assetId);
    if (!asset) throw new ReleaseSnapshotError("ASSET_NOT_FOUND");
    return {
      id: item.id,
      asset: {
        id: asset.id,
        name: asset.name,
        kind: asset.kind,
        mimeType: asset.mimeType,
        url: asset.url,
        ...(asset.storageKey ? { storageKey: asset.storageKey } : {}),
        checksumSha256: asset.checksumSha256.toLowerCase(),
        sizeBytes: asset.sizeBytes,
        createdAt: asset.createdAt,
        ...(asset.expiresAt ? { expiresAt: asset.expiresAt } : {}),
      },
      position: item.position,
      durationSeconds: item.durationSeconds,
    };
  });

  return {
    schemaVersion: 1,
    sourcePlaylistId: playlist.id,
    sourcePlaylistUpdatedAt: playlist.updatedAt,
    playlistName: playlist.name,
    playlistDescription: playlist.description,
    items,
  };
}

export const releaseSnapshotDigest = (
  snapshot: CanonicalReleaseSnapshot,
): string =>
  createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");

export interface CanonicalSchedulePublicationRequest {
  schemaVersion: 1;
  operation: "schedule.publish";
  playlistId: string;
  name: string;
  priority: SchedulePublicationInput["priority"];
  startsAt: string;
  endsAt?: string | undefined;
  timezone: string;
  daysOfWeek: number[];
  dailyStartMinutes?: number | undefined;
  dailyEndMinutes?: number | undefined;
  enabled: boolean;
  screenIds: string[];
}

export const canonicalUtcInstant = (value: string): string =>
  new Date(value).toISOString();

export function canonicalSchedulePublicationRequest(
  input: SchedulePublicationInput,
): CanonicalSchedulePublicationRequest {
  return {
    schemaVersion: 1,
    operation: "schedule.publish",
    playlistId: input.playlistId,
    name: input.name,
    priority: input.priority,
    startsAt: canonicalUtcInstant(input.startsAt),
    ...(input.endsAt ? { endsAt: canonicalUtcInstant(input.endsAt) } : {}),
    timezone: input.timezone,
    daysOfWeek: [...new Set(input.daysOfWeek)].sort((a, b) => a - b),
    ...(input.dailyStartMinutes !== undefined
      ? { dailyStartMinutes: input.dailyStartMinutes }
      : {}),
    ...(input.dailyEndMinutes !== undefined
      ? { dailyEndMinutes: input.dailyEndMinutes }
      : {}),
    enabled: input.enabled,
    screenIds: [...new Set(input.screenIds)].sort(),
  };
}

export const schedulePublicationRequestDigest = (
  input: SchedulePublicationInput,
): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalSchedulePublicationRequest(input)))
    .digest("hex");

export const schedulePublicationKeyHash = (
  organizationId: string,
  key: string,
): string =>
  createHash("sha256")
    .update(
      `screengoblin:schedule-publish-idempotency:v1\0${organizationId}\0${key}`,
    )
    .digest("hex");

export interface CanonicalReleaseCandidateSnapshot {
  schemaVersion: 1;
  releaseDigestSha256: string;
  schedule: FrozenScheduleSnapshot;
  screenIds: string[];
  policyVersion: 1;
  expiresAt: string;
}

export function canonicalReleaseCandidateSnapshot(input: {
  releaseDigestSha256: string;
  schedule: FrozenScheduleSnapshot;
  screenIds: readonly string[];
  expiresAt: string;
}): CanonicalReleaseCandidateSnapshot {
  return {
    schemaVersion: 1,
    releaseDigestSha256: input.releaseDigestSha256,
    schedule: {
      name: input.schedule.name,
      priority: input.schedule.priority,
      startsAt: canonicalUtcInstant(input.schedule.startsAt),
      ...(input.schedule.endsAt
        ? { endsAt: canonicalUtcInstant(input.schedule.endsAt) }
        : {}),
      timezone: input.schedule.timezone,
      daysOfWeek: [...new Set(input.schedule.daysOfWeek)].sort((a, b) => a - b),
      ...(input.schedule.dailyStartMinutes !== undefined
        ? { dailyStartMinutes: input.schedule.dailyStartMinutes }
        : {}),
      ...(input.schedule.dailyEndMinutes !== undefined
        ? { dailyEndMinutes: input.schedule.dailyEndMinutes }
        : {}),
      enabled: input.schedule.enabled,
    },
    screenIds: [...new Set(input.screenIds)].sort(),
    policyVersion: 1,
    expiresAt: canonicalUtcInstant(input.expiresAt),
  };
}

export const releaseCandidateDigest = (
  snapshot: CanonicalReleaseCandidateSnapshot,
): string =>
  createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");

export const releaseCandidateKeyHash = (
  organizationId: string,
  operation: "create" | "submit" | "approve" | "publish",
  key: string,
): string =>
  createHash("sha256")
    .update(
      `screengoblin:release-candidate:${operation}:idempotency:v1\0${organizationId}\0${key}`,
    )
    .digest("hex");

export const releaseCandidateCommandDigest = (
  operation: "submit" | "approve" | "publish",
  candidateId: string,
  expectedDigestSha256: string,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        operation,
        candidateId,
        expectedDigestSha256,
      }),
    )
    .digest("hex");

export const releaseCandidateCreateCommandDigest = (
  input: SchedulePublicationInput & { expiresAt: string },
): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        operation: "create",
        schedule: canonicalSchedulePublicationRequest(input),
        expiresAt: canonicalUtcInstant(input.expiresAt),
      }),
    )
    .digest("hex");

export function canonicalStoredReleaseSnapshot(
  release: PublishedReleaseRecord,
): CanonicalReleaseSnapshot {
  return {
    schemaVersion: 1,
    sourcePlaylistId: release.sourcePlaylistId,
    sourcePlaylistUpdatedAt: release.sourcePlaylistUpdatedAt,
    playlistName: release.playlistName,
    playlistDescription: release.playlistDescription,
    items: release.items,
  };
}

export const hasValidStoredReleaseDigest = (
  release: PublishedReleaseRecord,
): boolean => {
  try {
    return (
      release.digestSha256 ===
      releaseSnapshotDigest(canonicalStoredReleaseSnapshot(release))
    );
  } catch {
    return false;
  }
};

export interface CanonicalAssignmentSnapshot {
  schemaVersion: 1;
  releaseDigestSha256: string;
  state: "ASSIGNED" | "WITHDRAWN";
  schedule: FrozenScheduleSnapshot;
  screenIds: string[];
  previousAssignmentId?: string | undefined;
}

export function canonicalAssignmentSnapshot(input: {
  releaseDigestSha256: string;
  state: "ASSIGNED" | "WITHDRAWN";
  schedule: FrozenScheduleSnapshot;
  screenIds: readonly string[];
  previousAssignmentId?: string | undefined;
}): CanonicalAssignmentSnapshot {
  return {
    schemaVersion: 1,
    releaseDigestSha256: input.releaseDigestSha256,
    state: input.state,
    schedule: {
      name: input.schedule.name,
      priority: input.schedule.priority,
      startsAt: canonicalUtcInstant(input.schedule.startsAt),
      ...(input.schedule.endsAt
        ? { endsAt: canonicalUtcInstant(input.schedule.endsAt) }
        : {}),
      timezone: input.schedule.timezone,
      daysOfWeek: [...new Set(input.schedule.daysOfWeek)].sort((a, b) => a - b),
      ...(input.schedule.dailyStartMinutes !== undefined
        ? { dailyStartMinutes: input.schedule.dailyStartMinutes }
        : {}),
      ...(input.schedule.dailyEndMinutes !== undefined
        ? { dailyEndMinutes: input.schedule.dailyEndMinutes }
        : {}),
      enabled: input.schedule.enabled,
    },
    screenIds: [...new Set(input.screenIds)].sort(),
    ...(input.previousAssignmentId
      ? { previousAssignmentId: input.previousAssignmentId }
      : {}),
  };
}

export const assignmentSnapshotDigest = (
  snapshot: CanonicalAssignmentSnapshot,
): string =>
  createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");

export const hasValidStoredAssignmentDigest = (
  assignment: ReleaseAssignmentRecord,
  release: PublishedReleaseRecord,
): boolean => {
  try {
    return (
      assignment.organizationId === release.organizationId &&
      assignment.releaseId === release.id &&
      hasValidStoredReleaseDigest(release) &&
      assignment.digestSha256 ===
        assignmentSnapshotDigest(
          canonicalAssignmentSnapshot({
            releaseDigestSha256: release.digestSha256,
            state: assignment.state,
            schedule: assignment.schedule,
            screenIds: assignment.screenIds,
            ...(assignment.previousAssignmentId
              ? { previousAssignmentId: assignment.previousAssignmentId }
              : {}),
          }),
        )
    );
  } catch {
    return false;
  }
};
