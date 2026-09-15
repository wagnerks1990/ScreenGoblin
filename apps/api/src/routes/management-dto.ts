import type {
  ManagementPlaylist,
  ManagementSchedule,
  ManagementReleaseCandidate,
  ManagementScreen,
} from "@screengoblin/contracts";
import type {
  PlaylistRecord,
  ScheduleRecord,
  ReleaseCandidateRecord,
  ScreenRecord,
} from "../domain/types.js";

export function managementScreen(record: ScreenRecord): ManagementScreen {
  return {
    id: record.id,
    name: record.name,
    location: record.location,
    ...(record.locationId ? { locationId: record.locationId } : {}),
    ...(record.locationName ? { locationName: record.locationName } : {}),
    status: record.status,
    orientation: record.orientation,
    resolution: record.resolution,
    tags: [...record.tags],
    ...(record.model ? { model: record.model } : {}),
    ...(record.osVersion ? { osVersion: record.osVersion } : {}),
    ...(record.playerVersion ? { playerVersion: record.playerVersion } : {}),
    ...(record.manifestVersion
      ? { manifestVersion: record.manifestVersion }
      : {}),
    ...(record.nowPlayingAssetId
      ? { nowPlayingAssetId: record.nowPlayingAssetId }
      : {}),
    ...(record.uptimeSeconds !== undefined
      ? { uptimeSeconds: record.uptimeSeconds }
      : {}),
    ...(record.freeStorageBytes !== undefined
      ? { freeStorageBytes: record.freeStorageBytes }
      : {}),
    ...(record.networkType ? { networkType: record.networkType } : {}),
    ...(record.lastSeenAt ? { lastSeenAt: record.lastSeenAt } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function managementReleaseCandidate(
  record: ReleaseCandidateRecord,
): ManagementReleaseCandidate {
  return {
    id: record.id,
    state: record.state,
    digestSha256: record.digestSha256,
    releaseId: record.releaseId,
    releaseDigestSha256: record.releaseDigestSha256,
    sourcePlaylistId: record.sourcePlaylistId,
    authorUserId: record.authorUserId,
    items: record.items.map((item) => ({
      id: item.id,
      asset: {
        id: item.asset.id,
        name: item.asset.name,
        kind: item.asset.kind,
        mimeType: item.asset.mimeType,
        url: item.asset.url,
        checksumSha256: item.asset.checksumSha256,
        sizeBytes: item.asset.sizeBytes,
        ...(item.asset.expiresAt ? { expiresAt: item.asset.expiresAt } : {}),
        createdAt: item.asset.createdAt,
      },
      position: item.position,
      durationSeconds: item.durationSeconds,
    })),
    schedule: {
      name: record.schedule.name,
      priority: record.schedule.priority as "normal" | "campaign" | "priority",
      startsAt: record.schedule.startsAt,
      ...(record.schedule.endsAt ? { endsAt: record.schedule.endsAt } : {}),
      timezone: record.schedule.timezone,
      daysOfWeek: [...record.schedule.daysOfWeek],
      ...(record.schedule.dailyStartMinutes !== undefined
        ? { dailyStartMinutes: record.schedule.dailyStartMinutes }
        : {}),
      ...(record.schedule.dailyEndMinutes !== undefined
        ? { dailyEndMinutes: record.schedule.dailyEndMinutes }
        : {}),
      enabled: record.schedule.enabled,
    },
    screenIds: [...record.screenIds],
    policyVersion: record.policyVersion,
    expiresAt: record.expiresAt,
    ...(record.submittedAt ? { submittedAt: record.submittedAt } : {}),
    ...(record.approvedAt ? { approvedAt: record.approvedAt } : {}),
    ...(record.publishedAt ? { publishedAt: record.publishedAt } : {}),
    ...(record.approval
      ? {
          approval: {
            approverUserId: record.approval.approverUserId,
            candidateDigestSha256: record.approval.candidateDigestSha256,
            approvedAt: record.approval.approvedAt,
          },
        }
      : {}),
    ...(record.scheduleId ? { scheduleId: record.scheduleId } : {}),
    ...(record.assignmentId ? { assignmentId: record.assignmentId } : {}),
    createdAt: record.createdAt,
  };
}

export function managementPlaylist(record: PlaylistRecord): ManagementPlaylist {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    items: record.items
      .map((item) => ({
        id: item.id,
        assetId: item.assetId,
        position: item.position,
        durationSeconds: item.durationSeconds,
      }))
      .sort((left, right) => left.position - right.position),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function managementSchedule(record: ScheduleRecord): ManagementSchedule {
  return {
    id: record.id,
    playlistId: record.playlistId,
    name: record.name,
    priority: record.priority,
    startsAt: record.startsAt,
    ...(record.endsAt ? { endsAt: record.endsAt } : {}),
    timezone: record.timezone,
    daysOfWeek: [...record.daysOfWeek],
    ...(record.dailyStartMinutes !== undefined
      ? { dailyStartMinutes: record.dailyStartMinutes }
      : {}),
    ...(record.dailyEndMinutes !== undefined
      ? { dailyEndMinutes: record.dailyEndMinutes }
      : {}),
    enabled: record.enabled,
    screenIds: [...record.screenIds],
    ...(record.releaseId ? { releaseId: record.releaseId } : {}),
    ...(record.assignmentId ? { assignmentId: record.assignmentId } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
