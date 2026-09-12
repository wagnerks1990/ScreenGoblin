export type Role = "OWNER" | "ADMIN" | "PUBLISHER" | "VIEWER";
export type Priority = "normal" | "campaign" | "priority" | "emergency";
export type MediaKind = "image" | "video" | "web" | "template";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  organizationId: string;
  role: Role;
  disabledAt?: string;
}
export const LOGIN_FAILURE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const LOGIN_FAILURE_MAX_RECORDS = 10_000;

export type LoginFailureReason = "INVALID_CREDENTIALS" | "RATE_LIMITED";

export interface LoginFailureRecord {
  id: string;
  accountKey: string;
  sourceKey: string;
  reason: LoginFailureReason;
  occurredAt: string;
}

export type LoginFailureInput = Omit<LoginFailureRecord, "id" | "occurredAt">;

export interface UserSessionRecord {
  id: string;
  organizationId: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  revokedAt?: string | undefined;
  createdAt: string;
}

export interface UserSessionCreateInput {
  tokenHash: string;
  expiresAt: string;
  expectedPasswordHash: string;
  expectedRole: Role;
}

export type UserSessionCreateResult =
  | { created: true; session: UserSessionRecord }
  | { created: false; reason: "FORBIDDEN" };

export type UserSessionRevokeResult =
  { revoked: true } | { revoked: false; reason: "NOT_FOUND" };
export interface ScreenRecord {
  id: string;
  organizationId: string;
  name: string;
  location: string;
  status: "online" | "warning" | "offline" | "fallback";
  orientation: "landscape" | "portrait";
  resolution: string;
  tags: string[];
  installationId?: string | undefined;
  deviceTokenHash?: string | undefined;
  model?: string | undefined;
  osVersion?: string | undefined;
  playerVersion?: string | undefined;
  manifestVersion?: string | undefined;
  nowPlayingAssetId?: string | undefined;
  uptimeSeconds?: number | undefined;
  freeStorageBytes?: number | undefined;
  networkType?: string | undefined;
  lastSeenAt?: string | undefined;
  credentialRevokedAt?: string | undefined;
  credentialGeneration?: number | undefined;
  createdAt: string;
  updatedAt: string;
}
export interface HeartbeatUpdateInput {
  playerVersion: string;
  manifestVersion: string | null;
  nowPlayingAssetId: string | null;
  uptimeSeconds: number;
  freeStorageBytes: number;
  networkType: string;
}

