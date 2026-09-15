export type ScreenStatus = "online" | "warning" | "offline" | "fallback";
export type Orientation = "landscape" | "portrait";
export type ContentKind = "image" | "video" | "web" | "template";
export type SchedulePriority = "normal" | "campaign" | "priority" | "emergency";

export const MEDIA_MAX_ASSET_BYTES = 128 * 1024 * 1024;
export const MEDIA_MAX_RELEASE_BYTES = 512 * 1024 * 1024;

/** Media formats accepted for pre-provisioned internal records and playback. */
export const SUPPORTED_MEDIA_MIME_TYPES = {
  image: ["image/jpeg", "image/png"],
  video: ["video/mp4"],
  template: ["application/json"],
  web: [],
} as const satisfies Record<ContentKind, readonly string[]>;

export const CAPABILITIES = {
  authorizationManage: "authorization.manage",
  screenRead: "screen.read",
  locationRead: "location.read",
  mediaRead: "media.read",
  playlistRead: "playlist.read",
  scheduleRead: "schedule.read",
  releaseCandidateRead: "release.candidate.read",
  releaseCandidateCreate: "release.candidate.create",
  releaseCandidateSubmit: "release.candidate.submit",
  releaseApprove: "release.approve",
  releasePublish: "release.publish",
  releaseWithdraw: "release.withdraw",
  screenCredentialRevoke: "screen.credential.revoke",
  screenCredentialReenroll: "screen.credential.reenroll",
  emergencyActivate: "emergency.activate",
  emergencyClear: "emergency.clear",
} as const;

export const AUTHORIZATION_SCOPE_TYPES = {
  organization: "ORGANIZATION",
  location: "LOCATION",
  screenGroup: "SCREEN_GROUP",
  screen: "SCREEN",
} as const;

export type AuthorizationScopeType =
  (typeof AUTHORIZATION_SCOPE_TYPES)[keyof typeof AUTHORIZATION_SCOPE_TYPES];

/** A tenant-bound grant input after persistence-layer validation. */
export interface ScopedAuthorizationGrant {
  id: string;
  organizationId: string;
  subjectUserId: string;
  /** Exact live membership instance validated by the persistence query. */
  subjectMembershipId: string;
  capability: Capability;
  scopeType: AuthorizationScopeType;
  /** Absent for ORGANIZATION and required for every narrower scope. */
  scopeId?: string | null;
  startsAt: string;
  expiresAt?: string | null;
  revokedAt?: string | null;
}

/** Current server-resolved classification of one concrete target screen. */
export interface ScopedAuthorizationScreenTarget {
  organizationId: string;
  screenId: string;
  locationId?: string | null;
  screenGroupIds: readonly string[];
}

export type ReleaseCandidateState =
  "DRAFT" | "IN_REVIEW" | "APPROVED" | "PUBLISHED";

export interface ManagementReleaseCandidate {
  id: string;
  state: ReleaseCandidateState;
  digestSha256: string;
  releaseId: string;
  releaseDigestSha256: string;
  sourcePlaylistId: string;
  authorUserId: string;
  items: PlaylistItem[];
  schedule: {
    name: string;
    priority: "normal" | "campaign" | "priority";
    startsAt: string;
    endsAt?: string;
    timezone: string;
    daysOfWeek: number[];
    dailyStartMinutes?: number;
    dailyEndMinutes?: number;
    enabled: boolean;
  };
  screenIds: string[];
  policyVersion: number;
  expiresAt: string;
  submittedAt?: string;
  approvedAt?: string;
  publishedAt?: string;
  approval?: {
    approverUserId: string;
    candidateDigestSha256: string;
    approvedAt: string;
  };
  scheduleId?: string;
  assignmentId?: string;
  createdAt: string;
}

export interface ReleaseCandidateCreateRequest {
  playlistId: string;
  name: string;
  priority: "normal" | "campaign" | "priority";
  startsAt: string;
  endsAt?: string;
  timezone: string;
  daysOfWeek: number[];
  dailyStartMinutes?: number;
  dailyEndMinutes?: number;
  enabled: boolean;
  screenIds: string[];
  expiresAt: string;
}

export interface ReleaseCandidateTransitionRequest {
  digestSha256: string;
}

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

/** Strict manifest negotiation for header-authorized private media delivery. */
export interface DeviceManifestRequest {
  protocolVersion: 2;
  mediaDelivery: "authorization-v1";
}

