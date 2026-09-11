export type ScreenStatus = "online" | "warning" | "offline" | "fallback";
export type Orientation = "landscape" | "portrait";
export type ContentKind = "image" | "video" | "web" | "template";
export type SchedulePriority = "normal" | "campaign" | "priority" | "emergency";

export interface MediaAsset {
  id: string;
  name: string;
  kind: ContentKind;
  mimeType: string;
  url: string;
  checksumSha256: string;
  sizeBytes: number;
  durationSeconds?: number;
  expiresAt?: string;
  createdAt: string;
}

export interface PlaylistItem {
  id: string;
  asset: MediaAsset;
  position: number;
  durationSeconds: number;
}

export interface PlaybackManifest {
  version: string;
  generatedAt: string;
  validUntil: string;
  screenId: string;
  priority: SchedulePriority;
  items: PlaylistItem[];
  signature: string;
}

export interface ScreenSummary {
  id: string;
  name: string;
  location: string;
  status: ScreenStatus;
  orientation: Orientation;
  resolution: string;
  lastSeenAt?: string;
  nowPlaying?: string;
  playerVersion?: string;
  tags: string[];
}

export interface PairingRequest {
  code: string;
  device: {
    installationId: string;
    model: string;
    osVersion: string;
    playerVersion: string;
  };
}

export interface PairingResponse {
  screenId: string;
  deviceToken: string;
  apiBaseUrl: string;
  heartbeatIntervalSeconds: number;
}

export interface HeartbeatRequest {
  installationId: string;
  playerVersion: string;
  manifestVersion?: string;
  nowPlayingAssetId?: string;
  uptimeSeconds: number;
  freeStorageBytes: number;
  networkType: string;
  occurredAt: string;
}

export interface FleetSummary {
  total: number;
  online: number;
  warning: number;
  offline: number;
  fallback: number;
}
