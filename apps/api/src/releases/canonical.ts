import { createHash } from "node:crypto";
import type {
  FrozenReleaseItem,
  FrozenScheduleSnapshot,
  MediaRecord,
  PlaylistRecord,
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
      startsAt: input.schedule.startsAt,
      ...(input.schedule.endsAt ? { endsAt: input.schedule.endsAt } : {}),
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