export interface PlaybackMediaAsset extends MediaAsset {
  /** Opaque credential; clients send it only in the MediaCapability header. */
  mediaCapability?: string;
  mediaDelivery?: "authorization-v1";
}

export interface PlaybackPlaylistItem extends Omit<PlaylistItem, "asset"> {
  asset: PlaybackMediaAsset;
}

export interface PlaylistItem {
  id: string;
  asset: MediaAsset;
  position: number;
  durationSeconds: number;
}

export interface PlaybackManifest {
  protocolVersion: 2;
  mediaDelivery: "authorization-v1";
  version: string;
  generatedAt: string;
  validUntil: string;
  screenId: string;
  /** One-use proof challenge consumed for this response in proof-v1 mode. */
  requestChallengeId?: string;
  priority: SchedulePriority;
  withdrawn: boolean;
  playbackEndsAt?: string;
  items: PlaybackPlaylistItem[];
  signatureAlgorithm: "Ed25519";
  signature: string;
}

export interface ScreenSummary {
  id: string;
  name: string;
  location: string;
  /** Stable classification only; not an authorization scope in this release. */
  locationId?: string;
  /** Current first-class classification name when one has been assigned. */
  locationName?: string;
  status: ScreenStatus;
  orientation: Orientation;
  resolution: string;
  lastSeenAt?: string;
  nowPlaying?: string;
  playerVersion?: string;
  tags: string[];
}

/** Authenticated management representation of a screen record. */
export interface ManagementScreen {
  id: string;
  name: string;
  location: string;
  /** Stable classification only; not an authorization scope in this release. */
  locationId?: string;
  /** Current first-class classification name when one has been assigned. */
  locationName?: string;
  status: ScreenStatus;
  orientation: Orientation;
  resolution: string;
  tags: string[];
  model?: string;
  osVersion?: string;
  playerVersion?: string;
  manifestVersion?: string;
  /** Opaque asset identifier last reported by the player, not a playback claim. */
  nowPlayingAssetId?: string;
  uptimeSeconds?: number;
  freeStorageBytes?: number;
  networkType?: string;
  lastSeenAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ManagementPlaylistItem {
  id: string;
  assetId: string;
  position: number;
  durationSeconds: number;
}

export interface ManagementPlaylist {
  id: string;
  name: string;
  description: string;
  items: ManagementPlaylistItem[];
  createdAt: string;
  updatedAt: string;
}

export interface ManagementSchedule {
  id: string;
  playlistId: string;
  name: string;
  priority: SchedulePriority;
  startsAt: string;
  endsAt?: string;
  timezone: string;
  daysOfWeek: number[];
  dailyStartMinutes?: number;
  dailyEndMinutes?: number;
  enabled: boolean;
  screenIds: string[];
  /** Server-verified active publication provenance permits withdrawal. */
  withdrawable: boolean;
  /** Publication identifiers are opaque and do not imply current assignment state. */
  releaseId?: string;
  assignmentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ManagementListResponse<T> {
  data: T[];
}

/** Administrative classification. Locations do not grant or restrict access yet. */
export interface LocationSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
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

/** A proved enrollment key awaiting explicit operator activation. */
export interface PairingPendingApprovalResponse {
  status: "pending-approval";
  grantId: string;
  candidateId: string;
  keyId: string;
  /** Canonical SHA-256 base64url public-key fingerprint; equal to keyId in proof-v1. */
  fingerprint: string;
  expiresAt: string;
}

export interface DeviceEnrollmentGrant {
  grantId: string;
  screenId: string;
  code: string;
  expiresAt: string;
  generation: number;
}

export interface DeviceEnrollmentCandidate {
  id: string;
  keyId: string;
  /** Canonical SHA-256 base64url public-key fingerprint; equal to keyId. */
  fingerprint: string;
  securityLevel: DeviceIdentityEnrollment["securityLevel"];
  device: DeviceMetadata;
  provedAt: string;
}

export interface DeviceEnrollmentStatus {
  grantId: string;
  screenId: string;
  status: "pending" | "claimed" | "expired" | "revoked";
  expiresAt: string;
  candidates: DeviceEnrollmentCandidate[];
}

export interface DeviceEnrollmentActivation {
  grantId: string;
  screenId: string;
  candidateId: string;
  credentialId: string;
  keyId: string;
  activatedAt: string;
  status: "activated";
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
