import { Prisma, PrismaClient } from "@prisma/client";
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

const iso = (v: Date | null | undefined) => v?.toISOString();
const enumLower = <T extends string>(v: string) => v.toLowerCase() as T;
const safeInteger = (value: unknown, field: string): number => {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted))
    throw new RangeError(`${field} exceeds the JSON safe-integer range`);
  return converted;
};
const screenStatus = (x: Record<string, unknown>): ScreenRecord["status"] => {
  const stored = enumLower<ScreenRecord["status"]>(String(x.status));
  if (stored === "fallback") return stored;
  const lastSeen = x.lastSeenAt instanceof Date ? x.lastSeenAt.getTime() : 0;
  if (!x.installationId || !lastSeen) return "offline";
  const ageMs = Date.now() - lastSeen;
  if (ageMs > 5 * 60_000) return "offline";
  if (ageMs > 2 * 60_000) return "warning";
  return "online";
};
const screenDto = (
  x: Record<string, unknown>,
  includeCredential = false,
): ScreenRecord => ({
  id: String(x.id),
  organizationId: String(x.organizationId),
  name: String(x.name),
  location: String(x.location),
  status: screenStatus(x),
  orientation: enumLower<ScreenRecord["orientation"]>(String(x.orientation)),
  resolution: String(x.resolution),
  tags: x.tags as string[],
  ...(x.installationId ? { installationId: String(x.installationId) } : {}),
  ...(includeCredential && x.deviceTokenHash
    ? { deviceTokenHash: String(x.deviceTokenHash) }
    : {}),
  ...(x.model ? { model: String(x.model) } : {}),
  ...(x.osVersion ? { osVersion: String(x.osVersion) } : {}),
  ...(x.playerVersion ? { playerVersion: String(x.playerVersion) } : {}),
  ...(x.manifestVersion ? { manifestVersion: String(x.manifestVersion) } : {}),
  ...(x.nowPlayingAssetId
    ? { nowPlayingAssetId: String(x.nowPlayingAssetId) }
    : {}),
  ...(x.uptimeSeconds != null
    ? { uptimeSeconds: safeInteger(x.uptimeSeconds, "uptimeSeconds") }
    : {}),
  ...(x.freeStorageBytes != null
    ? { freeStorageBytes: safeInteger(x.freeStorageBytes, "freeStorageBytes") }
    : {}),
  ...(x.networkType ? { networkType: String(x.networkType) } : {}),
  ...(x.lastSeenAt ? { lastSeenAt: iso(x.lastSeenAt as Date) } : {}),
  ...(x.credentialRevokedAt
    ? { credentialRevokedAt: iso(x.credentialRevokedAt as Date) }
    : {}),
  createdAt: iso(x.createdAt as Date)!,
  updatedAt: iso(x.updatedAt as Date)!,
});
const mediaDto = (x: Record<string, unknown>): MediaRecord => ({
  id: String(x.id),
  organizationId: String(x.organizationId),
  name: String(x.name),
  kind: enumLower<MediaRecord["kind"]>(String(x.kind)),
  mimeType: String(x.mimeType),
  url: String(x.url),
  checksumSha256: String(x.checksumSha256),
  sizeBytes: safeInteger(x.sizeBytes, "sizeBytes"),
  ...(x.durationSeconds != null
    ? { durationSeconds: Number(x.durationSeconds) }
    : {}),
  ...(x.expiresAt ? { expiresAt: iso(x.expiresAt as Date) } : {}),
  createdAt: iso(x.createdAt as Date)!,
  updatedAt: iso(x.updatedAt as Date)!,
});
const playlistDto = (x: Record<string, unknown>): PlaylistRecord => ({
  id: String(x.id),
  organizationId: String(x.organizationId),
  name: String(x.name),
  description: String(x.description),
  items: ((x.items ?? []) as Array<Record<string, unknown>>).map((i) => ({
    id: String(i.id),
    assetId: String(i.assetId),
    position: Number(i.position),
    durationSeconds: Number(i.durationSeconds),
  })),
  createdAt: iso(x.createdAt as Date)!,
  updatedAt: iso(x.updatedAt as Date)!,
});
const scheduleDto = (x: Record<string, unknown>): ScheduleRecord => ({
  id: String(x.id),
  organizationId: String(x.organizationId),
  playlistId: String(x.playlistId),
  name: String(x.name),
  priority: enumLower<ScheduleRecord["priority"]>(String(x.priority)),
  startsAt: iso(x.startsAt as Date)!,
  ...(x.endsAt ? { endsAt: iso(x.endsAt as Date) } : {}),
  timezone: String(x.timezone),
  daysOfWeek: x.daysOfWeek as number[],
  ...(x.dailyStartMinutes != null
    ? { dailyStartMinutes: Number(x.dailyStartMinutes) }
    : {}),
  ...(x.dailyEndMinutes != null
    ? { dailyEndMinutes: Number(x.dailyEndMinutes) }
    : {}),
  enabled: Boolean(x.enabled),
  screenIds: ((x.targets ?? []) as Array<{ screenId: string }>).map(
    (t) => t.screenId,
  ),
  createdAt: iso(x.createdAt as Date)!,
  updatedAt: iso(x.updatedAt as Date)!,
});
const emergencyDto = (x: Record<string, unknown>): EmergencyRecord => ({
  id: String(x.id),
  organizationId: String(x.organizationId),
  title: String(x.title),
  message: String(x.message),
  backgroundColor: String(x.backgroundColor),
  targetScreenIds: x.targetScreenIds as string[],
  startsAt: iso(x.startsAt as Date)!,
  expiresAt: iso(x.expiresAt as Date)!,
  ...(x.clearedAt ? { clearedAt: iso(x.clearedAt as Date) } : {}),
  createdById: String(x.createdById),
  createdAt: iso(x.createdAt as Date)!,
});

