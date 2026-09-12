import type {
  AuditRecord,
  DataStore,
  EmergencyRecord,
  MediaRecord,
  PairingRecord,
  PairingClaimAuditContext,
  PairingCreateAuditContext,
  PairingCreateResult,
  PlaylistRecord,
  ScheduleRecord,
  ScreenRecord,
  SessionUser,
} from "../domain/types.js";
import { matchesScheduleWindow } from "../utils/schedule.js";

const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();

export class MemoryStore implements DataStore {
  users: SessionUser[] = [];
  screens: ScreenRecord[] = [];
  media: MediaRecord[] = [];
  playlists: PlaylistRecord[] = [];
  schedules: ScheduleRecord[] = [];
  emergencies: EmergencyRecord[] = [];
  audits: AuditRecord[] = [];
  pairings: PairingRecord[] = [];
  async ping() {}
  protected buildAuditRecord(
    event: Omit<AuditRecord, "id" | "createdAt">,
  ): AuditRecord {
    return { id: id(), ...event, createdAt: now() };
  }
  async findUserByEmail(email: string) {
    return (
      this.users
        .filter(
          (u) => u.email.toLowerCase() === email.toLowerCase() && !u.disabledAt,
        )
        .sort((a, b) => a.organizationId.localeCompare(b.organizationId))[0] ??
      null
    );
  }
  async findSessionUser(userId: string, organizationId: string) {
    return (
      this.users.find(
        (u) =>
          u.id === userId &&
          u.organizationId === organizationId &&
          !u.disabledAt,
      ) ?? null
    );
  }
  private publicScreen(screen: ScreenRecord): ScreenRecord {
    const safe = { ...screen };
    delete safe.deviceTokenHash;
    return safe;
  }
  async listScreens(org: string) {
    return this.screens
      .filter((x) => x.organizationId === org)
      .map((x) => this.publicScreen(x));
  }
  async getScreen(org: string, screenId: string) {
    return (
      this.screens
        .filter((x) => x.organizationId === org && x.id === screenId)
        .map((x) => this.publicScreen(x))[0] ?? null
    );
  }
  async createScreen(
    org: string,
    data: Pick<
      ScreenRecord,
      "name" | "location" | "orientation" | "resolution" | "tags"
    >,
  ) {
    const t = now();
    const x: ScreenRecord = {
      id: id(),
      organizationId: org,
      status: "offline",
      ...data,
      createdAt: t,
      updatedAt: t,
    };
    this.screens.push(x);
    return x;
  }
  async updateScreen(
    org: string,
    screenId: string,
    data: Partial<
      Pick<
        ScreenRecord,
        "name" | "location" | "orientation" | "resolution" | "tags"
      >
    >,
  ) {
    const x = this.screens.find(
      (screen) => screen.organizationId === org && screen.id === screenId,
    );
    if (!x) return null;
    Object.assign(x, data, { updatedAt: now() });
    return x;
  }
  async deleteScreen(org: string, screenId: string) {
    const n = this.screens.length;
    this.screens = this.screens.filter(
      (x) => !(x.organizationId === org && x.id === screenId),
    );
    return n !== this.screens.length;
  }
  async createPairing(org: string, codeHash: string, expiresAt: string) {
    const result = await this.tryCreatePairing(org, codeHash, expiresAt);
    if (!result.created) throw new Error("Pairing code collision");
    return result.pairing;
  }
  async tryCreatePairing(
    org: string,
    codeHash: string,
    expiresAt: string,
  ): Promise<PairingCreateResult> {
    const currentTime = now();
    for (const pairing of this.pairings) {
      if (
        pairing.codeHash === codeHash &&
        pairing.status === "PENDING" &&
        pairing.expiresAt <= currentTime
      ) {
        pairing.status = "EXPIRED";
      }
    }
    if (
      this.pairings.some(
        (pairing) =>
          pairing.codeHash === codeHash && pairing.status === "PENDING",
      )
    ) {
      return { created: false, reason: "CODE_COLLISION" };
    }
    const x: PairingRecord = {
      id: id(),
      organizationId: org,
      codeHash,
      expiresAt,
      status: "PENDING",
    };
    this.pairings.push(x);
    return { created: true, pairing: x };
  }
  async tryCreatePairingAndAudit(
    org: string,
    codeHash: string,
    expiresAt: string,
    audit: PairingCreateAuditContext,
  ): Promise<PairingCreateResult> {
    const currentTime = now();
    const expired = this.pairings.filter(
      (pairing) =>
        pairing.codeHash === codeHash &&
        pairing.status === "PENDING" &&
        pairing.expiresAt <= currentTime,
    );
    if (
      this.pairings.some(
        (pairing) =>
          pairing.codeHash === codeHash &&
          pairing.status === "PENDING" &&
          pairing.expiresAt > currentTime,
      )
    ) {
      return { created: false, reason: "CODE_COLLISION" };
    }
    const pairing: PairingRecord = {
      id: id(),
      organizationId: org,
      codeHash,
      expiresAt,
      status: "PENDING",
    };
    // Build the required audit before changing either in-memory collection.
    // This preserves transaction-like behavior for test doubles that reject it.
    const auditRecord = this.buildAuditRecord({
      organizationId: org,
      actorUserId: audit.actorUserId,
      actorType: "user",
      action: "pairing.created",
      entityType: "pairing",
      entityId: pairing.id,
      ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata: { expiresAt },
    });
    for (const existing of expired) existing.status = "EXPIRED";
    this.pairings.push(pairing);
    this.audits.push(auditRecord);
    return { created: true, pairing };
  }
  private claimPairingRecord(
    codeHash: string,
    device: {
      installationId: string;
      model: string;
      osVersion: string;
      playerVersion: string;
    },
    tokenHash: string,
  ): ScreenRecord | null {
    const p = this.pairings.find(
      (x) =>
        x.codeHash === codeHash &&
        x.status === "PENDING" &&
        x.expiresAt > now(),
    );
    if (!p) return null;
    const t = now();
    const x: ScreenRecord = {
      id: id(),
      organizationId: p.organizationId,
      name: `New screen ${device.installationId.slice(-6)}`,
      location: "Unassigned",
      status: "online",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
      ...device,
      deviceTokenHash: tokenHash,
      lastSeenAt: t,
      createdAt: t,
      updatedAt: t,
    };
    this.screens.push(x);
    p.status = "CLAIMED";
    p.screenId = x.id;
    return x;
  }
  async claimPairing(
    codeHash: string,
    device: {
      installationId: string;
      model: string;
      osVersion: string;
      playerVersion: string;
    },
    tokenHash: string,
  ) {
    return this.claimPairingRecord(codeHash, device, tokenHash);
  }
  async claimPairingAndAudit(
    codeHash: string,
    device: {
      installationId: string;
      model: string;
      osVersion: string;
      playerVersion: string;
    },
    tokenHash: string,
    audit: PairingClaimAuditContext,
  ) {
    const screen = this.claimPairingRecord(codeHash, device, tokenHash);
    if (!screen) return null;
    this.audits.push({
      id: id(),
      organizationId: screen.organizationId,
      actorType: "device",
      action: "device.paired",
      entityType: "screen",
      entityId: screen.id,
      ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata: {
        ...audit.metadata,
        installationId: device.installationId,
      },
      createdAt: now(),
    });
    return screen;
  }
  async authenticateDevice(screenId: string) {
    const screen = this.screens.find(
      (x) => x.id === screenId && !x.credentialRevokedAt,
    );
    return screen?.deviceTokenHash
      ? { ...screen, deviceTokenHash: screen.deviceTokenHash }
      : null;
  }
  async heartbeat(screenId: string, data: Partial<ScreenRecord>) {
    const x = this.screens.find((s) => s.id === screenId);
    if (!x) return null;
    Object.assign(x, data, {
      status: "online",
      lastSeenAt: now(),
      updatedAt: now(),
    });
    return x;
  }
  async listMedia(org: string) {
    return this.media.filter((x) => x.organizationId === org);
  }
  async createMedia(
    org: string,
    data: Omit<
      MediaRecord,
      "id" | "organizationId" | "createdAt" | "updatedAt"
    >,
  ) {
    const t = now();
    const x: MediaRecord = {
      id: id(),
      organizationId: org,
      ...data,
      createdAt: t,
      updatedAt: t,
    };
    this.media.push(x);
    return x;
  }
  async getMedia(org: string, assetId: string) {
    return (
      this.media.find((x) => x.organizationId === org && x.id === assetId) ??
      null
    );
  }
  async deleteMedia(org: string, assetId: string) {
    const n = this.media.length;
    this.media = this.media.filter(
      (x) => !(x.organizationId === org && x.id === assetId),
    );
    return n !== this.media.length;
  }
  async listPlaylists(org: string) {
    return this.playlists.filter((x) => x.organizationId === org);
  }
  async createPlaylist(
    org: string,
    data: Pick<PlaylistRecord, "name" | "description" | "items">,
  ) {
    const t = now();
    const x: PlaylistRecord = {
      id: id(),
      organizationId: org,
      ...data,
      items: data.items.map((v) => ({ ...v, id: id() })),
      createdAt: t,
      updatedAt: t,
    };
    this.playlists.push(x);
    return x;
  }
  async getPlaylist(org: string, playlistId: string) {
    return (
      this.playlists.find(
        (x) => x.organizationId === org && x.id === playlistId,
      ) ?? null
    );
  }
  async deletePlaylist(org: string, playlistId: string) {
    const n = this.playlists.length;
    this.playlists = this.playlists.filter(
      (x) => !(x.organizationId === org && x.id === playlistId),
    );
    return n !== this.playlists.length;
  }
  async listSchedules(org: string) {
    return this.schedules.filter((x) => x.organizationId === org);
  }
  async createSchedule(
    org: string,
    data: Omit<
      ScheduleRecord,
      "id" | "organizationId" | "createdAt" | "updatedAt"
    >,
  ) {
    const t = now();
    const x: ScheduleRecord = {
      id: id(),
      organizationId: org,
      ...data,
      createdAt: t,
      updatedAt: t,
    };
    this.schedules.push(x);
    return x;
  }
  async deleteSchedule(org: string, scheduleId: string) {
    const n = this.schedules.length;
    this.schedules = this.schedules.filter(
      (x) => !(x.organizationId === org && x.id === scheduleId),
    );
    return n !== this.schedules.length;
  }
  async activeSchedules(org: string, screenId: string, at: string) {
    const d = new Date(at);
    return this.schedules.filter(
      (x) =>
        x.organizationId === org &&
        x.screenIds.includes(screenId) &&
        x.enabled &&
        x.startsAt <= at &&
        (!x.endsAt || x.endsAt > at) &&
        matchesScheduleWindow(x, d),
    );
  }
  async activeEmergency(org: string, screenId: string, at: string) {
    return (
      this.emergencies.find(
        (x) =>
          x.organizationId === org &&
          x.targetScreenIds.includes(screenId) &&
          x.startsAt <= at &&
          x.expiresAt > at &&
          !x.clearedAt,
      ) ?? null
    );
  }
  async createEmergency(
    org: string,
    userId: string,
    data: Pick<
      EmergencyRecord,
      "title" | "message" | "backgroundColor" | "targetScreenIds" | "expiresAt"
    >,
  ) {
    const t = now();
    const x: EmergencyRecord = {
      id: id(),
      organizationId: org,
      createdById: userId,
      startsAt: t,
      ...data,
      createdAt: t,
    };
    this.emergencies.push(x);
    return x;
  }
  async clearEmergency(org: string, overrideId: string) {
    const x = this.emergencies.find(
      (e) => e.organizationId === org && e.id === overrideId,
    );
    if (!x) return null;
    x.clearedAt = now();
    return x;
  }
  async listAudits(org: string, limit: number) {
    return this.audits
      .filter((x) => x.organizationId === org)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
  async audit(event: Omit<AuditRecord, "id" | "createdAt">) {
    this.audits.push(this.buildAuditRecord(event));
  }
}
