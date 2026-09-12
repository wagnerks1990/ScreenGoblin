import type {
  ManagementPlaylist,
  ManagementSchedule,
  ManagementScreen,
} from "@screengoblin/contracts";
import type {
  PlaylistRecord,
  ScheduleRecord,
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