const pairingDto = (x: {
  id: string;
  organizationId: string;
  codeHash: string;
  expiresAt: Date;
  status: "PENDING" | "CLAIMED" | "EXPIRED" | "REVOKED";
  screenId: string | null;
}): PairingRecord => ({
  id: x.id,
  organizationId: x.organizationId,
  codeHash: x.codeHash,
  expiresAt: iso(x.expiresAt)!,
  status: x.status,
  ...(x.screenId ? { screenId: x.screenId } : {}),
});

const isUniqueConstraintError = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002";

export class PrismaStore implements DataStore {
  constructor(readonly prisma = new PrismaClient()) {}
  async ping() {
    await this.prisma.$queryRaw`SELECT 1`;
  }
  async close() {
    await this.prisma.$disconnect();
  }
  async findUserByEmail(email: string) {
    // Use equality on the same LOWER(email) expression enforced and indexed by
    // the custom migration. LIMIT 2 keeps pre-migration ambiguity fail-closed.
    const matches = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "User"
      WHERE LOWER("email") = ${email.toLowerCase()}
      ORDER BY "id" ASC
      LIMIT 2
    `;
    if (matches.length !== 1) return null;
    const x = await this.prisma.user.findUnique({
      where: { id: matches[0]!.id },
      include: {
        // Login does not yet accept an organization selector. Make the
        // compatibility default stable rather than relying on database order.
        memberships: { orderBy: { organizationId: "asc" }, take: 1 },
      },
    });
    const m = x?.memberships[0];
    return x && !x.disabledAt && m
      ? ({
          id: x.id,
          email: x.email,
          name: x.name,
          passwordHash: x.passwordHash,
          organizationId: m.organizationId,
          role: m.role,
        } satisfies SessionUser)
      : null;
  }
  async findSessionUser(userId: string, organizationId: string) {
    const x = await this.prisma.user.findFirst({
      where: {
        id: userId,
        disabledAt: null,
        memberships: { some: { organizationId } },
      },
      include: {
        memberships: { where: { organizationId }, take: 1 },
      },
    });
    const membership = x?.memberships[0];
    return x && membership
      ? {
          id: x.id,
          email: x.email,
          name: x.name,
          passwordHash: x.passwordHash,
          organizationId,
          role: membership.role,
        }
      : null;
  }
  async listScreens(org: string) {
    return (
      await this.prisma.screen.findMany({
        where: { organizationId: org },
        orderBy: { name: "asc" },
      })
    ).map((x) => screenDto(x));
  }
  async getScreen(org: string, id: string) {
    const x = await this.prisma.screen.findFirst({
      where: { id, organizationId: org },
    });
    return x ? screenDto(x) : null;
  }
  async createScreen(
    org: string,
    data: Pick<
      ScreenRecord,
      "name" | "location" | "orientation" | "resolution" | "tags"
    >,
  ) {
    return screenDto(
      await this.prisma.screen.create({
        data: {
          organizationId: org,
          ...data,
          orientation: data.orientation.toUpperCase() as
            "LANDSCAPE" | "PORTRAIT",
        },
      }),
    );
  }
  async updateScreen(
    org: string,
    id: string,
    data: Partial<
      Pick<
        ScreenRecord,
        "name" | "location" | "orientation" | "resolution" | "tags"
      >
    >,
  ) {
    if (!(await this.getScreen(org, id))) return null;
    const { orientation, ...rest } = data;
    return screenDto(
      await this.prisma.screen.update({
        where: { id },
        data: {
          ...rest,
          ...(orientation
            ? {
                orientation: orientation.toUpperCase() as
                  "LANDSCAPE" | "PORTRAIT",
              }
            : {}),
        },
      }),
    );
  }
  async deleteScreen(org: string, id: string) {
    const r = await this.prisma.screen.deleteMany({
      where: { id, organizationId: org },
    });
    return r.count > 0;
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
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.pairingCode.updateMany({
          where: {
            codeHash,
            status: "PENDING",
            expiresAt: { lte: new Date() },
          },
          data: { status: "EXPIRED" },
        });
        const pairing = await tx.pairingCode.create({
          data: {
            organizationId: org,
            codeHash,
            expiresAt: new Date(expiresAt),
          },
        });
        return { created: true, pairing: pairingDto(pairing) };
      });
    } catch (error) {
      // PostgreSQL aborts a transaction after a uniqueness violation, so map
      // the collision only after Prisma has rolled the transaction back.
      if (isUniqueConstraintError(error))
        return { created: false, reason: "CODE_COLLISION" };
      throw error;
    }
  }
  async tryCreatePairingAndAudit(
    org: string,
    codeHash: string,
    expiresAt: string,
    audit: PairingCreateAuditContext,
  ): Promise<PairingCreateResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.pairingCode.updateMany({
          where: {
            codeHash,
            status: "PENDING",
            expiresAt: { lte: new Date() },
          },
          data: { status: "EXPIRED" },
        });
        const pairing = await tx.pairingCode.create({
          data: {
            organizationId: org,
            codeHash,
            expiresAt: new Date(expiresAt),
          },
        });
        await tx.auditEvent.create({
          data: {
            organizationId: org,
            actorUserId: audit.actorUserId,
            actorType: "user",
            action: "pairing.created",
            entityType: "pairing",
            entityId: pairing.id,
            ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
            ...(audit.requestId ? { requestId: audit.requestId } : {}),
            metadata: { expiresAt },
          },
        });
        return { created: true, pairing: pairingDto(pairing) };
      });
    } catch (error) {
      // Map only after rollback: PostgreSQL keeps a transaction aborted after
      // the unique-index violation that represents a live-code collision.
      if (isUniqueConstraintError(error))
        return { created: false, reason: "CODE_COLLISION" };
      throw error;
    }
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
    return this.prisma.$transaction(async (tx) => {
      const p = await tx.pairingCode.findFirst({
        where: { codeHash, status: "PENDING" },
        orderBy: { createdAt: "desc" },
      });
      if (!p || p.status !== "PENDING" || p.expiresAt <= new Date())
        return null;
      const claimed = await tx.pairingCode.updateMany({
        where: { id: p.id, status: "PENDING", expiresAt: { gt: new Date() } },
        data: { status: "CLAIMED", claimedAt: new Date() },
      });
      if (claimed.count !== 1) return null;
      const x = await tx.screen.create({
        data: {
          organizationId: p.organizationId,
          name: `New screen ${device.installationId.slice(-6)}`,
          location: "Unassigned",
          installationId: device.installationId,
          model: device.model,
          osVersion: device.osVersion,
          playerVersion: device.playerVersion,
          deviceTokenHash: tokenHash,
          status: "ONLINE",
          lastSeenAt: new Date(),
        },
      });
      await tx.pairingCode.update({
        where: { id: p.id },
        data: { screenId: x.id, screenOrganizationId: p.organizationId },
      });
      return screenDto(x);
    });
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
    return this.prisma.$transaction(async (tx) => {
      const p = await tx.pairingCode.findFirst({
        where: { codeHash, status: "PENDING" },
        orderBy: { createdAt: "desc" },
      });
      if (!p || p.expiresAt <= new Date()) return null;
      const claimed = await tx.pairingCode.updateMany({
        where: { id: p.id, status: "PENDING", expiresAt: { gt: new Date() } },
        data: { status: "CLAIMED", claimedAt: new Date() },
      });
      if (claimed.count !== 1) return null;
      const screen = await tx.screen.create({
        data: {
          organizationId: p.organizationId,
          name: `New screen ${device.installationId.slice(-6)}`,
          location: "Unassigned",
          installationId: device.installationId,
          model: device.model,
          osVersion: device.osVersion,
          playerVersion: device.playerVersion,
          deviceTokenHash: tokenHash,
          status: "ONLINE",
          lastSeenAt: new Date(),
        },
      });
      await tx.pairingCode.update({
        where: { id: p.id },
        data: {
          screenId: screen.id,
          screenOrganizationId: p.organizationId,
        },
      });
      await tx.auditEvent.create({
        data: {
          organizationId: p.organizationId,
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
        },
      });
      return screenDto(screen);
    });
  }
  async authenticateDevice(id: string) {
    const x = await this.prisma.screen.findFirst({
      where: { id, credentialRevokedAt: null },
    });
    return x?.deviceTokenHash ? screenDto(x, true) : null;
  }
  async heartbeat(id: string, data: Partial<ScreenRecord>) {
    const x = await this.prisma.screen.findUnique({ where: { id } });
    if (!x) return null;
    const allowed = {
      ...(data.playerVersion !== undefined
        ? { playerVersion: data.playerVersion }
        : {}),
      ...(data.manifestVersion !== undefined
        ? { manifestVersion: data.manifestVersion }
        : {}),
      ...(data.nowPlayingAssetId !== undefined
        ? { nowPlayingAssetId: data.nowPlayingAssetId }
        : {}),
      ...(data.uptimeSeconds !== undefined
        ? { uptimeSeconds: BigInt(data.uptimeSeconds) }
        : {}),
      ...(data.freeStorageBytes !== undefined
        ? { freeStorageBytes: BigInt(data.freeStorageBytes) }
        : {}),
      ...(data.networkType !== undefined
        ? { networkType: data.networkType }
        : {}),
      lastSeenAt: new Date(),
      status: "ONLINE" as const,
    };
    return screenDto(
      await this.prisma.screen.update({ where: { id }, data: allowed }),
    );
  }
  async listMedia(org: string) {
    return (
      await this.prisma.mediaAsset.findMany({
        where: { organizationId: org },
        orderBy: { createdAt: "desc" },
      })
    ).map((x) => mediaDto(x));
  }
  async createMedia(
    org: string,
    data: Omit<
      MediaRecord,
      "id" | "organizationId" | "createdAt" | "updatedAt"
    >,
  ) {
    return mediaDto(
      await this.prisma.mediaAsset.create({
        data: {
          organizationId: org,
          name: data.name,
          kind: data.kind.toUpperCase() as
            "IMAGE" | "VIDEO" | "WEB" | "TEMPLATE",
          mimeType: data.mimeType,
          url: data.url,
          checksumSha256: data.checksumSha256,
          sizeBytes: BigInt(data.sizeBytes),
          durationSeconds: data.durationSeconds ?? null,
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        },
      }),
    );
  }
  async getMedia(org: string, id: string) {
    const x = await this.prisma.mediaAsset.findFirst({
      where: { id, organizationId: org },
    });
    return x ? mediaDto(x) : null;
  }
  async deleteMedia(org: string, id: string) {
    const r = await this.prisma.mediaAsset.deleteMany({
      where: { id, organizationId: org },
    });
    return r.count > 0;
  }
  async listPlaylists(org: string) {
    return (
      await this.prisma.playlist.findMany({
        where: { organizationId: org },
        include: { items: true },
      })
    ).map((x) => playlistDto(x));
  }
  async createPlaylist(
    org: string,
    data: Pick<PlaylistRecord, "name" | "description" | "items">,
  ) {
    return playlistDto(
      await this.prisma.playlist.create({
        data: {
          organizationId: org,
          name: data.name,
          description: data.description,
          items: {
            create: data.items.map((i) => ({
              organizationId: org,
              assetId: i.assetId,
              position: i.position,
              durationSeconds: i.durationSeconds,
            })),
          },
        },
        include: { items: true },
      }),
    );
  }
  async getPlaylist(org: string, id: string) {
    const x = await this.prisma.playlist.findFirst({
      where: { id, organizationId: org },
      include: { items: true },
    });
    return x ? playlistDto(x) : null;
  }
  async deletePlaylist(org: string, id: string) {
    const r = await this.prisma.playlist.deleteMany({
      where: { id, organizationId: org },
    });
    return r.count > 0;
  }
  async listSchedules(org: string) {
    return (
      await this.prisma.schedule.findMany({
        where: { organizationId: org },
        include: { targets: true },
      })
    ).map((x) => scheduleDto(x));
  }
  async createSchedule(
    org: string,
    data: Omit<
      ScheduleRecord,
      "id" | "organizationId" | "createdAt" | "updatedAt"
    >,
  ) {
    return scheduleDto(
      await this.prisma.schedule.create({
        data: {
          organizationId: org,
          playlistId: data.playlistId,
          name: data.name,
          priority: data.priority.toUpperCase() as
            "NORMAL" | "CAMPAIGN" | "PRIORITY" | "EMERGENCY",
          startsAt: new Date(data.startsAt),
          endsAt: data.endsAt ? new Date(data.endsAt) : null,
          timezone: data.timezone,
          daysOfWeek: data.daysOfWeek,
          dailyStartMinutes: data.dailyStartMinutes ?? null,
          dailyEndMinutes: data.dailyEndMinutes ?? null,
          enabled: data.enabled,
          targets: {
            create: data.screenIds.map((screenId) => ({
              organizationId: org,
              screenId,
            })),
          },
        },
        include: { targets: true },
      }),
    );
  }
  async deleteSchedule(org: string, id: string) {
    const r = await this.prisma.schedule.deleteMany({
      where: { id, organizationId: org },
    });
    return r.count > 0;
  }
  async activeSchedules(org: string, screenId: string, at: string) {
    const d = new Date(at);
    const xs = await this.prisma.schedule.findMany({
      where: {
        organizationId: org,
        enabled: true,
        startsAt: { lte: d },
        OR: [{ endsAt: null }, { endsAt: { gt: d } }],
        targets: { some: { screenId } },
      },
      include: { targets: true },
    });
    return xs
      .map((x) => scheduleDto(x))
      .filter((x) => matchesScheduleWindow(x, d));
  }
  async activeEmergency(org: string, screenId: string, at: string) {
    const d = new Date(at);
    const x = await this.prisma.emergencyOverride.findFirst({
      where: {
        organizationId: org,
        targetScreenIds: { has: screenId },
        startsAt: { lte: d },
        expiresAt: { gt: d },
        clearedAt: null,
      },
      orderBy: { createdAt: "desc" },
    });
    return x ? emergencyDto(x) : null;
  }
  async createEmergency(
    org: string,
    userId: string,
    data: Pick<
      EmergencyRecord,
      "title" | "message" | "backgroundColor" | "targetScreenIds" | "expiresAt"
    >,
  ) {
    return emergencyDto(
      await this.prisma.emergencyOverride.create({
        data: {
          organizationId: org,
          createdById: userId,
          ...data,
          expiresAt: new Date(data.expiresAt),
        },
      }),
    );
  }
  async clearEmergency(org: string, id: string) {
    const x = await this.prisma.emergencyOverride.findFirst({
      where: { id, organizationId: org },
    });
    if (!x) return null;
    return emergencyDto(
      await this.prisma.emergencyOverride.update({
        where: { id },
        data: { clearedAt: new Date() },
      }),
    );
  }
  async listAudits(org: string, limit: number) {
    return (
      await this.prisma.auditEvent.findMany({
        where: { organizationId: org },
        orderBy: { createdAt: "desc" },
        take: limit,
      })
    ).map((x) => ({
      id: x.id,
      organizationId: x.organizationId,
      ...(x.actorUserId ? { actorUserId: x.actorUserId } : {}),
      actorType: x.actorType,
      action: x.action,
      entityType: x.entityType,
      ...(x.entityId ? { entityId: x.entityId } : {}),
      ...(x.ipAddress ? { ipAddress: x.ipAddress } : {}),
      ...(x.requestId ? { requestId: x.requestId } : {}),
      metadata: x.metadata as Record<string, unknown>,
      createdAt: iso(x.createdAt)!,
    }));
  }
  async audit(event: Omit<AuditRecord, "id" | "createdAt">) {
    await this.prisma.auditEvent.create({
      data: {
        organizationId: event.organizationId,
        actorType: event.actorType,
        action: event.action,
        entityType: event.entityType,
        metadata: event.metadata as never,
        ...(event.actorUserId ? { actorUserId: event.actorUserId } : {}),
        ...(event.entityId ? { entityId: event.entityId } : {}),
        ...(event.ipAddress ? { ipAddress: event.ipAddress } : {}),
        ...(event.requestId ? { requestId: event.requestId } : {}),
      },
    });
  }
}
