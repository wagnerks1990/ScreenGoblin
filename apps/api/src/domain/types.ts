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
  createdAt: string;
  updatedAt: string;
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
  createdAt: string;
  updatedAt: string;
}
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
}

export type PairingCreateResult =
  | { created: true; pairing: PairingRecord }
  | { created: false; reason: "CODE_COLLISION" };

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

export interface DataStore {
  ping(): Promise<void>;
  close?(): Promise<void>;
  findUserByEmail(email: string): Promise<SessionUser | null>;
  findSessionUser(
    userId: string,
    organizationId: string,
  ): Promise<SessionUser | null>;
  listScreens(orgId: string): Promise<ScreenRecord[]>;
  getScreen(orgId: string, id: string): Promise<ScreenRecord | null>;
  createScreen(
    orgId: string,
    data: Pick<
      ScreenRecord,
      "name" | "location" | "orientation" | "resolution" | "tags"
    >,
  ): Promise<ScreenRecord>;
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
  deleteScreen(orgId: string, id: string): Promise<boolean>;
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
  ): Promise<PairingCreateResult>;
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
  authenticateDevice(screenId: string): Promise<ScreenRecord | null>;
  heartbeat(
    screenId: string,
    data: Partial<ScreenRecord>,
  ): Promise<ScreenRecord | null>;
  listMedia(orgId: string): Promise<MediaRecord[]>;
  createMedia(
    orgId: string,
    data: Omit<
      MediaRecord,
      "id" | "organizationId" | "createdAt" | "updatedAt"
    >,
  ): Promise<MediaRecord>;
  getMedia(orgId: string, id: string): Promise<MediaRecord | null>;
  deleteMedia(orgId: string, id: string): Promise<boolean>;
  listPlaylists(orgId: string): Promise<PlaylistRecord[]>;
  createPlaylist(
    orgId: string,
    data: Pick<PlaylistRecord, "name" | "description" | "items">,
  ): Promise<PlaylistRecord>;
  getPlaylist(orgId: string, id: string): Promise<PlaylistRecord | null>;
  deletePlaylist(orgId: string, id: string): Promise<boolean>;
  listSchedules(orgId: string): Promise<ScheduleRecord[]>;
  createSchedule(
    orgId: string,
    data: Omit<
      ScheduleRecord,
      "id" | "organizationId" | "createdAt" | "updatedAt"
    >,
  ): Promise<ScheduleRecord>;
  deleteSchedule(orgId: string, id: string): Promise<boolean>;
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
  createEmergency(
    orgId: string,
    userId: string,
    data: Pick<
      EmergencyRecord,
      "title" | "message" | "backgroundColor" | "targetScreenIds" | "expiresAt"
    >,
  ): Promise<EmergencyRecord>;
  clearEmergency(orgId: string, id: string): Promise<EmergencyRecord | null>;
  listAudits(orgId: string, limit: number): Promise<AuditRecord[]>;
  audit(event: Omit<AuditRecord, "id" | "createdAt">): Promise<void>;
}
