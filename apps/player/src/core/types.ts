export type AssetKind = "image" | "video" | "web" | "template";
export type ManifestPriority = "normal" | "campaign" | "priority" | "emergency";

export interface PlayerAsset {
  id: string;
  kind: AssetKind;
  url: string;
  /** Opaque signed credential sent only in the MediaCapability header. */
  mediaCapability?: string;
  mediaDelivery?: "authorization-v1";
  mimeType: string;
  checksumSha256: string;
  sizeBytes: number;
  durationSeconds: number;
  /** Signed hard boundary after which this asset must not play offline. */
  expiresAt?: string;
}

export interface PlayerManifest {
  /** Absent only on a verified pre-cutover cache-only recovery record. */
  protocolVersion?: 2;
  /** Absent only on a verified pre-cutover cache-only recovery record. */
  mediaDelivery?: "authorization-v1";
  version: string;
  generatedAt: string;
  validUntil: string;
  /** Signed schedule boundary after which playback must stop, even offline. */
  playbackEndsAt?: string;
  screenId: string;
  /** Signed one-use proof challenge binding; required for proof-v1 responses. */
  requestChallengeId?: string;
  priority: ManifestPriority;
  /**
   * A signed, normal-priority release that intentionally clears playback.
   * Optional only so an already-cached pre-0.1 manifest can still be recovered
   * during an in-place prototype upgrade.
   */
  withdrawn?: boolean;
  items: PlayerAsset[];
}

/** Exact server signing bytes retained with the normalized playback view. */
export interface SignedPlayerManifest {
  formatVersion: 1;
  payloadJson: string;
  signatureAlgorithm: "Ed25519";
  signature: string;
  manifest: PlayerManifest;
}

export interface ManifestTrust {
  screenId: string;
  manifestVerificationKey: string;
}

interface CredentialBase {
  installationId: string;
  screenId: string;
  apiBaseUrl: string;
  heartbeatIntervalSeconds: number;
  manifestVerificationKey: string;
}

export interface ProofCredentials extends CredentialBase {
  authMode: "proof-v1";
  credentialId: string;
  keyId: string;
}

export interface DevelopmentBearerCredentials extends CredentialBase {
  authMode: "development-bearer";
  deviceToken: string;
}

export type Credentials = ProofCredentials | DevelopmentBearerCredentials;

/** Durable recovery material for one bounded proof pairing attempt. */
export interface PendingProofPairing {
  version: 1;
  stage: "prepared" | "pending";
  apiBaseUrl: string;
  finalBody: string;
  expectedKeyId: string;
  installationId: string;
  expiresAt: string;
  approval?: PairingPendingApprovalResponse;
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

export interface HeartbeatResponse {
  accepted: true;
  serverTime: string;
  nextHeartbeatSeconds: number;
}

export interface PlayerStore {
  getCredentials(): Promise<Credentials | undefined>;
  putCredentials(value: Credentials): Promise<void>;
  getPendingPairing(): Promise<PendingProofPairing | undefined>;
  putPendingPairing(value: PendingProofPairing): Promise<void>;
  completePairing(value: Credentials): Promise<void>;
  deletePendingPairing(): Promise<void>;
  clearProvisionedState(): Promise<void>;
  getActiveManifest(): Promise<SignedPlayerManifest | undefined>;
  getPreviousManifest(): Promise<SignedPlayerManifest | undefined>;
  activateManifest(value: SignedPlayerManifest): Promise<void>;
  clearPreviousManifest(expectedActiveVersion?: string): Promise<void>;
  rollback(
    expectedActiveVersion?: string,
    eligibleUntilMs?: number,
  ): Promise<SignedPlayerManifest | undefined>;
  clearManifests(): Promise<void>;
  clear(): Promise<void>;
}

export interface AssetRepository {
  prefetch(asset: PlayerAsset): Promise<void>;
  resolve(asset: PlayerAsset): Promise<string>;
  prune?(retainedAssets: PlayerAsset[]): Promise<void>;
  removeAll(): Promise<void>;
}
import type { PairingPendingApprovalResponse } from "@screengoblin/contracts";