export interface MediaRecord {
  id: string;
  organizationId: string;
  name: string;
  kind: MediaKind;
  mimeType: string;
  url: string;
  checksumSha256: string;
  sizeBytes: number;
  durationSeconds?: number | undefined;
  expiresAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
}
export interface PlaylistRecord {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  items: Array<{
    id: string;
    assetId: string;
    position: number;
    durationSeconds: number;
  }>;
  createdAt: string;
  updatedAt: string;
}
export interface ScheduleRecord {
  id: string;
  organizationId: string;
  playlistId: string;
  name: string;
  priority: Priority;
  startsAt: string;
  endsAt?: string | undefined;
  timezone: string;
  daysOfWeek: number[];
  dailyStartMinutes?: number | undefined;
  dailyEndMinutes?: number | undefined;
  enabled: boolean;
  screenIds: string[];
  releaseId?: string | undefined;
  assignmentId?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface FrozenReleaseAsset {
  id: string;
  name: string;
  kind: MediaKind;
  mimeType: string;
  url: string;
  checksumSha256: string;
  sizeBytes: number;
  createdAt: string;
  expiresAt?: string | undefined;
}

export interface FrozenReleaseItem {
  id: string;
  asset: FrozenReleaseAsset;
  position: number;
  durationSeconds: number;
}

export interface PublishedReleaseRecord {
  id: string;
  organizationId: string;
  sourcePlaylistId: string;
  sourcePlaylistUpdatedAt: string;
  playlistName: string;
  playlistDescription: string;
  digestSha256: string;
  items: FrozenReleaseItem[];
  createdById: string;
  createdAt: string;
}

export interface ReleaseAssignmentRecord {
  id: string;
  organizationId: string;
  releaseId: string;
  scheduleId: string;
  screenIds: string[];
  state: "ASSIGNED" | "WITHDRAWN";
  schedule: FrozenScheduleSnapshot;
  digestSha256: string;
  previousAssignmentId?: string | undefined;
  createdById: string;
  createdAt: string;
}

export interface FrozenScheduleSnapshot {
  name: string;
  priority: Priority;
  startsAt: string;
  endsAt?: string | undefined;
  timezone: string;
  daysOfWeek: number[];
  dailyStartMinutes?: number | undefined;
  dailyEndMinutes?: number | undefined;
  enabled: boolean;
}

export interface ActiveOrdinaryRelease {
  release: PublishedReleaseRecord;
  assignment: ReleaseAssignmentRecord;
}

export interface ReleasePublicationPolicy {
  mediaAllowedOrigins: string[];
}

export interface ReleaseAuditContext {
  actorUserId: string;
  ipAddress?: string | undefined;
  requestId?: string | undefined;
}

export type SchedulePublicationInput = Omit<
  ScheduleRecord,
  | "id"
  | "organizationId"
  | "releaseId"
  | "assignmentId"
  | "createdAt"
  | "updatedAt"
>;

export type SchedulePublicationResult =
  | {
      published: true;
      schedule: ScheduleRecord;
      release: PublishedReleaseRecord;
      assignment: ReleaseAssignmentRecord;
    }
  | {
      published: false;
      reason:
        | "PLAYLIST_NOT_FOUND"
        | "SCREEN_NOT_FOUND"
        | "ASSET_NOT_FOUND"
        | "ASSET_NOT_ALLOWED"
        | "ASSET_UNSUPPORTED"
        | "ASSET_EXPIRED"
        | "RELEASE_TOO_LARGE"
        | "NO_PLAYABLE_ITEMS"
        | "FORBIDDEN";
    };

export type ScheduleWithdrawalResult =
  | { withdrawn: true; assignment: ReleaseAssignmentRecord }
  | {
      withdrawn: false;
      reason: "NOT_FOUND" | "ALREADY_WITHDRAWN" | "FORBIDDEN";
    };
export interface EmergencyRecord {
  id: string;
  organizationId: string;
  title: string;
  message: string;
  backgroundColor: string;
  targetScreenIds: string[];
  startsAt: string;
  expiresAt: string;
  clearedAt?: string | undefined;
  createdById: string;
  createdAt: string;
}
export type EmergencyActivationResult =
  | { activated: true; emergency: EmergencyRecord }
  | { activated: false; reason: "FORBIDDEN" | "INVALID_SCREEN" };

export type EmergencyClearResult =
  | { cleared: true; emergency: EmergencyRecord }
  | { cleared: false; reason: "FORBIDDEN" | "NOT_FOUND" };

export interface AuditRecord {
  id: string;
  organizationId: string;
  actorUserId?: string | undefined;
  actorType: string;
  action: string;
  entityType: string;
  entityId?: string | undefined;
  ipAddress?: string | undefined;
  requestId?: string | undefined;
  metadata: Record<string, unknown>;
  createdAt: string;
}
export interface PairingRecord {
  id: string;
  organizationId: string;
  codeHash: string;
  expiresAt: string;
  status: "PENDING" | "CLAIMED" | "EXPIRED" | "REVOKED";
  screenId?: string | undefined;
  purpose?: "NEW_SCREEN" | "REENROLL" | undefined;
  targetScreenId?: string | undefined;
  targetScreenReferenceId?: string | undefined;
  expectedGeneration?: number | undefined;
  authorizedByUserId?: string | undefined;
  priorCredentialId?: string | undefined;
  requestReason?: string | undefined;
}

export type PairingCreateResult =
  | { created: true; pairing: PairingRecord }
  | { created: false; reason: "CODE_COLLISION" };

export type AuditedPairingCreateResult =
  | { created: true; pairing: PairingRecord }
  | { created: false; reason: "CODE_COLLISION" | "FORBIDDEN" };

export interface PairingClaimAuditContext {
  ipAddress?: string | undefined;
  requestId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface PairingCreateAuditContext {
  actorUserId: string;
  ipAddress?: string | undefined;
  requestId?: string | undefined;
}

export type DeviceSecurityLevel =
  | "strongbox"
  | "trusted-environment"
  | "software"
  | "unknown-secure"
  | "unknown";

export interface DeviceCredentialEnrollment {
  keyId: string;
  publicKeySpki: string;
  algorithm: "ES256";
  securityLevel: DeviceSecurityLevel;
  expiresAt?: string | undefined;
}

export interface DeviceCredentialRecord extends DeviceCredentialEnrollment {
  id: string;
  organizationId: string;
  screenId: string;
  detached: boolean;
  revokedAt?: string | undefined;
  createdAt: string;
}

export interface PairingAttemptRecord {
  id: string;
  organizationId: string;
  pairingCodeId: string;
  keyId: string;
  publicKeySpki: string;
  algorithm: "ES256";
  securityLevel: DeviceSecurityLevel;
  credentialExpiresAt?: string | undefined;
  challengeHashSha256: string;
  transcriptDigestSha256: string;
  expiresAt: string;
  consumedAt?: string | undefined;
  provedAt?: string | undefined;
  activatedAt?: string | undefined;
  cancelledAt?: string | undefined;
  installationId?: string | undefined;
  model?: string | undefined;
  osVersion?: string | undefined;
  playerVersion?: string | undefined;
  boundCredentialId?: string | undefined;
  createdAt: string;
}

export type PairingProofVerifier = (
  credential: DeviceCredentialEnrollment,
) => boolean | Promise<boolean>;

export type PairingProofClaimResult =
  | {
      paired: true;
      screen: ScreenRecord;
      credential: DeviceCredentialRecord;
    }
  | {
      paired: false;
      reason: "PENDING_APPROVAL";
      grantId: string;
      candidateId: string;
      keyId: string;
      expiresAt: string;
    }
  | { paired: false; reason: "INVALID" };

export interface ReenrollmentCandidateRecord {
  id: string;
  grantId: string;
  screenId: string;
  keyId: string;
  fingerprint: string;
  securityLevel: DeviceSecurityLevel;
  installationId: string;
  model: string;
  osVersion: string;
  playerVersion: string;
  provedAt: string;
  expiresAt: string;
}

export type ReenrollmentRequestResult =
  | { created: true; pairing: PairingRecord }
  | { created: false; reason: "NOT_FOUND" | "FORBIDDEN" | "CODE_COLLISION" };
export type ReenrollmentActivationResult =
  | {
      activated: true;
      screen: ScreenRecord;
      credential: DeviceCredentialRecord;
    }
  | { activated: false; reason: "NOT_FOUND" | "FORBIDDEN" | "STALE" };
export type ReenrollmentCancelResult =
  { cancelled: true } | { cancelled: false; reason: "NOT_FOUND" | "FORBIDDEN" };

export type DeviceAuthOperation = "heartbeat" | "manifest";

export interface DeviceAuthChallengeRecord {
  id: string;
  organizationId: string;
  credentialId: string;
  challengeHashSha256: string;
  operation: DeviceAuthOperation;
  requestDigestSha256: string;
  expiresAt: string;
  consumedAt?: string | undefined;
  createdAt: string;
}

export interface DeviceProofInput {
  credentialId: string;
  challengeId: string;
  challengeHashSha256: string;
  operation: DeviceAuthOperation;
  requestDigestSha256: string;
}

export type DeviceProofVerifier = (
  credential: DeviceCredentialRecord,
) => boolean | Promise<boolean>;

export type DeviceProofResult =
  | {
      authenticated: true;
      credential: DeviceCredentialRecord;
      screen: ScreenRecord;
    }
  | { authenticated: false; reason: "INVALID_PROOF" };

export interface DeviceCredentialRevokeAuditContext {
  actorUserId: string;
  ipAddress?: string | undefined;
  requestId?: string | undefined;
}

export type UserMutationAuditContext = DeviceCredentialRevokeAuditContext;

export type AuditedCreateResult<T> =
  { created: true; value: T } | { created: false; reason: "FORBIDDEN" };

export type AuditedUpdateResult<T> =
  | { updated: true; value: T }
  | { updated: false; reason: "NOT_FOUND" | "FORBIDDEN" };

export type AuditedPlaylistCreateResult =
  | { created: true; value: PlaylistRecord }
  | { created: false; reason: "FORBIDDEN" | "INVALID_ASSET" };

export type AuditedDeleteResult =
  | { deleted: true }
  | { deleted: false; reason: "NOT_FOUND" | "IN_USE" | "FORBIDDEN" };

export type DeviceCredentialRevokeResult =
  | { revoked: true; credential?: DeviceCredentialRecord | undefined }
  | {
      revoked: false;
      reason: "NOT_FOUND" | "ALREADY_REVOKED" | "FORBIDDEN";
    };

export type DeleteResult = "DELETED" | "NOT_FOUND" | "IN_USE";

export interface DataStore {
  ping(): Promise<void>;
  close?(): Promise<void>;
  findUserByEmail(email: string): Promise<SessionUser | null>;
  recordLoginFailure(input: LoginFailureInput): Promise<void>;
  findSessionUser(
    userId: string,
    organizationId: string,
  ): Promise<SessionUser | null>;
  createUserSessionAndAudit(
    organizationId: string,
    input: UserSessionCreateInput,
    audit: UserMutationAuditContext,
  ): Promise<UserSessionCreateResult>;
  findActiveUserSession(
    userId: string,
    organizationId: string,
    tokenHash: string,
  ): Promise<SessionUser | null>;
  revokeUserSessionAndAudit(
    userId: string,
    organizationId: string,
    tokenHash: string,
    audit: UserMutationAuditContext,
  ): Promise<UserSessionRevokeResult>;
  listScreens(orgId: string): Promise<ScreenRecord[]>;
  getScreen(orgId: string, id: string): Promise<ScreenRecord | null>;
  createScreen(
    orgId: string,
    data: Pick<
      ScreenRecord,
      "name" | "location" | "orientation" | "resolution" | "tags"
    >,
  ): Promise<ScreenRecord>;
  createScreenAndAudit(
    orgId: string,
    data: Pick<
      ScreenRecord,
      "name" | "location" | "orientation" | "resolution" | "tags"
    >,
    audit: UserMutationAuditContext,
  ): Promise<AuditedCreateResult<ScreenRecord>>;
  updateScreen(
    orgId: string,
    id: string,
    data: Partial<
      Pick<
        ScreenRecord,
        "name" | "location" | "orientation" | "resolution" | "tags"
      >
    >,
  ): Promise<ScreenRecord | null>;
  updateScreenAndAudit(
    orgId: string,
    id: string,
    data: Partial<
      Pick<
        ScreenRecord,
        "name" | "location" | "orientation" | "resolution" | "tags"
      >
    >,
    audit: UserMutationAuditContext,
  ): Promise<AuditedUpdateResult<ScreenRecord>>;
  deleteScreen(orgId: string, id: string): Promise<boolean>;
  deleteScreenAndAudit(
    orgId: string,
    id: string,
    audit: DeviceCredentialRevokeAuditContext,
  ): Promise<"DELETED" | "NOT_FOUND" | "FORBIDDEN">;
  createPairing(
    orgId: string,
    codeHash: string,
    expiresAt: string,
  ): Promise<PairingRecord>;
  tryCreatePairing(
    orgId: string,
    codeHash: string,
    expiresAt: string,
  ): Promise<PairingCreateResult>;
  tryCreatePairingAndAudit(
    orgId: string,
    codeHash: string,
    expiresAt: string,
    audit: PairingCreateAuditContext,
  ): Promise<AuditedPairingCreateResult>;
  requestScreenReenrollmentAndAudit(
    orgId: string,
    screenId: string,
    codeHash: string,
    expiresAt: string,
    reason: string,
    audit: PairingCreateAuditContext,
  ): Promise<ReenrollmentRequestResult>;
  getReenrollmentStatus(
    orgId: string,
    screenId: string,
    grantId: string,
    actorUserId: string,
  ): Promise<{
    grantId: string;
    screenId: string;
    status: PairingRecord["status"];
    expiresAt: string;
    candidates: ReenrollmentCandidateRecord[];
  } | null>;
  activateReenrollmentCandidateAndAudit(
    orgId: string,
    screenId: string,
    grantId: string,
    candidateId: string,
    audit: PairingCreateAuditContext,
  ): Promise<ReenrollmentActivationResult>;
  cancelScreenReenrollmentAndAudit(
    orgId: string,
    screenId: string,
    grantId: string,
    audit: PairingCreateAuditContext,
  ): Promise<ReenrollmentCancelResult>;
  claimPairing(
    codeHash: string,
    device: {
      installationId: string;
      model: string;
      osVersion: string;
      playerVersion: string;
    },
    tokenHash: string,
  ): Promise<ScreenRecord | null>;
  claimPairingAndAudit(
    codeHash: string,
    device: {
      installationId: string;
      model: string;
      osVersion: string;
      playerVersion: string;
    },
    tokenHash: string,
    audit: PairingClaimAuditContext,
  ): Promise<ScreenRecord | null>;
  issuePairingChallenge(input: {
    codeHash: string;
    credential: DeviceCredentialEnrollment;
    challengeHashSha256: string;
    transcriptDigestSha256: string;
    expiresAt: string;
  }): Promise<PairingAttemptRecord | null>;
  claimPairingWithCredentialAndAudit(
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
  ): Promise<PairingProofClaimResult>;
  authenticateDevice(screenId: string): Promise<ScreenRecord | null>;
  authenticateDeviceCredential(
    screenId: string,
    keyId: string,
  ): Promise<DeviceProofResult>;
  issueDeviceAuthChallenge(input: {
    screenId: string;
    keyId: string;
    challengeHashSha256: string;
    operation: DeviceAuthOperation;
    requestDigestSha256: string;
    expiresAt: string;
  }): Promise<DeviceAuthChallengeRecord | null>;
  consumeDeviceAuthChallenge(
    input: DeviceProofInput,
    verify: DeviceProofVerifier,
  ): Promise<DeviceProofResult>;
  heartbeatWithDeviceProof(
    input: DeviceProofInput,
    data: HeartbeatUpdateInput,
    verify: DeviceProofVerifier,
  ): Promise<DeviceProofResult>;
  revokeDeviceCredentialAndAudit(
    orgId: string,
    screenId: string,
    audit: DeviceCredentialRevokeAuditContext,
  ): Promise<DeviceCredentialRevokeResult>;
  heartbeat(
    screenId: string,
    data: HeartbeatUpdateInput,
  ): Promise<ScreenRecord | null>;
  listMedia(orgId: string): Promise<MediaRecord[]>;
  createMedia(
    orgId: string,
    data: Omit<
      MediaRecord,
      "id" | "organizationId" | "createdAt" | "updatedAt"
    >,
  ): Promise<MediaRecord>;
  createMediaAndAudit(
    orgId: string,
    data: Omit<
      MediaRecord,
      "id" | "organizationId" | "createdAt" | "updatedAt"
    >,
    audit: UserMutationAuditContext,
  ): Promise<AuditedCreateResult<MediaRecord>>;
  getMedia(orgId: string, id: string): Promise<MediaRecord | null>;
  deleteMedia(orgId: string, id: string): Promise<DeleteResult>;
  deleteMediaAndAudit(
    orgId: string,
    id: string,
    audit: UserMutationAuditContext,
  ): Promise<AuditedDeleteResult>;
  listPlaylists(orgId: string): Promise<PlaylistRecord[]>;
  createPlaylist(
    orgId: string,
    data: Pick<PlaylistRecord, "name" | "description" | "items">,
  ): Promise<PlaylistRecord>;
  createPlaylistAndAudit(
    orgId: string,
    data: Pick<PlaylistRecord, "name" | "description" | "items">,
    audit: UserMutationAuditContext,
  ): Promise<AuditedPlaylistCreateResult>;
  getPlaylist(orgId: string, id: string): Promise<PlaylistRecord | null>;
  deletePlaylist(orgId: string, id: string): Promise<DeleteResult>;
  deletePlaylistAndAudit(
    orgId: string,
    id: string,
    audit: UserMutationAuditContext,
  ): Promise<AuditedDeleteResult>;
  listSchedules(orgId: string): Promise<ScheduleRecord[]>;
  createSchedule(
    orgId: string,
    data: Omit<
      ScheduleRecord,
      "id" | "organizationId" | "createdAt" | "updatedAt"
    >,
  ): Promise<ScheduleRecord>;
  deleteSchedule(orgId: string, id: string): Promise<boolean>;
  publishScheduleAndAudit(
    orgId: string,
    data: SchedulePublicationInput,
    audit: ReleaseAuditContext,
    policy: ReleasePublicationPolicy,
  ): Promise<SchedulePublicationResult>;
  withdrawScheduleAndAudit(
    orgId: string,
    scheduleId: string,
    audit: ReleaseAuditContext,
  ): Promise<ScheduleWithdrawalResult>;
  activeOrdinaryReleases(
    orgId: string,
    screenId: string,
    at: string,
  ): Promise<ActiveOrdinaryRelease[]>;
  activeSchedules(
    orgId: string,
    screenId: string,
    at: string,
  ): Promise<ScheduleRecord[]>;
  activeEmergency(
    orgId: string,
    screenId: string,
    at: string,
  ): Promise<EmergencyRecord | null>;
  activateEmergencyAndAudit(
    orgId: string,
    data: Pick<
      EmergencyRecord,
      "title" | "message" | "backgroundColor" | "targetScreenIds" | "expiresAt"
    >,
    audit: UserMutationAuditContext,
  ): Promise<EmergencyActivationResult>;
  clearEmergencyAndAudit(
    orgId: string,
    id: string,
    audit: UserMutationAuditContext,
  ): Promise<EmergencyClearResult>;
  listAudits(orgId: string, limit: number): Promise<AuditRecord[]>;
  audit(event: Omit<AuditRecord, "id" | "createdAt">): Promise<void>;
}
