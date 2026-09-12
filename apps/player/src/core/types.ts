export type AssetKind = "image" | "video" | "web" | "template";
export type ManifestPriority = "normal" | "campaign" | "priority" | "emergency";

export interface PlayerAsset {
  id: string;
  kind: AssetKind;
  url: string;
  mimeType: string;
  checksumSha256: string;
  sizeBytes: number;
  durationSeconds: number;
}

export interface PlayerManifest {
  version: string;
  generatedAt: string;
  validUntil: string;
  /** Signed schedule boundary after which playback must stop, even offline. */
  playbackEndsAt?: string;
  screenId: string;
  priority: ManifestPriority;
  /**
   * A signed, normal-priority release that intentionally clears playback.
   * Optional only so an already-cached pre-0.1 manifest can still be recovered
   * during an in-place prototype upgrade.
   */
  withdrawn?: boolean;
  items: PlayerAsset[];
}

export interface Credentials {
  installationId: string;
  screenId: string;
  deviceToken: string;
  apiBaseUrl: string;
  heartbeatIntervalSeconds: number;
  manifestVerificationKey: string;
}

export interface PairingSession {
  code: string;
  expiresAt: string;
  verificationUrl?: string;
}

export interface PlayerCommand {
  id: string;
  type: "refresh" | "reload" | "identify" | "clear-cache" | "restart";
  createdAt: string;
}

export interface Heartbeat {
  installationId: string;
  playerVersion: string;
  manifestVersion?: string;
  nowPlayingAssetId?: string;
  uptimeSeconds: number;
  freeStorageBytes: number;
  networkType: string;
  occurredAt: string;
  state: "playing" | "pairing" | "offline" | "fallback" | "error";
}

export interface PlayerStore {
  getCredentials(): Promise<Credentials | undefined>;
  putCredentials(value: Credentials): Promise<void>;
  getActiveManifest(): Promise<PlayerManifest | undefined>;
  getPreviousManifest(): Promise<PlayerManifest | undefined>;
  activateManifest(value: PlayerManifest): Promise<void>;
  rollback(expectedActiveVersion?: string): Promise<PlayerManifest | undefined>;
  clear(): Promise<void>;
}

export interface AssetRepository {
  prefetch(asset: PlayerAsset): Promise<void>;
  resolve(asset: PlayerAsset): Promise<string>;
  prune?(retainedAssets: PlayerAsset[]): Promise<void>;
  removeAll(): Promise<void>;
}
