export type ScreenStatus = "online" | "warning" | "offline" | "fallback";
export type Orientation = "landscape" | "portrait";
export type ContentKind = "image" | "video" | "web" | "template";
export type SchedulePriority = "normal" | "campaign" | "priority" | "emergency";

export const MEDIA_MAX_ASSET_BYTES = 128 * 1024 * 1024;
export const MEDIA_MAX_RELEASE_BYTES = 512 * 1024 * 1024;

/** Media formats accepted by the metadata-only pilot boundary. */
export const SUPPORTED_MEDIA_MIME_TYPES = {
  image: ["image/jpeg", "image/png"],
  video: ["video/mp4"],
  template: ["application/json"],
  web: [],
} as const satisfies Record<ContentKind, readonly string[]>;

export const CAPABILITIES = {
  releasePublish: "release.publish",
  releaseWithdraw: "release.withdraw",
  screenCredentialRevoke: "screen.credential.revoke",
  screenCredentialReenroll: "screen.credential.reenroll",
  emergencyActivate: "emergency.activate",
  emergencyClear: "emergency.clear",
} as const;

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

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
  /** One-use proof challenge consumed for this response in proof-v1 mode. */
  requestChallengeId?: string;
  priority: SchedulePriority;
  withdrawn: boolean;
  playbackEndsAt?: string;
  items: PlaylistItem[];
  signatureAlgorithm: "Ed25519";
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
  device: DeviceMetadata;
  identity: DeviceIdentityEnrollment;
  pairingProof: DeviceProof;
}

export interface DeviceMetadata {
  installationId: string;
  model: string;
  osVersion: string;
  playerVersion: string;
}

export interface DeviceIdentityEnrollment {
  algorithm: "ES256";
  publicKeySpki: string;
  keyId: string;
  securityLevel:
    | "strongbox"
    | "trusted-environment"
    | "software"
    | "unknown-secure"
    | "unknown";
}

export interface DeviceProof {
  challengeId: string;
  challenge: string;
  keyId: string;
  signatureFormat: "ES256-DER";
  signature: string;
}

export interface PairingChallengeRequest {
  code: string;
  device: DeviceMetadata;
  identity: DeviceIdentityEnrollment;
}

export interface DeviceChallengeResponse {
  id: string;
  challenge: string;
  expiresAt: string;
}

export interface PairingResponse {
  authMode: "proof-v1";
  screenId: string;
  credentialId: string;
  keyId: string;
  apiBaseUrl: string;
  heartbeatIntervalSeconds: number;
  manifestVerificationKey: string;
}

/** A proved replacement key awaiting explicit operator activation. */
export interface PairingPendingApprovalResponse {
  status: "pending-approval";
  grantId: string;
  candidateId: string;
  keyId: string;
  /** Canonical SHA-256 base64url public-key fingerprint; equal to keyId in proof-v1. */
  fingerprint: string;
  expiresAt: string;
}

export type DeviceProofOperation = "manifest" | "heartbeat";

export interface DeviceAuthChallengeRequest {
  operation: DeviceProofOperation;
  /** Lowercase hexadecimal SHA-256 of the canonical request body. */
  bodySha256: string;
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

export const PAIRING_TRANSCRIPT_VERSION =
  "ScreenGoblin pairing transcript v1" as const;

/**
 * Deterministic JSON for protocol hashes. Object keys are recursively sorted;
 * unsupported JSON values are rejected instead of being silently transformed.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Canonical JSON requires finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object")
    throw new TypeError("Value is not representable as canonical JSON");

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError("Canonical JSON objects must be plain objects");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function canonicalPairingTranscript(
  request: PairingChallengeRequest,
): string {
  return canonicalJson({
    version: PAIRING_TRANSCRIPT_VERSION,
    code: request.code,
    device: request.device,
    identity: request.identity,
  });
}
