import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaStore } from "../src/store/prisma.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required for PostgreSQL integration tests; run migrations before this suite",
  );
}
if (process.env.SCREEN_GOBLIN_ALLOW_TEST_DATABASE_RESET !== "true") {
  throw new Error(
    "SCREEN_GOBLIN_ALLOW_TEST_DATABASE_RESET=true is required because this suite truncates its database",
  );
}
const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
const databaseHost = new URL(databaseUrl).hostname;
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
if (databaseName !== "screengoblin_test" || !loopbackHosts.has(databaseHost)) {
  throw new Error(
    "Refusing to truncate PostgreSQL: integration tests require the exact " +
      'database name "screengoblin_test" on a loopback host',
  );
}

const store = new PrismaStore();
const prisma = store.prisma;
const proofHash = () => randomUUID().replaceAll("-", "").repeat(2);
const proofEnrollment = (byte: number) => ({
  keyId: Buffer.alloc(32, byte).toString("base64url"),
  publicKeySpki: Buffer.alloc(91, byte).toString("base64url"),
  algorithm: "ES256" as const,
  securityLevel: "trusted-environment" as const,
});

const createOrganization = (label: string) =>
  prisma.organization.create({
    data: {
      name: `Integration ${label}`,
      slug: `integration-${label}-${randomUUID()}`,
    },
  });

const createUser = (email: string) =>
  prisma.user.create({
    data: {
      email,
      name: "Integration User",
      passwordHash: "integration-test-hash",
    },
  });

const createMember = async (
  organizationId: string,
  role: "OWNER" | "ADMIN" | "PUBLISHER" | "VIEWER",
  label: string,
  disabled = false,
) => {
  const user = await prisma.user.create({
    data: {
      email: `${label}-${randomUUID()}@example.test`,
      name: `Integration ${role}`,
      passwordHash: "integration-test-hash",
      ...(disabled ? { disabledAt: new Date() } : {}),
    },
  });
  await prisma.membership.create({
    data: { organizationId, userId: user.id, role },
  });
  return user;
};

const pairProofDevice = async (label: string, byte: number) => {
  const organization = await createOrganization(label);
  const pairing = await store.createPairing(
    organization.id,
    `proof-code-${randomUUID()}`,
    new Date(Date.now() + 60_000).toISOString(),
  );
  const credential = proofEnrollment(byte);
  const challengeHashSha256 = proofHash();
  const transcriptDigestSha256 = proofHash();
  const attempt = await store.issuePairingChallenge({
    codeHash: pairing.codeHash,
    credential,
    challengeHashSha256,
    transcriptDigestSha256,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  });
  if (!attempt) throw new Error("proof pairing challenge was not issued");
  const claimInput = {
    codeHash: pairing.codeHash,
    pairingAttemptId: attempt.id,
    challengeHashSha256,
    transcriptDigestSha256,
    keyId: credential.keyId,
    device: {
      installationId: `proof-installation-${randomUUID()}`,
      model: "Proof player",
      osVersion: "test",
      playerVersion: "0.1.0",
    },
  };
  const result = await store.claimPairingWithCredentialAndAudit(
    claimInput,
    () => true,
    { requestId: `proof-pair-${label}` },
  );
  if (!result.paired) throw new Error("proof pairing failed");
  return { organization, pairing, attempt, claimInput, ...result };
};

const stageReenrollmentCandidate = async (
  label: string,
  oldKeyByte: number,
  newKeyByte: number,
) => {
  const paired = await pairProofDevice(label, oldKeyByte);
  const actor = await createUser(`${label}-${randomUUID()}@example.test`);
  await prisma.membership.create({
    data: {
      organizationId: paired.organization.id,
      userId: actor.id,
      role: "OWNER",
    },
  });
  const grant = await store.requestScreenReenrollmentAndAudit(
    paired.organization.id,
    paired.screen.id,
    `reenroll-${randomUUID()}`,
    new Date(Date.now() + 60_000).toISOString(),
    "Replace failed player hardware",
    { actorUserId: actor.id },
  );
  if (!grant.created) throw new Error("re-enrollment grant was not created");
  const credential = proofEnrollment(newKeyByte);
  const challengeHashSha256 = proofHash();
  const transcriptDigestSha256 = proofHash();
  const attempt = await store.issuePairingChallenge({
    codeHash: grant.pairing.codeHash,
    credential,
    challengeHashSha256,
    transcriptDigestSha256,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  });
  if (!attempt) throw new Error("re-enrollment challenge was not issued");
  const candidate = await store.claimPairingWithCredentialAndAudit(
    {
      codeHash: grant.pairing.codeHash,
      pairingAttemptId: attempt.id,
      challengeHashSha256,
      transcriptDigestSha256,
      keyId: credential.keyId,
      device: {
        installationId: credential.keyId,
        model: "Replacement player",
        osVersion: "15",
        playerVersion: "0.2.0",
      },
    },
    () => true,
    { requestId: `proof-reenroll-${label}` },
  );
  if (candidate.paired || candidate.reason !== "PENDING_APPROVAL")
    throw new Error("re-enrollment candidate was not staged");
  return { paired, actor, grant: grant.pairing, credential, candidate };
};

beforeAll(async () => {
  await store.ping();
});

beforeEach(async () => {
  // This job owns an isolated CI database. CASCADE keeps cleanup compatible
  // with new tenant-owned tables while retaining the migrated schema itself.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Organization", "User", "DeviceKeyTombstone" RESTART IDENTITY CASCADE',
  );
});

afterAll(async () => {
  await store.close();
});

describe("PrismaStore PostgreSQL integration", () => {
  it("keeps tenant-owned reads, lookups, updates, and deletes within the requested organization", async () => {
    const [alpha, beta] = await Promise.all([
      createOrganization("alpha"),
      createOrganization("beta"),
    ]);
    const alphaScreen = await store.createScreen(alpha.id, {
      name: "Alpha display",
      location: "Alpha lobby",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: ["alpha"],
    });
    const betaScreen = await store.createScreen(beta.id, {
      name: "Beta display",
      location: "Beta lobby",
      orientation: "portrait",
      resolution: "1080x1920",
      tags: ["beta"],
    });
    const alphaMedia = await store.createMedia(alpha.id, {
      name: "Alpha image",
      kind: "image",
      mimeType: "image/png",
      url: "https://media.example.test/alpha.png",
      checksumSha256: "a".repeat(64),
      sizeBytes: 1_024,
    });
    const betaMedia = await store.createMedia(beta.id, {
      name: "Beta image",
      kind: "image",
      mimeType: "image/png",
      url: "https://media.example.test/beta.png",
      checksumSha256: "b".repeat(64),
      sizeBytes: 2_048,
    });
    const alphaPlaylist = await store.createPlaylist(alpha.id, {
      name: "Alpha playlist",
      description: "Tenant-isolation fixture",
      items: [
        {
          id: "ignored-by-create",
          assetId: alphaMedia.id,
          position: 0,
          durationSeconds: 15,
        },
      ],
    });
    const betaPlaylist = await store.createPlaylist(beta.id, {
      name: "Beta playlist",
      description: "Tenant-isolation fixture",
      items: [
        {
          id: "ignored-by-create",
          assetId: betaMedia.id,
          position: 0,
          durationSeconds: 20,
        },
      ],
    });
    const startsAt = new Date(Date.now() - 60_000).toISOString();
    await store.createSchedule(alpha.id, {
      playlistId: alphaPlaylist.id,
      name: "Alpha schedule",
      priority: "normal",
      startsAt,
      timezone: "UTC",
      daysOfWeek: [],
      enabled: true,
      screenIds: [alphaScreen.id],
    });
    await store.createSchedule(beta.id, {
      playlistId: betaPlaylist.id,
      name: "Beta schedule",
      priority: "normal",
      startsAt,
      timezone: "UTC",
      daysOfWeek: [],
      enabled: true,
      screenIds: [betaScreen.id],
    });
    await store.audit({
      organizationId: alpha.id,
      actorType: "system",
      action: "integration.alpha",
      entityType: "test",
      metadata: {},
    });
    await store.audit({
      organizationId: beta.id,
      actorType: "system",
      action: "integration.beta",
      entityType: "test",
      metadata: {},
    });

    expect((await store.listScreens(alpha.id)).map((x) => x.id)).toEqual([
      alphaScreen.id,
    ]);
    expect((await store.listMedia(alpha.id)).map((x) => x.id)).toEqual([
      alphaMedia.id,
    ]);
    expect((await store.listPlaylists(alpha.id)).map((x) => x.id)).toEqual([
      alphaPlaylist.id,
    ]);
    expect((await store.listSchedules(alpha.id)).map((x) => x.name)).toEqual([
      "Alpha schedule",
    ]);
    expect((await store.listAudits(alpha.id, 10)).map((x) => x.action)).toEqual(
      ["integration.alpha"],
    );
    await expect(store.getScreen(alpha.id, betaScreen.id)).resolves.toBeNull();
    await expect(store.getMedia(alpha.id, betaMedia.id)).resolves.toBeNull();
    await expect(
      store.getPlaylist(alpha.id, betaPlaylist.id),
    ).resolves.toBeNull();
    await expect(
      store.updateScreen(alpha.id, betaScreen.id, { name: "Cross tenant" }),
    ).resolves.toBeNull();
    await expect(store.deleteScreen(alpha.id, betaScreen.id)).resolves.toBe(
      false,
    );
    await expect(store.deleteMedia(alpha.id, betaMedia.id)).resolves.toBe(
      "NOT_FOUND",
    );
    await expect(store.deletePlaylist(alpha.id, betaPlaylist.id)).resolves.toBe(
      "NOT_FOUND",
    );
  });

  it("rolls back ordinary content mutations when their required audit insert fails", async () => {
    const organization = await createOrganization("ordinary-audit-rollback");
    const actor = await createMember(organization.id, "ADMIN", "rollback");
    const screen = await store.createScreen(organization.id, {
      name: "Original screen",
      location: "Lobby",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const media = await store.createMedia(organization.id, {
      name: "Existing media",
      kind: "image",
      mimeType: "image/png",
      url: "https://media.example.test/existing.png",
      checksumSha256: "8".repeat(64),
      sizeBytes: 100,
    });
    const playlist = await store.createPlaylist(organization.id, {
      name: "Existing playlist",
      description: "Rollback fixture",
      items: [],
    });
    const audit = {
      actorUserId: actor.id,
      ipAddress: "127.0.0.1",
      requestId: "ordinary-audit-rollback",
    };

    await prisma.$executeRawUnsafe(
      "ALTER TABLE \"AuditEvent\" ADD CONSTRAINT \"integration_reject_ordinary_audits\" CHECK (\"action\" NOT IN ('screen.created', 'screen.updated', 'media.created', 'media.deleted', 'playlist.created', 'playlist.deleted'))",
    );
    try {
      await expect(
        store.createScreenAndAudit(
          organization.id,
          {
            name: "Rolled-back screen",
            location: "Hall",
            orientation: "portrait",
            resolution: "1080x1920",
            tags: ["rollback"],
          },
          audit,
        ),
      ).rejects.toThrow();
      await expect(
        store.updateScreenAndAudit(
          organization.id,
          screen.id,
          { name: "Rolled-back update" },
          audit,
        ),
      ).rejects.toThrow();
      await expect(
        store.createMediaAndAudit(
          organization.id,
          {
            name: "Rolled-back media",
            kind: "image",
            mimeType: "image/png",
            url: "https://media.example.test/rolled-back.png",
            checksumSha256: "9".repeat(64),
            sizeBytes: 200,
          },
          audit,
        ),
      ).rejects.toThrow();
      await expect(
        store.deleteMediaAndAudit(organization.id, media.id, audit),
      ).rejects.toThrow();
      await expect(
        store.createPlaylistAndAudit(
          organization.id,
          {
            name: "Rolled-back playlist",
            description: "Must not persist",
            items: [],
          },
          audit,
        ),
      ).rejects.toThrow();
      await expect(
        store.deletePlaylistAndAudit(organization.id, playlist.id, audit),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" DROP CONSTRAINT "integration_reject_ordinary_audits"',
      );
    }

    await expect(
      prisma.screen.findUniqueOrThrow({ where: { id: screen.id } }),
    ).resolves.toMatchObject({ name: "Original screen" });
    expect(
      await prisma.screen.count({ where: { name: "Rolled-back screen" } }),
    ).toBe(0);
    await expect(
      prisma.mediaAsset.findUnique({ where: { id: media.id } }),
    ).resolves.not.toBeNull();
    expect(
      await prisma.mediaAsset.count({ where: { name: "Rolled-back media" } }),
    ).toBe(0);
    await expect(
      prisma.playlist.findUnique({ where: { id: playlist.id } }),
    ).resolves.not.toBeNull();
    expect(
      await prisma.playlist.count({ where: { name: "Rolled-back playlist" } }),
    ).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("rolls back emergency activation and clear when their audit insert fails", async () => {
    const organization = await createOrganization("emergency-audit-rollback");
    const actor = await createMember(organization.id, "ADMIN", "emergency");
    const screen = await store.createScreen(organization.id, {
      name: "Emergency rollback screen",
      location: "Lobby",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const existing = await prisma.emergencyOverride.create({
      data: {
        organizationId: organization.id,
        title: "Existing emergency",
        message: "Must remain uncleared",
        targetScreenIds: [screen.id],
        expiresAt: new Date(Date.now() + 60_000),
        createdById: actor.id,
      },
    });
    const audit = {
      actorUserId: actor.id,
      ipAddress: "127.0.0.1",
      requestId: "emergency-audit-rollback",
    };

    await prisma.$executeRawUnsafe(
      'ALTER TABLE "AuditEvent" ADD CONSTRAINT "integration_reject_emergency_audits" CHECK ("action" NOT IN (\'emergency.activated\', \'emergency.cleared\'))',
    );
    try {
      await expect(
        store.activateEmergencyAndAudit(
          organization.id,
          {
            title: "Rolled-back emergency",
            message: "Must not persist",
            backgroundColor: "#C1121F",
            targetScreenIds: [screen.id],
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          audit,
        ),
      ).rejects.toThrow();
      await expect(
        store.clearEmergencyAndAudit(organization.id, existing.id, audit),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" DROP CONSTRAINT "integration_reject_emergency_audits"',
      );
    }

    expect(
      await prisma.emergencyOverride.count({
        where: {
          organizationId: organization.id,
          title: "Rolled-back emergency",
        },
      }),
    ).toBe(0);
    await expect(
      prisma.emergencyOverride.findUniqueOrThrow({
        where: { id: existing.id },
      }),
    ).resolves.toMatchObject({ clearedAt: null });
    expect(
      await prisma.auditEvent.count({
        where: { organizationId: organization.id },
      }),
    ).toBe(0);
  });

  it("revalidates emergency actors and every target inside the transaction", async () => {
    const [organization, otherOrganization] = await Promise.all([
      createOrganization("emergency-revalidation"),
      createOrganization("emergency-revalidation-other"),
    ]);
    const [viewer, admin] = await Promise.all([
      createMember(organization.id, "VIEWER", "emergency-viewer"),
      createMember(organization.id, "ADMIN", "emergency-admin"),
    ]);
    const [local, foreign] = await Promise.all([
      store.createScreen(organization.id, {
        name: "Local emergency screen",
        location: "Lobby",
        orientation: "landscape",
        resolution: "1920x1080",
        tags: [],
      }),
      store.createScreen(otherOrganization.id, {
        name: "Foreign emergency screen",
        location: "Lobby",
        orientation: "landscape",
        resolution: "1920x1080",
        tags: [],
      }),
    ]);
    const input = {
      title: "Denied emergency",
      message: "Must fail closed",
      backgroundColor: "#C1121F",
      targetScreenIds: [local.id],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };

    await expect(
      store.activateEmergencyAndAudit(organization.id, input, {
        actorUserId: viewer.id,
      }),
    ).resolves.toEqual({ activated: false, reason: "FORBIDDEN" });
    await expect(
      store.activateEmergencyAndAudit(
        organization.id,
        { ...input, targetScreenIds: [local.id, foreign.id] },
        { actorUserId: admin.id },
      ),
    ).resolves.toEqual({ activated: false, reason: "INVALID_SCREEN" });
    expect(
      await prisma.emergencyOverride.count({
        where: { organizationId: organization.id },
      }),
    ).toBe(0);
    expect(
      await prisma.auditEvent.count({
        where: { organizationId: organization.id },
      }),
    ).toBe(0);
  });

  it("revalidates ordinary mutation actors and playlist assets inside the transaction", async () => {
    const [organization, otherOrganization] = await Promise.all([
      createOrganization("ordinary-revalidation"),
      createOrganization("ordinary-revalidation-other"),
    ]);
    const [viewer, publisher, disabledAdmin, otherAdmin] = await Promise.all([
      createMember(organization.id, "VIEWER", "viewer"),
      createMember(organization.id, "PUBLISHER", "publisher"),
      createMember(organization.id, "ADMIN", "disabled-admin", true),
      createMember(otherOrganization.id, "ADMIN", "other-admin"),
    ]);
    const screenInput = {
      name: "Denied screen",
      location: "Lobby",
      orientation: "landscape" as const,
      resolution: "1920x1080",
      tags: [],
    };
    const mediaInput = {
      name: "Denied media",
      kind: "image" as const,
      mimeType: "image/png",
      url: "https://media.example.test/denied.png",
      checksumSha256: "a".repeat(64),
      sizeBytes: 100,
    };

    await expect(
      store.createScreenAndAudit(organization.id, screenInput, {
        actorUserId: publisher.id,
      }),
    ).resolves.toEqual({ created: false, reason: "FORBIDDEN" });
    await expect(
      store.createMediaAndAudit(organization.id, mediaInput, {
        actorUserId: viewer.id,
      }),
    ).resolves.toEqual({ created: false, reason: "FORBIDDEN" });
    await expect(
      store.createPlaylistAndAudit(
        organization.id,
        { name: "Denied playlist", description: "", items: [] },
        { actorUserId: disabledAdmin.id },
      ),
    ).resolves.toEqual({ created: false, reason: "FORBIDDEN" });
    await expect(
      store.createMediaAndAudit(organization.id, mediaInput, {
        actorUserId: otherAdmin.id,
      }),
    ).resolves.toEqual({ created: false, reason: "FORBIDDEN" });
    await expect(
      store.createPlaylistAndAudit(
        organization.id,
        {
          name: "Invalid asset playlist",
          description: "",
          items: [
            {
              id: "ignored",
              assetId: randomUUID(),
              position: 0,
              durationSeconds: 10,
            },
          ],
        },
        { actorUserId: publisher.id },
      ),
    ).resolves.toEqual({ created: false, reason: "INVALID_ASSET" });

    expect(await prisma.screen.count()).toBe(0);
    expect(await prisma.mediaAsset.count()).toBe(0);
    expect(await prisma.playlist.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("writes the established ordinary mutation audit actions and metadata", async () => {
    const organization = await createOrganization("ordinary-audit-shape");
    const actor = await createMember(organization.id, "ADMIN", "audit-shape");
    const audit = (requestId: string) => ({
      actorUserId: actor.id,
      ipAddress: "127.0.0.1",
      requestId,
    });

    const createdScreen = await store.createScreenAndAudit(
      organization.id,
      {
        name: "Audited screen",
        location: "Lobby",
        orientation: "landscape",
        resolution: "1920x1080",
        tags: [],
      },
      audit("screen-create"),
    );
    if (!createdScreen.created) throw new Error("screen was not created");
    await expect(
      store.updateScreenAndAudit(
        organization.id,
        createdScreen.value.id,
        { location: "Library" },
        audit("screen-update"),
      ),
    ).resolves.toMatchObject({ updated: true });

    const createdMedia = await store.createMediaAndAudit(
      organization.id,
      {
        name: "Audited media",
        kind: "image",
        mimeType: "image/png",
        url: "https://media.example.test/audited.png",
        checksumSha256: "b".repeat(64),
        sizeBytes: 100,
      },
      audit("media-create"),
    );
    if (!createdMedia.created) throw new Error("media was not created");
    const createdPlaylist = await store.createPlaylistAndAudit(
      organization.id,
      {
        name: "Audited playlist",
        description: "Audit fixture",
        items: [
          {
            id: "ignored-one",
            assetId: createdMedia.value.id,
            position: 0,
            durationSeconds: 10,
          },
          {
            id: "ignored-two",
            assetId: createdMedia.value.id,
            position: 1,
            durationSeconds: 20,
          },
        ],
      },
      audit("playlist-create"),
    );
    if (!createdPlaylist.created) throw new Error("playlist was not created");

    await expect(
      store.deleteMediaAndAudit(
        organization.id,
        createdMedia.value.id,
        audit("media-delete-in-use"),
      ),
    ).resolves.toEqual({ deleted: false, reason: "IN_USE" });
    await expect(
      store.deletePlaylistAndAudit(
        organization.id,
        createdPlaylist.value.id,
        audit("playlist-delete"),
      ),
    ).resolves.toEqual({ deleted: true });
    await expect(
      store.deleteMediaAndAudit(
        organization.id,
        createdMedia.value.id,
        audit("media-delete"),
      ),
    ).resolves.toEqual({ deleted: true });

    await expect(
      prisma.auditEvent.findMany({
        where: { organizationId: organization.id },
        orderBy: { requestId: "asc" },
        select: {
          actorUserId: true,
          actorType: true,
          action: true,
          entityType: true,
          entityId: true,
          ipAddress: true,
          requestId: true,
          metadata: true,
        },
      }),
    ).resolves.toEqual([
      {
        actorUserId: actor.id,
        actorType: "user",
        action: "media.created",
        entityType: "media",
        entityId: createdMedia.value.id,
        ipAddress: "127.0.0.1",
        requestId: "media-create",
        metadata: { name: "Audited media" },
      },
      {
        actorUserId: actor.id,
        actorType: "user",
        action: "media.deleted",
        entityType: "media",
        entityId: createdMedia.value.id,
        ipAddress: "127.0.0.1",
        requestId: "media-delete",
        metadata: {},
      },
      {
        actorUserId: actor.id,
        actorType: "user",
        action: "playlist.created",
        entityType: "playlist",
        entityId: createdPlaylist.value.id,
        ipAddress: "127.0.0.1",
        requestId: "playlist-create",
        metadata: { itemCount: 2 },
      },
      {
        actorUserId: actor.id,
        actorType: "user",
        action: "playlist.deleted",
        entityType: "playlist",
        entityId: createdPlaylist.value.id,
        ipAddress: "127.0.0.1",
        requestId: "playlist-delete",
        metadata: {},
      },
      {
        actorUserId: actor.id,
        actorType: "user",
        action: "screen.created",
        entityType: "screen",
        entityId: createdScreen.value.id,
        ipAddress: "127.0.0.1",
        requestId: "screen-create",
        metadata: { name: "Audited screen" },
      },
      {
        actorUserId: actor.id,
        actorType: "user",
        action: "screen.updated",
        entityType: "screen",
        entityId: createdScreen.value.id,
        ipAddress: "127.0.0.1",
        requestId: "screen-update",
        metadata: {},
      },
    ]);
  });

  it("enforces composite tenant ownership for nested relations and preserves safe delete semantics", async () => {
    const [alpha, beta] = await Promise.all([
      createOrganization("constraints-alpha"),
      createOrganization("constraints-beta"),
    ]);
    const [alphaMedia, betaMedia] = await Promise.all([
      prisma.mediaAsset.create({
        data: {
          organizationId: alpha.id,
          name: "Alpha asset",
          kind: "IMAGE",
          mimeType: "image/png",
          url: "https://media.example.test/constraint-alpha.png",
          checksumSha256: "d".repeat(64),
          sizeBytes: 100n,
        },
      }),
      prisma.mediaAsset.create({
        data: {
          organizationId: beta.id,
          name: "Beta asset",
          kind: "IMAGE",
          mimeType: "image/png",
          url: "https://media.example.test/constraint-beta.png",
          checksumSha256: "e".repeat(64),
          sizeBytes: 200n,
        },
      }),
    ]);
    const [alphaPlaylist, betaPlaylist] = await Promise.all([
      prisma.playlist.create({
        data: { organizationId: alpha.id, name: "Constraint alpha" },
      }),
      prisma.playlist.create({
        data: { organizationId: beta.id, name: "Constraint beta" },
      }),
    ]);
    const [alphaScreen, betaScreen] = await Promise.all([
      prisma.screen.create({
        data: { organizationId: alpha.id, name: "Constraint alpha screen" },
      }),
      prisma.screen.create({
        data: { organizationId: beta.id, name: "Constraint beta screen" },
      }),
    ]);

    const alphaItem = await prisma.playlistItem.create({
      data: {
        organizationId: alpha.id,
        playlistId: alphaPlaylist.id,
        assetId: alphaMedia.id,
        position: 0,
        durationSeconds: 10,
      },
    });
    const alphaSchedule = await prisma.schedule.create({
      data: {
        organizationId: alpha.id,
        playlistId: alphaPlaylist.id,
        name: "Constraint schedule",
        startsAt: new Date(),
      },
    });
    await prisma.scheduleTarget.create({
      data: {
        organizationId: alpha.id,
        scheduleId: alphaSchedule.id,
        screenId: alphaScreen.id,
      },
    });
    const pairing = await prisma.pairingCode.create({
      data: {
        organizationId: alpha.id,
        codeHash: `constraint-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
        screenId: alphaScreen.id,
        screenOrganizationId: alpha.id,
      },
    });

    await expect(
      prisma.playlistItem.create({
        data: {
          organizationId: alpha.id,
          playlistId: alphaPlaylist.id,
          assetId: betaMedia.id,
          position: 1,
          durationSeconds: 10,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      prisma.schedule.create({
        data: {
          organizationId: alpha.id,
          playlistId: betaPlaylist.id,
          name: "Cross-tenant playlist",
          startsAt: new Date(),
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      prisma.scheduleTarget.create({
        data: {
          organizationId: alpha.id,
          scheduleId: alphaSchedule.id,
          screenId: betaScreen.id,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      prisma.pairingCode.update({
        where: { id: pairing.id },
        data: {
          screenId: betaScreen.id,
          screenOrganizationId: alpha.id,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    const checkConstraintError = await prisma.pairingCode
      .update({
        where: { id: pairing.id },
        data: {
          screenId: betaScreen.id,
          screenOrganizationId: beta.id,
        },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(checkConstraintError).toBeInstanceOf(Error);
    expect(checkConstraintError).toHaveProperty(
      "name",
      "PrismaClientUnknownRequestError",
    );
    expect((checkConstraintError as Error).message).toContain('code: "23514"');
    expect((checkConstraintError as Error).message).toContain(
      "PairingCode_screen_organization_check",
    );

    await prisma.screen.delete({ where: { id: alphaScreen.id } });
    await expect(
      prisma.pairingCode.findUniqueOrThrow({ where: { id: pairing.id } }),
    ).resolves.toMatchObject({
      screenId: null,
      screenOrganizationId: null,
    });
    expect(
      await prisma.scheduleTarget.count({
        where: { scheduleId: alphaSchedule.id },
      }),
    ).toBe(0);

    await prisma.playlist.delete({ where: { id: alphaPlaylist.id } });
    expect(
      await prisma.playlistItem.count({ where: { id: alphaItem.id } }),
    ).toBe(0);
    expect(
      await prisma.schedule.count({ where: { id: alphaSchedule.id } }),
    ).toBe(0);
    await expect(
      prisma.mediaAsset.delete({ where: { id: alphaMedia.id } }),
    ).resolves.toMatchObject({ id: alphaMedia.id });
  });

  it("rolls back pairing creation when its required audit cannot be written", async () => {
    const organization = await createOrganization("pairing-create-rollback");
    const actor = await createMember(
      organization.id,
      "OWNER",
      "pairing-create-rollback-owner",
    );
    const codeHash = `failed-audit-${randomUUID()}`;

    await prisma.$executeRawUnsafe(
      `ALTER TABLE "AuditEvent" ADD CONSTRAINT "integration_reject_pairing_create_audit" CHECK ("action" <> 'pairing.created')`,
    );
    try {
      await expect(
        store.tryCreatePairingAndAudit(
          organization.id,
          codeHash,
          new Date(Date.now() + 60_000).toISOString(),
          { actorUserId: actor.id },
        ),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" DROP CONSTRAINT "integration_reject_pairing_create_audit"',
      );
    }
    expect(await prisma.pairingCode.count({ where: { codeHash } })).toBe(0);
    expect(
      await prisma.auditEvent.count({
        where: { organizationId: organization.id, action: "pairing.created" },
      }),
    ).toBe(0);
  });

  it("revalidates current pairing-code authority inside the transaction", async () => {
    const [organization, otherOrganization] = await Promise.all([
      createOrganization("pairing-create-authorization"),
      createOrganization("pairing-create-authorization-other"),
    ]);
    const [viewer, disabledAdmin, otherAdmin] = await Promise.all([
      createMember(organization.id, "VIEWER", "pairing-create-viewer"),
      createMember(
        organization.id,
        "ADMIN",
        "pairing-create-disabled-admin",
        true,
      ),
      createMember(otherOrganization.id, "ADMIN", "pairing-create-other-admin"),
    ]);

    for (const actorUserId of [viewer.id, disabledAdmin.id, otherAdmin.id]) {
      const codeHash = `forbidden-pairing-${randomUUID()}`;
      await expect(
        store.tryCreatePairingAndAudit(
          organization.id,
          codeHash,
          new Date(Date.now() + 60_000).toISOString(),
          { actorUserId },
        ),
      ).resolves.toEqual({ created: false, reason: "FORBIDDEN" });
      expect(await prisma.pairingCode.count({ where: { codeHash } })).toBe(0);
    }
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("claims a pairing code and records its audit exactly once under concurrent requests", async () => {
    const organization = await createOrganization("pairing-race");
    const pairing = await store.createPairing(
      organization.id,
      `code-${randomUUID()}`,
      new Date(Date.now() + 60_000).toISOString(),
    );
    const device = {
      installationId: `installation-${randomUUID()}`,
      model: "CI player",
      osVersion: "test",
      playerVersion: "0.1.0",
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.claimPairingAndAudit(pairing.codeHash, device, `token-${index}`, {
          ipAddress: "127.0.0.1",
          requestId: `pairing-race-${index}`,
        }),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      await prisma.screen.count({ where: { organizationId: organization.id } }),
    ).toBe(1);
    await expect(
      prisma.pairingCode.findUniqueOrThrow({ where: { id: pairing.id } }),
    ).resolves.toMatchObject({ status: "CLAIMED" });
    await expect(
      prisma.auditEvent.findMany({
        where: {
          organizationId: organization.id,
          action: "device.paired",
        },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        actorType: "device",
        entityType: "screen",
        entityId: results.find(Boolean)?.id,
        ipAddress: "127.0.0.1",
        metadata: { installationId: device.installationId },
      }),
    ]);
  });

  it("rolls back the pairing claim and screen when its required audit cannot be written", async () => {
    const organization = await createOrganization("pairing-audit-rollback");
    const installationId = `installation-${randomUUID()}`;
    const pairing = await store.createPairing(
      organization.id,
      `code-${randomUUID()}`,
      new Date(Date.now() + 60_000).toISOString(),
    );

    // Install a test-only database constraint so the final audit insert fails
    // after the claim and screen statements have executed. The suite is
    // single-worker and owns this isolated database.
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "AuditEvent" ADD CONSTRAINT "integration_reject_device_paired" CHECK ("action" <> \'device.paired\')',
    );
    try {
      await expect(
        store.claimPairingAndAudit(
          pairing.codeHash,
          {
            installationId,
            model: "Rollback player",
            osVersion: "test",
            playerVersion: "0.1.0",
          },
          "rollback-token",
          { requestId: "pairing-audit-rollback" },
        ),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" DROP CONSTRAINT "integration_reject_device_paired"',
      );
    }
    await expect(
      prisma.pairingCode.findUniqueOrThrow({ where: { id: pairing.id } }),
    ).resolves.toMatchObject({ status: "PENDING", claimedAt: null });
    expect(await prisma.screen.count({ where: { installationId } })).toBe(0);
    expect(
      await prisma.auditEvent.count({
        where: {
          organizationId: organization.id,
          action: "device.paired",
        },
      }),
    ).toBe(0);
  });

  it("atomically enrolls one proof credential and recovers identical pairing responses", async () => {
    const organization = await createOrganization("proof-pair-race");
    const pairing = await store.createPairing(
      organization.id,
      `proof-code-${randomUUID()}`,
      new Date(Date.now() + 60_000).toISOString(),
    );
    const enrollment = proofEnrollment(11);
    const challengeHashSha256 = proofHash();
    const transcriptDigestSha256 = proofHash();
    const attempt = await store.issuePairingChallenge({
      codeHash: pairing.codeHash,
      credential: enrollment,
      challengeHashSha256,
      transcriptDigestSha256,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    if (!attempt) throw new Error("pairing challenge was not issued");
    const input = {
      codeHash: pairing.codeHash,
      pairingAttemptId: attempt.id,
      challengeHashSha256,
      transcriptDigestSha256,
      keyId: enrollment.keyId,
      device: {
        installationId: `proof-installation-${randomUUID()}`,
        model: "Proof race player",
        osVersion: "test",
        playerVersion: "0.1.0",
      },
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.claimPairingWithCredentialAndAudit(input, () => true, {
          requestId: `proof-pair-race-${index}`,
        }),
      ),
    );
    expect(results.every((result) => result.paired)).toBe(true);
    const paired = results[0]!;
    if (!paired.paired) throw new Error("proof enrollment failed");
    expect(
      results.map((result) =>
        result.paired ? [result.screen.id, result.credential.id] : null,
      ),
    ).toEqual(
      Array.from({ length: 8 }, () => [paired.screen.id, paired.credential.id]),
    );
    expect(await prisma.screen.count()).toBe(1);
    expect(await prisma.deviceCredential.count()).toBe(1);
    expect(await prisma.auditEvent.count()).toBe(1);
    await expect(
      store.claimPairingWithCredentialAndAudit(
        { ...input, transcriptDigestSha256: proofHash() },
        () => true,
        {},
      ),
    ).resolves.toEqual({ paired: false, reason: "INVALID" });
    expect(await prisma.auditEvent.count()).toBe(1);
  });

  it("rolls back proof enrollment when its required audit fails", async () => {
    const organization = await createOrganization("proof-pair-rollback");
    const pairing = await store.createPairing(
      organization.id,
      `proof-code-${randomUUID()}`,
      new Date(Date.now() + 60_000).toISOString(),
    );
    const enrollment = proofEnrollment(12);
    const challengeHashSha256 = proofHash();
    const transcriptDigestSha256 = proofHash();
    const attempt = await store.issuePairingChallenge({
      codeHash: pairing.codeHash,
      credential: enrollment,
      challengeHashSha256,
      transcriptDigestSha256,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    if (!attempt) throw new Error("pairing challenge was not issued");
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "AuditEvent" ADD CONSTRAINT "integration_reject_proof_paired" CHECK ("action" <> \'device.paired\')',
    );
    try {
      await expect(
        store.claimPairingWithCredentialAndAudit(
          {
            codeHash: pairing.codeHash,
            pairingAttemptId: attempt.id,
            challengeHashSha256,
            transcriptDigestSha256,
            keyId: enrollment.keyId,
            device: {
              installationId: `proof-rollback-${randomUUID()}`,
              model: "Proof rollback player",
              osVersion: "test",
              playerVersion: "0.1.0",
            },
          },
          () => true,
          {},
        ),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" DROP CONSTRAINT "integration_reject_proof_paired"',
      );
    }
    await expect(
      prisma.pairingCode.findUniqueOrThrow({ where: { id: pairing.id } }),
    ).resolves.toMatchObject({ status: "PENDING", screenId: null });
    await expect(
      prisma.pairingAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
    ).resolves.toMatchObject({ consumedAt: null, boundCredentialId: null });
    expect(await prisma.screen.count()).toBe(0);
    expect(await prisma.deviceCredential.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("consumes a bound proof once with heartbeat and serializes credential revocation", async () => {
    const paired = await pairProofDevice("proof-consume", 13);
    const requestDigestSha256 = proofHash();
    const challengeHashSha256 = proofHash();
    const challenge = await store.issueDeviceAuthChallenge({
      screenId: paired.screen.id,
      keyId: paired.credential.keyId,
      challengeHashSha256,
      operation: "heartbeat",
      requestDigestSha256,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    if (!challenge) throw new Error("device challenge was not issued");
    const proof = {
      credentialId: paired.credential.id,
      challengeId: challenge.id,
      challengeHashSha256,
      operation: "heartbeat" as const,
      requestDigestSha256,
    };
    await expect(
      store.consumeDeviceAuthChallenge(
        { ...proof, requestDigestSha256: proofHash() },
        () => true,
      ),
    ).resolves.toEqual({ authenticated: false, reason: "INVALID_PROOF" });
    await expect(
      store.consumeDeviceAuthChallenge(proof, () => false),
    ).resolves.toEqual({ authenticated: false, reason: "INVALID_PROOF" });
    await expect(
      prisma.deviceAuthChallenge.findUniqueOrThrow({
        where: { id: challenge.id },
      }),
    ).resolves.toMatchObject({ consumedAt: null });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.heartbeatWithDeviceProof(
          proof,
          {
            playerVersion: `proof-${index}`,
            manifestVersion: null,
            nowPlayingAssetId: null,
            uptimeSeconds: index,
            freeStorageBytes: 1_000_000,
            networkType: "integration",
          },
          () => true,
        ),
      ),
    );
    expect(results.filter((result) => result.authenticated)).toHaveLength(1);
    expect(
      await prisma.deviceAuthChallenge.count({
        where: { id: challenge.id, consumedAt: { not: null } },
      }),
    ).toBe(1);

    const revokeChallengeHash = proofHash();
    const revokeDigest = proofHash();
    const revokeChallenge = await store.issueDeviceAuthChallenge({
      screenId: paired.screen.id,
      keyId: paired.credential.keyId,
      challengeHashSha256: revokeChallengeHash,
      operation: "heartbeat",
      requestDigestSha256: revokeDigest,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    if (!revokeChallenge) throw new Error("revoke-race challenge missing");
    const actor = await createUser("proof-revoke-owner@example.test");
    await prisma.membership.create({
      data: {
        organizationId: paired.organization.id,
        userId: actor.id,
        role: "OWNER",
      },
    });
    const [heartbeatResult, revokeResult] = await Promise.all([
      store.heartbeatWithDeviceProof(
        {
          credentialId: paired.credential.id,
          challengeId: revokeChallenge.id,
          challengeHashSha256: revokeChallengeHash,
          operation: "heartbeat",
          requestDigestSha256: revokeDigest,
        },
        {
          playerVersion: "revoke-race",
          manifestVersion: null,
          nowPlayingAssetId: null,
          uptimeSeconds: 1,
          freeStorageBytes: 1_000_000,
          networkType: "integration",
        },
        () => true,
      ),
      store.revokeDeviceCredentialAndAudit(
        paired.organization.id,
        paired.screen.id,
        { actorUserId: actor.id },
      ),
    ]);
    expect(revokeResult).toMatchObject({ revoked: true });
    expect([true, false]).toContain(heartbeatResult.authenticated);
    await expect(
      store.authenticateDeviceCredential(
        paired.screen.id,
        paired.credential.keyId,
      ),
    ).resolves.toEqual({ authenticated: false, reason: "INVALID_PROOF" });
    await expect(
      store.revokeDeviceCredentialAndAudit(
        paired.organization.id,
        paired.screen.id,
        { actorUserId: actor.id },
      ),
    ).resolves.toEqual({ revoked: false, reason: "ALREADY_REVOKED" });
    expect(
      await prisma.auditEvent.count({
        where: { action: "device.credential.revoked" },
      }),
    ).toBe(1);
    await expect(
      prisma.screen.findUniqueOrThrow({ where: { id: paired.screen.id } }),
    ).resolves.toMatchObject({ credentialRevokedAt: expect.any(Date) });
  });

  it("persists proof heartbeats as authoritative playback snapshots", async () => {
    const paired = await pairProofDevice("proof-heartbeat-snapshot", 31);
    const sendHeartbeat = async (data: {
      playerVersion: string;
      manifestVersion: string | null;
      nowPlayingAssetId: string | null;
      uptimeSeconds: number;
      freeStorageBytes: number;
      networkType: string;
    }) => {
      const requestDigestSha256 = proofHash();
      const challengeHashSha256 = proofHash();
      const challenge = await store.issueDeviceAuthChallenge({
        screenId: paired.screen.id,
        keyId: paired.credential.keyId,
        challengeHashSha256,
        operation: "heartbeat",
        requestDigestSha256,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      });
      if (!challenge) throw new Error("device challenge was not issued");
      const result = await store.heartbeatWithDeviceProof(
        {
          credentialId: paired.credential.id,
          challengeId: challenge.id,
          challengeHashSha256,
          operation: "heartbeat",
          requestDigestSha256,
        },
        data,
        () => true,
      );
      return { challengeId: challenge.id, result };
    };

    const initial = await sendHeartbeat({
      playerVersion: "snapshot-1",
      manifestVersion: "release-7",
      nowPlayingAssetId: "asset-7",
      uptimeSeconds: 120,
      freeStorageBytes: 1_000_000,
      networkType: "wifi",
    });
    expect(initial.result).toMatchObject({
      authenticated: true,
      screen: {
        manifestVersion: "release-7",
        nowPlayingAssetId: "asset-7",
      },
    });

    const cleared = await sendHeartbeat({
      playerVersion: "snapshot-2",
      manifestVersion: null,
      nowPlayingAssetId: null,
      uptimeSeconds: 180,
      freeStorageBytes: 900_000,
      networkType: "ethernet",
    });
    expect(cleared.result).toMatchObject({
      authenticated: true,
      screen: {
        playerVersion: "snapshot-2",
        uptimeSeconds: 180,
        freeStorageBytes: 900_000,
        networkType: "ethernet",
      },
    });
    if (!cleared.result.authenticated)
      throw new Error("heartbeat was not authenticated");
    expect(cleared.result.screen).not.toHaveProperty("manifestVersion");
    expect(cleared.result.screen).not.toHaveProperty("nowPlayingAssetId");

    await expect(
      prisma.screen.findUniqueOrThrow({ where: { id: paired.screen.id } }),
    ).resolves.toMatchObject({
      playerVersion: "snapshot-2",
      manifestVersion: null,
      nowPlayingAssetId: null,
      uptimeSeconds: 180n,
      freeStorageBytes: 900_000n,
      networkType: "ethernet",
    });
    expect(
      await prisma.deviceAuthChallenge.count({
        where: {
          id: { in: [initial.challengeId, cleared.challengeId] },
          consumedAt: { not: null },
        },
      }),
    ).toBe(2);
  });

  it("enforces one live credential per screen at the database boundary", async () => {
    const paired = await pairProofDevice("proof-live-unique", 14);
    const duplicate = proofEnrollment(15);

    await expect(
      prisma.deviceCredential.create({
        data: {
          organizationId: paired.organization.id,
          screenId: paired.screen.id,
          liveScreenId: paired.screen.id,
          liveScreenOrganizationId: paired.organization.id,
          keyId: duplicate.keyId,
          publicKeySpki: Buffer.from(duplicate.publicKeySpki, "base64url"),
          algorithm: duplicate.algorithm,
          securityLevel: duplicate.securityLevel,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("contains a screen while replacing and reasserting targeted re-enrollment grants", async () => {
    const paired = await pairProofDevice("proof-reenrollment", 18);
    const actor = await createUser("proof-reenrollment-owner@example.test");
    await prisma.membership.create({
      data: {
        organizationId: paired.organization.id,
        userId: actor.id,
        role: "OWNER",
      },
    });
    const expiredChallengeId = Buffer.alloc(32, 23).toString("base64url");
    await prisma.deviceAuthChallenge.create({
      data: {
        id: expiredChallengeId,
        organizationId: paired.organization.id,
        credentialId: paired.credential.id,
        challengeHashSha256: proofHash(),
        operation: "MANIFEST",
        requestDigestSha256: proofHash(),
        createdAt: new Date(Date.now() - 90_000),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    const first = await store.requestScreenReenrollmentAndAudit(
      paired.organization.id,
      paired.screen.id,
      `reenroll-${randomUUID()}`,
      new Date(Date.now() + 60_000).toISOString(),
      "Replace failed player hardware",
      { actorUserId: actor.id },
    );
    expect(first).toMatchObject({ created: true });
    expect(
      await prisma.deviceAuthChallenge.findUniqueOrThrow({
        where: { id: expiredChallengeId },
      }),
    ).toMatchObject({ consumedAt: null });
    expect(
      await prisma.deviceCredential.findUniqueOrThrow({
        where: { id: paired.credential.id },
      }),
    ).toMatchObject({
      revokedAt: expect.any(Date),
      liveScreenId: null,
      liveScreenOrganizationId: null,
    });
    const second = await store.requestScreenReenrollmentAndAudit(
      paired.organization.id,
      paired.screen.id,
      `reenroll-${randomUUID()}`,
      new Date(Date.now() + 60_000).toISOString(),
      "Retry because the response was lost",
      { actorUserId: actor.id },
    );
    expect(second).toMatchObject({ created: true });
    if (!first.created || !second.created)
      throw new Error("re-enrollment grant creation failed");
    expect(
      await prisma.pairingCode.findUniqueOrThrow({
        where: { id: first.pairing.id },
      }),
    ).toMatchObject({ status: "REVOKED" });
    await expect(
      store.revokeDeviceCredentialAndAudit(
        paired.organization.id,
        paired.screen.id,
        { actorUserId: actor.id },
      ),
    ).resolves.toMatchObject({ revoked: true });
    expect(
      await prisma.pairingCode.findUniqueOrThrow({
        where: { id: second.pairing.id },
      }),
    ).toMatchObject({ status: "REVOKED" });
    expect(
      await prisma.screen.findUniqueOrThrow({
        where: { id: paired.screen.id },
      }),
    ).toMatchObject({
      credentialGeneration: 3,
      credentialRevokedAt: expect.any(Date),
    });
    expect(
      await prisma.auditEvent.count({
        where: { action: "device.credential.revocation_reasserted" },
      }),
    ).toBe(1);
  });

  it("activates a proved replacement after its short proof attempt has expired", async () => {
    const staged = await stageReenrollmentCandidate(
      "proof-reenrollment-delayed",
      19,
      20,
    );
    await prisma.$executeRaw`
      UPDATE "PairingAttempt"
      SET "createdAt" = CURRENT_TIMESTAMP - INTERVAL '30 seconds',
          "provedAt" = CURRENT_TIMESTAMP - INTERVAL '2 seconds',
          "expiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
      WHERE "id" = ${staged.candidate.candidateId}`;

    const activated = await store.activateReenrollmentCandidateAndAudit(
      staged.paired.organization.id,
      staged.paired.screen.id,
      staged.grant.id,
      staged.candidate.candidateId,
      { actorUserId: staged.actor.id },
    );

    expect(activated).toMatchObject({
      activated: true,
      screen: { id: staged.paired.screen.id },
      credential: { keyId: staged.credential.keyId },
    });
    expect(await prisma.screen.count()).toBe(1);
    expect(
      await prisma.deviceCredential.count({
        where: {
          liveScreenId: staged.paired.screen.id,
          revokedAt: null,
        },
      }),
    ).toBe(1);
  });

  it("serializes cancellation against replacement activation", async () => {
    const staged = await stageReenrollmentCandidate(
      "proof-reenrollment-cancel-race",
      21,
      22,
    );
    const [activation, cancellation] = await Promise.all([
      store.activateReenrollmentCandidateAndAudit(
        staged.paired.organization.id,
        staged.paired.screen.id,
        staged.grant.id,
        staged.candidate.candidateId,
        { actorUserId: staged.actor.id },
      ),
      store.cancelScreenReenrollmentAndAudit(
        staged.paired.organization.id,
        staged.paired.screen.id,
        staged.grant.id,
        { actorUserId: staged.actor.id },
      ),
    ]);
    expect(Number(activation.activated) + Number(cancellation.cancelled)).toBe(
      1,
    );
    const grant = await prisma.pairingCode.findUniqueOrThrow({
      where: { id: staged.grant.id },
    });
    const liveReplacementCount = await prisma.deviceCredential.count({
      where: {
        keyId: staged.credential.keyId,
        liveScreenId: staged.paired.screen.id,
        revokedAt: null,
      },
    });
    expect(grant.status).toBe(activation.activated ? "CLAIMED" : "REVOKED");
    expect(liveReplacementCount).toBe(activation.activated ? 1 : 0);
    expect(
      await prisma.auditEvent.count({
        where: {
          action: {
            in: [
              "device.reenrollment.activated",
              "device.reenrollment.cancelled",
            ],
          },
        },
      }),
    ).toBe(1);
  });

  it("can delete a tenant containing consumed proof history", async () => {
    const paired = await pairProofDevice("proof-tenant-delete", 16);

    await expect(
      prisma.organization.delete({ where: { id: paired.organization.id } }),
    ).resolves.toMatchObject({ id: paired.organization.id });
    expect(await prisma.pairingAttempt.count()).toBe(0);
    expect(await prisma.deviceCredential.count()).toBe(0);
    expect(
      await prisma.deviceKeyTombstone.findUnique({
        where: { keyId: paired.credential.keyId },
      }),
    ).not.toBeNull();
    const replacementOrg = await createOrganization("proof-key-reuse-denied");
    const replacementPairing = await store.createPairing(
      replacementOrg.id,
      `proof-code-${randomUUID()}`,
      new Date(Date.now() + 60_000).toISOString(),
    );
    await expect(
      store.issuePairingChallenge({
        codeHash: replacementPairing.codeHash,
        credential: proofEnrollment(16),
        challengeHashSha256: proofHash(),
        transcriptDigestSha256: proofHash(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      }),
    ).resolves.toBeNull();
  });

  it("surfaces database uniqueness conflicts and scopes playlist names per tenant", async () => {
    const [alpha, beta] = await Promise.all([
      createOrganization("unique-alpha"),
      createOrganization("unique-beta"),
    ]);
    await store.createPlaylist(alpha.id, {
      name: "Shared name",
      description: "First",
      items: [],
    });
    await store.createPlaylist(beta.id, {
      name: "Shared name",
      description: "Other tenant",
      items: [],
    });

    await expect(
      store.createPlaylist(alpha.id, {
        name: "Shared name",
        description: "Duplicate in one tenant",
        items: [],
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    const codeHash = `unique-code-${randomUUID()}`;
    await store.createPairing(
      alpha.id,
      codeHash,
      new Date(Date.now() + 60_000).toISOString(),
    );
    await expect(
      store.tryCreatePairing(
        beta.id,
        codeHash,
        new Date(Date.now() + 60_000).toISOString(),
      ),
    ).resolves.toEqual({ created: false, reason: "CODE_COLLISION" });
  });

  it("round-trips safe bigint media and heartbeat counters through DTO conversion", async () => {
    const organization = await createOrganization("bigint");
    const sizeBytes = Number.MAX_SAFE_INTEGER;
    const media = await store.createMedia(organization.id, {
      name: "Large logical asset",
      kind: "video",
      mimeType: "video/mp4",
      url: "https://media.example.test/large.mp4",
      checksumSha256: "c".repeat(64),
      sizeBytes,
    });
    const screen = await store.createScreen(organization.id, {
      name: "Counter player",
      location: "Lab",
      orientation: "landscape",
      resolution: "3840x2160",
      tags: [],
    });
    const heartbeat = await store.heartbeat(screen.id, {
      playerVersion: "bigint-test",
      manifestVersion: null,
      nowPlayingAssetId: null,
      uptimeSeconds: sizeBytes,
      freeStorageBytes: sizeBytes - 1,
      networkType: "integration",
    });

    expect(media.sizeBytes).toBe(sizeBytes);
    expect(heartbeat).toMatchObject({
      uptimeSeconds: sizeBytes,
      freeStorageBytes: sizeBytes - 1,
    });
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({ where: { id: media.id } }),
    ).resolves.toMatchObject({ sizeBytes: BigInt(sizeBytes) });

    await prisma.mediaAsset.update({
      where: { id: media.id },
      data: { sizeBytes: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
    });
    await expect(store.getMedia(organization.id, media.id)).rejects.toThrow(
      /safe-integer range/,
    );
  });

  it("finds email case-insensitively and resolves the requested membership for multi-organization sessions", async () => {
    const [alpha, beta] = await Promise.all([
      prisma.organization.create({
        data: {
          id: "integration-org-a",
          name: "Integration membership alpha",
          slug: `integration-membership-alpha-${randomUUID()}`,
        },
      }),
      prisma.organization.create({
        data: {
          id: "integration-org-b",
          name: "Integration membership beta",
          slug: `integration-membership-beta-${randomUUID()}`,
        },
      }),
    ]);
    const user = await createUser("Owner@Example.Test");
    await prisma.membership.createMany({
      data: [
        {
          organizationId: alpha.id,
          userId: user.id,
          role: "OWNER",
        },
        {
          organizationId: beta.id,
          userId: user.id,
          role: "VIEWER",
        },
      ],
    });

    const loginUser = await store.findUserByEmail("owner@example.test");
    expect(loginUser).toMatchObject({
      id: user.id,
      email: user.email,
      organizationId: alpha.id,
      role: "OWNER",
    });
    await expect(
      store.findSessionUser(user.id, alpha.id),
    ).resolves.toMatchObject({ organizationId: alpha.id, role: "OWNER" });
    await expect(
      store.findSessionUser(user.id, beta.id),
    ).resolves.toMatchObject({ organizationId: beta.id, role: "VIEWER" });
  });

  it("tracks, prunes, and independently revokes user sessions", async () => {
    const [organization, otherOrganization] = await Promise.all([
      createOrganization("user-sessions"),
      createOrganization("user-sessions-other"),
    ]);
    const actor = await createMember(organization.id, "OWNER", "sessions");
    const expiredHash = "c".repeat(64);
    await prisma.userSession.create({
      data: {
        organizationId: organization.id,
        userId: actor.id,
        tokenHash: expiredHash,
        expiresAt: new Date(Date.now() - 1_000),
      },
    });
    const createSession = (tokenHash: string) =>
      store.createUserSessionAndAudit(
        organization.id,
        {
          tokenHash,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          expectedPasswordHash: actor.passwordHash,
          expectedRole: "OWNER",
        },
        { actorUserId: actor.id, requestId: `login-${tokenHash[0]}` },
      );
    const firstHash = "a".repeat(64);
    const secondHash = "b".repeat(64);
    const first = await createSession(firstHash);
    const second = await createSession(secondHash);
    expect(first).toMatchObject({ created: true });
    expect(second).toMatchObject({ created: true });
    expect(
      await prisma.userSession.findUnique({
        where: { tokenHash: expiredHash },
      }),
    ).toBeNull();
    await expect(
      store.findActiveUserSession(actor.id, organization.id, firstHash),
    ).resolves.toMatchObject({ id: actor.id, role: "OWNER" });
    await expect(
      store.findActiveUserSession(actor.id, otherOrganization.id, firstHash),
    ).resolves.toBeNull();

    const revocations = await Promise.all([
      store.revokeUserSessionAndAudit(actor.id, organization.id, firstHash, {
        actorUserId: actor.id,
        requestId: "logout-first",
      }),
      store.revokeUserSessionAndAudit(actor.id, organization.id, firstHash, {
        actorUserId: actor.id,
        requestId: "logout-race",
      }),
    ]);
    expect(revocations.filter((result) => result.revoked)).toHaveLength(1);
    expect(
      revocations.filter(
        (result) => !result.revoked && result.reason === "NOT_FOUND",
      ),
    ).toHaveLength(1);
    await expect(
      store.findActiveUserSession(actor.id, organization.id, firstHash),
    ).resolves.toBeNull();
    await expect(
      store.findActiveUserSession(actor.id, organization.id, secondHash),
    ).resolves.toMatchObject({ id: actor.id });
    expect(
      await prisma.auditEvent.count({
        where: {
          organizationId: organization.id,
          action: "auth.logout",
        },
      }),
    ).toBe(1);
  });

  it("rolls back session creation and revocation when audit insertion fails", async () => {
    const organization = await createOrganization("session-audit-rollback");
    const actor = await createMember(
      organization.id,
      "ADMIN",
      "session-audit-rollback",
    );
    const existingHash = "d".repeat(64);
    await prisma.userSession.create({
      data: {
        organizationId: organization.id,
        userId: actor.id,
        tokenHash: existingHash,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "AuditEvent" ADD CONSTRAINT "integration_reject_session_audits" CHECK ("action" NOT IN (\'auth.login_succeeded\', \'auth.logout\'))',
    );
    const rejectedHash = "e".repeat(64);
    try {
      await expect(
        store.createUserSessionAndAudit(
          organization.id,
          {
            tokenHash: rejectedHash,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            expectedPasswordHash: actor.passwordHash,
            expectedRole: "ADMIN",
          },
          { actorUserId: actor.id },
        ),
      ).rejects.toThrow();
      await expect(
        store.revokeUserSessionAndAudit(
          actor.id,
          organization.id,
          existingHash,
          { actorUserId: actor.id },
        ),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" DROP CONSTRAINT "integration_reject_session_audits"',
      );
    }
    expect(
      await prisma.userSession.findUnique({
        where: { tokenHash: rejectedHash },
      }),
    ).toBeNull();
    await expect(
      prisma.userSession.findUniqueOrThrow({
        where: { tokenHash: existingHash },
      }),
    ).resolves.toMatchObject({ revokedAt: null });
  });

  it("rejects session issuance after credential or membership state changes", async () => {
    const organization = await createOrganization("session-revalidation");
    const actor = await createMember(
      organization.id,
      "OWNER",
      "session-revalidation",
    );
    const input = {
      tokenHash: "f".repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      expectedPasswordHash: actor.passwordHash,
      expectedRole: "OWNER" as const,
    };
    await prisma.membership.update({
      where: {
        organizationId_userId: {
          organizationId: organization.id,
          userId: actor.id,
        },
      },
      data: { role: "VIEWER" },
    });
    await expect(
      store.createUserSessionAndAudit(organization.id, input, {
        actorUserId: actor.id,
      }),
    ).resolves.toEqual({ created: false, reason: "FORBIDDEN" });

    await prisma.membership.update({
      where: {
        organizationId_userId: {
          organizationId: organization.id,
          userId: actor.id,
        },
      },
      data: { role: "OWNER" },
    });
    await prisma.user.update({
      where: { id: actor.id },
      data: { passwordHash: "changed-password-hash" },
    });
    await expect(
      store.createUserSessionAndAudit(organization.id, input, {
        actorUserId: actor.id,
      }),
    ).resolves.toEqual({ created: false, reason: "FORBIDDEN" });
    expect(
      await prisma.userSession.count({
        where: { organizationId: organization.id },
      }),
    ).toBe(0);
    expect(
      await prisma.auditEvent.count({
        where: { organizationId: organization.id },
      }),
    ).toBe(0);
  });

  it("rechecks release capabilities from locked current memberships before writes", async () => {
    const [organization, otherOrganization] = await Promise.all([
      createOrganization("release-capabilities"),
      createOrganization("release-capabilities-other"),
    ]);
    const [actor, missingActor, crossOrgActor, deletedActor, disabledActor] =
      await Promise.all([
        createUser("release-viewer@example.test"),
        createUser("release-missing@example.test"),
        createUser("release-cross-org@example.test"),
        createUser("release-deleted@example.test"),
        createUser("release-disabled@example.test"),
      ]);
    await prisma.membership.createMany({
      data: [
        {
          organizationId: organization.id,
          userId: actor.id,
          role: "VIEWER",
        },
        {
          organizationId: otherOrganization.id,
          userId: crossOrgActor.id,
          role: "PUBLISHER",
        },
        {
          organizationId: organization.id,
          userId: deletedActor.id,
          role: "PUBLISHER",
        },
        {
          organizationId: organization.id,
          userId: disabledActor.id,
          role: "PUBLISHER",
        },
      ],
    });
    await prisma.user.update({
      where: { id: disabledActor.id },
      data: { disabledAt: new Date() },
    });
    await prisma.membership.delete({
      where: {
        organizationId_userId: {
          organizationId: organization.id,
          userId: deletedActor.id,
        },
      },
    });
    const screen = await store.createScreen(organization.id, {
      name: "Capability screen",
      location: "",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const media = await store.createMedia(organization.id, {
      name: "Capability media",
      kind: "image",
      mimeType: "image/png",
      url: "https://media.example.test/capability.png",
      checksumSha256: "c".repeat(64),
      sizeBytes: 100,
    });
    const playlist = await store.createPlaylist(organization.id, {
      name: "Capability playlist",
      description: "",
      items: [
        {
          id: "ignored",
          assetId: media.id,
          position: 0,
          durationSeconds: 10,
        },
      ],
    });
    const input = {
      playlistId: playlist.id,
      name: "Capability schedule",
      priority: "normal" as const,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      timezone: "UTC",
      daysOfWeek: [],
      enabled: true,
      screenIds: [screen.id],
    };
    const policy = { mediaAllowedOrigins: ["https://media.example.test"] };

    for (const actorUserId of [
      actor.id,
      missingActor.id,
      crossOrgActor.id,
      deletedActor.id,
      disabledActor.id,
    ]) {
      await expect(
        store.publishScheduleAndAudit(
          organization.id,
          input,
          { actorUserId },
          policy,
        ),
      ).resolves.toEqual({ published: false, reason: "FORBIDDEN" });
    }
    expect(await prisma.publishedRelease.count()).toBe(0);
    expect(await prisma.schedule.count()).toBe(0);
    expect(await prisma.releaseAssignment.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);

    await prisma.membership.update({
      where: {
        organizationId_userId: {
          organizationId: organization.id,
          userId: actor.id,
        },
      },
      data: { role: "PUBLISHER" },
    });
    const publication = await store.publishScheduleAndAudit(
      organization.id,
      input,
      { actorUserId: actor.id },
      policy,
    );
    if (!publication.published) throw new Error("authorized publish failed");

    await prisma.membership.update({
      where: {
        organizationId_userId: {
          organizationId: organization.id,
          userId: actor.id,
        },
      },
      data: { role: "VIEWER" },
    });
    for (const actorUserId of [
      actor.id,
      missingActor.id,
      crossOrgActor.id,
      deletedActor.id,
      disabledActor.id,
    ]) {
      await expect(
        store.withdrawScheduleAndAudit(
          organization.id,
          publication.schedule.id,
          { actorUserId },
        ),
      ).resolves.toEqual({ withdrawn: false, reason: "FORBIDDEN" });
    }
    expect(await prisma.releaseAssignment.count()).toBe(1);
    expect(await prisma.auditEvent.count()).toBe(1);

    await prisma.membership.update({
      where: {
        organizationId_userId: {
          organizationId: organization.id,
          userId: actor.id,
        },
      },
      data: { role: "ADMIN" },
    });
    await expect(
      store.withdrawScheduleAndAudit(organization.id, publication.schedule.id, {
        actorUserId: actor.id,
      }),
    ).resolves.toMatchObject({ withdrawn: true });
    expect(await prisma.releaseAssignment.count()).toBe(2);
    expect(await prisma.auditEvent.count()).toBe(2);
  });

  it("freezes published content and schedule selection, then preserves history after withdrawal", async () => {
    const organization = await createOrganization("immutable-release");
    const actor = await createUser("release-owner@example.test");
    await prisma.membership.create({
      data: {
        organizationId: organization.id,
        userId: actor.id,
        role: "OWNER",
      },
    });
    const screen = await store.createScreen(organization.id, {
      name: "Release screen",
      location: "Lobby",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const media = await store.createMedia(organization.id, {
      name: "Frozen image",
      kind: "image",
      mimeType: "image/png",
      url: "https://media.example.test/frozen.png",
      checksumSha256: "f".repeat(64),
      sizeBytes: 4_096,
    });
    const playlist = await store.createPlaylist(organization.id, {
      name: "Frozen playlist",
      description: "Original description",
      items: [
        {
          id: "ignored-by-create",
          assetId: media.id,
          position: 0,
          durationSeconds: 30,
        },
      ],
    });
    const now = new Date();
    const publicationInput = {
      playlistId: playlist.id,
      name: "Frozen schedule",
      priority: "normal" as const,
      startsAt: new Date(now.getTime() - 60_000).toISOString(),
      timezone: "UTC",
      daysOfWeek: [],
      enabled: true,
      screenIds: [screen.id],
    };
    const publications = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        store.publishScheduleAndAudit(
          organization.id,
          publicationInput,
          {
            actorUserId: actor.id,
            requestId: `publish-integration-${index}`,
          },
          { mediaAllowedOrigins: ["https://media.example.test"] },
        ),
      ),
    );
    const publication = publications[0]!;
    expect(publication.published).toBe(true);
    if (!publication.published)
      throw new Error("publication unexpectedly failed");
    expect(
      publications.map((result) =>
        result.published
          ? [result.schedule.id, result.release.id, result.assignment.id]
          : result,
      ),
    ).toEqual(
      Array.from({ length: 4 }, () => [
        publication.schedule.id,
        publication.release.id,
        publication.assignment.id,
      ]),
    );
    expect(await prisma.schedule.count()).toBe(1);
    expect(await prisma.publishedRelease.count()).toBe(1);
    expect(await prisma.releaseAssignment.count()).toBe(1);
    expect(
      await prisma.auditEvent.count({
        where: { organizationId: organization.id, action: "release.published" },
      }),
    ).toBe(1);

    await prisma.playlist.update({
      where: { id: playlist.id },
      data: { name: "Mutated draft", description: "Changed" },
    });
    await prisma.playlistItem.updateMany({
      where: { playlistId: playlist.id },
      data: { durationSeconds: 5 },
    });
    await prisma.mediaAsset.update({
      where: { id: media.id },
      data: {
        name: "Mutated asset",
        url: "https://media.example.test/mutated.png",
        checksumSha256: "0".repeat(64),
      },
    });
    await prisma.schedule.update({
      where: { id: publication.schedule.id },
      data: { enabled: false, startsAt: new Date(now.getTime() + 86_400_000) },
    });

    const active = await store.activeOrdinaryReleases(
      organization.id,
      screen.id,
      now.toISOString(),
    );
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      release: {
        id: publication.release.id,
        playlistName: "Frozen playlist",
        playlistDescription: "Original description",
        digestSha256: publication.release.digestSha256,
        items: [
          {
            asset: {
              id: media.id,
              name: "Frozen image",
              url: "https://media.example.test/frozen.png",
              checksumSha256: "f".repeat(64),
            },
            durationSeconds: 30,
          },
        ],
      },
      assignment: {
        id: publication.assignment.id,
        state: "ASSIGNED",
        schedule: { name: "Frozen schedule", enabled: true },
      },
    });
    await expect(
      store.deletePlaylist(organization.id, playlist.id),
    ).resolves.toBe("IN_USE");
    await expect(store.deleteMedia(organization.id, media.id)).resolves.toBe(
      "IN_USE",
    );
    await expect(
      store.deletePlaylistAndAudit(organization.id, playlist.id, {
        actorUserId: actor.id,
      }),
    ).resolves.toEqual({ deleted: false, reason: "IN_USE" });
    await expect(
      store.deleteMediaAndAudit(organization.id, media.id, {
        actorUserId: actor.id,
      }),
    ).resolves.toEqual({ deleted: false, reason: "IN_USE" });

    await expect(
      prisma.screen.delete({ where: { id: screen.id } }),
    ).resolves.toMatchObject({ id: screen.id });

    const withdrawal = await store.withdrawScheduleAndAudit(
      organization.id,
      publication.schedule.id,
      { actorUserId: actor.id, requestId: "withdraw-integration" },
    );
    expect(withdrawal).toMatchObject({
      withdrawn: true,
      assignment: {
        state: "WITHDRAWN",
        previousAssignmentId: publication.assignment.id,
        releaseId: publication.release.id,
        screenIds: [screen.id],
      },
    });
    await expect(
      store.activeOrdinaryReleases(
        organization.id,
        screen.id,
        now.toISOString(),
      ),
    ).resolves.toEqual([]);
    expect(
      await prisma.publishedRelease.count({
        where: { id: publication.release.id },
      }),
    ).toBe(1);
    await expect(
      store.deletePlaylistAndAudit(organization.id, playlist.id, {
        actorUserId: actor.id,
      }),
    ).resolves.toEqual({ deleted: false, reason: "IN_USE" });
    await expect(
      store.deleteMediaAndAudit(organization.id, media.id, {
        actorUserId: actor.id,
      }),
    ).resolves.toEqual({ deleted: false, reason: "IN_USE" });
    expect(
      await prisma.auditEvent.count({
        where: {
          organizationId: organization.id,
          action: { in: ["media.deleted", "playlist.deleted"] },
        },
      }),
    ).toBe(0);
    expect(
      await prisma.releaseAssignment.count({
        where: { scheduleId: publication.schedule.id },
      }),
    ).toBe(2);

    const retainedTargets = await prisma.releaseAssignmentTarget.findMany({
      where: { assignment: { scheduleId: publication.schedule.id } },
      orderBy: { assignment: { createdAt: "asc" } },
    });
    expect(retainedTargets).toHaveLength(2);
    expect(retainedTargets).toEqual(
      retainedTargets.map(() =>
        expect.objectContaining({
          organizationId: organization.id,
          screenId: screen.id,
          liveScreenId: null,
          liveScreenOrganizationId: null,
        }),
      ),
    );
    expect(
      await prisma.auditEvent.count({
        where: {
          organizationId: organization.id,
          action: { in: ["release.published", "release.withdrawn"] },
        },
      }),
    ).toBe(2);
  });

  it("creates a new active assignment when unchanged content is republished after withdrawal", async () => {
    const organization = await createOrganization("release-reactivation");
    const actor = await createUser("release-reactivation@example.test");
    await prisma.membership.create({
      data: {
        organizationId: organization.id,
        userId: actor.id,
        role: "OWNER",
      },
    });
    const screen = await store.createScreen(organization.id, {
      name: "Reactivation screen",
      location: "",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const media = await store.createMedia(organization.id, {
      name: "Reactivation media",
      kind: "image",
      mimeType: "image/png",
      url: "https://media.example.test/reactivation.png",
      checksumSha256: "5".repeat(64),
      sizeBytes: 100,
    });
    const playlist = await store.createPlaylist(organization.id, {
      name: "Reactivation playlist",
      description: "",
      items: [
        {
          id: "ignored",
          assetId: media.id,
          position: 0,
          durationSeconds: 10,
        },
      ],
    });
    const now = new Date();
    const input = {
      playlistId: playlist.id,
      name: "Reactivation schedule",
      priority: "normal" as const,
      startsAt: new Date(now.getTime() - 60_000).toISOString(),
      timezone: "UTC",
      daysOfWeek: [],
      enabled: true,
      screenIds: [screen.id],
    };
    const first = await store.publishScheduleAndAudit(
      organization.id,
      input,
      { actorUserId: actor.id },
      { mediaAllowedOrigins: ["https://media.example.test"] },
    );
    if (!first.published) throw new Error("initial publication failed");
    await store.withdrawScheduleAndAudit(organization.id, first.schedule.id, {
      actorUserId: actor.id,
    });

    const second = await store.publishScheduleAndAudit(
      organization.id,
      input,
      { actorUserId: actor.id },
      { mediaAllowedOrigins: ["https://media.example.test"] },
    );
    expect(second.published).toBe(true);
    if (!second.published) throw new Error("republication failed");
    expect(second.release.id).toBe(first.release.id);
    expect(second.assignment.id).not.toBe(first.assignment.id);
    expect(second.schedule.id).not.toBe(first.schedule.id);
    await expect(
      store.activeOrdinaryReleases(
        organization.id,
        screen.id,
        now.toISOString(),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        release: expect.objectContaining({ id: first.release.id }),
        assignment: expect.objectContaining({
          id: second.assignment.id,
          state: "ASSIGNED",
        }),
      }),
    ]);
    expect(await prisma.schedule.count()).toBe(2);
    expect(await prisma.publishedRelease.count()).toBe(1);
    expect(await prisma.releaseAssignment.count()).toBe(3);
  });

  it("rejects cross-tenant release sources, targets, frozen assets, and actors", async () => {
    const [alpha, beta] = await Promise.all([
      createOrganization("release-alpha"),
      createOrganization("release-beta"),
    ]);
    const actor = await createUser("release-alpha@example.test");
    await prisma.membership.create({
      data: { organizationId: alpha.id, userId: actor.id, role: "OWNER" },
    });
    const [alphaScreen, betaScreen] = await Promise.all([
      store.createScreen(alpha.id, {
        name: "Alpha release screen",
        location: "",
        orientation: "landscape",
        resolution: "1920x1080",
        tags: [],
      }),
      store.createScreen(beta.id, {
        name: "Beta release screen",
        location: "",
        orientation: "landscape",
        resolution: "1920x1080",
        tags: [],
      }),
    ]);
    const [alphaMedia, betaMedia] = await Promise.all([
      store.createMedia(alpha.id, {
        name: "Alpha release asset",
        kind: "image",
        mimeType: "image/png",
        url: "https://media.example.test/release-alpha.png",
        checksumSha256: "1".repeat(64),
        sizeBytes: 100,
      }),
      store.createMedia(beta.id, {
        name: "Beta release asset",
        kind: "image",
        mimeType: "image/png",
        url: "https://media.example.test/release-beta.png",
        checksumSha256: "2".repeat(64),
        sizeBytes: 100,
      }),
    ]);
    const [alphaPlaylist, betaPlaylist] = await Promise.all([
      store.createPlaylist(alpha.id, {
        name: "Alpha release playlist",
        description: "",
        items: [
          {
            id: "ignored-alpha",
            assetId: alphaMedia.id,
            position: 0,
            durationSeconds: 10,
          },
        ],
      }),
      store.createPlaylist(beta.id, {
        name: "Beta release playlist",
        description: "",
        items: [
          {
            id: "ignored-beta",
            assetId: betaMedia.id,
            position: 0,
            durationSeconds: 10,
          },
        ],
      }),
    ]);
    const input = {
      playlistId: alphaPlaylist.id,
      name: "Tenant publication",
      priority: "normal" as const,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      timezone: "UTC",
      daysOfWeek: [],
      enabled: true,
      screenIds: [alphaScreen.id],
    };

    await expect(
      store.publishScheduleAndAudit(
        alpha.id,
        { ...input, playlistId: betaPlaylist.id },
        { actorUserId: actor.id },
        { mediaAllowedOrigins: ["https://media.example.test"] },
      ),
    ).resolves.toEqual({ published: false, reason: "PLAYLIST_NOT_FOUND" });
    await expect(
      store.publishScheduleAndAudit(
        alpha.id,
        { ...input, screenIds: [betaScreen.id] },
        { actorUserId: actor.id },
        { mediaAllowedOrigins: ["https://media.example.test"] },
      ),
    ).resolves.toEqual({ published: false, reason: "SCREEN_NOT_FOUND" });
    await expect(
      store.publishScheduleAndAudit(
        beta.id,
        {
          ...input,
          playlistId: betaPlaylist.id,
          screenIds: [betaScreen.id],
        },
        { actorUserId: actor.id },
        { mediaAllowedOrigins: ["https://media.example.test"] },
      ),
    ).resolves.toEqual({ published: false, reason: "FORBIDDEN" });
    expect(await prisma.publishedRelease.count()).toBe(0);
    expect(await prisma.releaseAssignment.count()).toBe(0);
    expect(await prisma.schedule.count()).toBe(0);

    await expect(
      prisma.publishedRelease.create({
        data: {
          organizationId: alpha.id,
          sourcePlaylistId: betaPlaylist.id,
          sourcePlaylistName: "Wrong tenant",
          sourcePlaylistDescription: "",
          sourcePlaylistUpdatedAt: new Date(),
          digestSha256: "3".repeat(64),
          createdById: actor.id,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });

    const valid = await store.publishScheduleAndAudit(
      alpha.id,
      input,
      { actorUserId: actor.id },
      { mediaAllowedOrigins: ["https://media.example.test"] },
    );
    if (!valid.published) throw new Error("valid tenant publication failed");
    const sourceItem = await prisma.playlistItem.findFirstOrThrow({
      where: { playlistId: alphaPlaylist.id },
    });
    await expect(
      prisma.frozenReleaseItem.create({
        data: {
          organizationId: alpha.id,
          releaseId: valid.release.id,
          sourcePlaylistItemId: sourceItem.id,
          sourceAssetId: betaMedia.id,
          assetName: "Cross-tenant frozen asset",
          assetKind: "IMAGE",
          assetMimeType: "image/png",
          assetUrl: betaMedia.url,
          assetChecksumSha256: betaMedia.checksumSha256,
          assetSizeBytes: 100n,
          assetCreatedAt: new Date(betaMedia.createdAt),
          position: 1,
          durationSeconds: 10,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      prisma.releaseAssignment.create({
        data: {
          organizationId: alpha.id,
          releaseId: valid.release.id,
          scheduleId: valid.schedule.id,
          state: "ASSIGNED",
          digestSha256: "6".repeat(64),
          createdById: actor.id,
          scheduleName: "Cross-tenant target",
          priority: "NORMAL",
          startsAt: new Date(input.startsAt),
          timezone: "UTC",
          daysOfWeek: [],
          enabled: true,
          targets: {
            create: [
              {
                screenId: betaScreen.id,
                liveScreenId: betaScreen.id,
                liveScreenOrganizationId: alpha.id,
              },
            ],
          },
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      prisma.releaseAssignmentTarget.create({
        data: {
          organizationId: alpha.id,
          assignmentId: valid.assignment.id,
          screenId: "partial-null-live-id",
          liveScreenId: null,
          liveScreenOrganizationId: alpha.id,
        },
      }),
    ).rejects.toBeDefined();
    await expect(
      prisma.releaseAssignmentTarget.create({
        data: {
          organizationId: alpha.id,
          assignmentId: valid.assignment.id,
          screenId: "partial-null-live-org",
          liveScreenId: "partial-null-live-org",
          liveScreenOrganizationId: null,
        },
      }),
    ).rejects.toBeDefined();
    expect(
      await prisma.releaseAssignment.count({
        where: { organizationId: alpha.id },
      }),
    ).toBe(1);
  });

  it("rolls back release, schedule, assignment, and targets when publication audit fails", async () => {
    const organization = await createOrganization("release-audit-rollback");
    const actor = await createUser("release-rollback@example.test");
    await prisma.membership.create({
      data: {
        organizationId: organization.id,
        userId: actor.id,
        role: "OWNER",
      },
    });
    const screen = await store.createScreen(organization.id, {
      name: "Rollback screen",
      location: "",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const media = await store.createMedia(organization.id, {
      name: "Rollback media",
      kind: "image",
      mimeType: "image/png",
      url: "https://media.example.test/rollback.png",
      checksumSha256: "4".repeat(64),
      sizeBytes: 100,
    });
    const playlist = await store.createPlaylist(organization.id, {
      name: "Rollback playlist",
      description: "",
      items: [
        {
          id: "ignored",
          assetId: media.id,
          position: 0,
          durationSeconds: 10,
        },
      ],
    });

    await prisma.$executeRawUnsafe(
      'ALTER TABLE "AuditEvent" ADD CONSTRAINT "integration_reject_release_publish" CHECK ("action" <> \'release.published\')',
    );
    try {
      await expect(
        store.publishScheduleAndAudit(
          organization.id,
          {
            playlistId: playlist.id,
            name: "Rollback schedule",
            priority: "normal",
            startsAt: new Date(Date.now() - 60_000).toISOString(),
            timezone: "UTC",
            daysOfWeek: [],
            enabled: true,
            screenIds: [screen.id],
          },
          { actorUserId: actor.id },
          { mediaAllowedOrigins: ["https://media.example.test"] },
        ),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" DROP CONSTRAINT "integration_reject_release_publish"',
      );
    }
    expect(await prisma.publishedRelease.count()).toBe(0);
    expect(await prisma.frozenReleaseItem.count()).toBe(0);
    expect(await prisma.schedule.count()).toBe(0);
    expect(await prisma.releaseAssignment.count()).toBe(0);
    expect(await prisma.releaseAssignmentTarget.count()).toBe(0);

    const publication = await store.publishScheduleAndAudit(
      organization.id,
      {
        playlistId: playlist.id,
        name: "Withdrawal rollback schedule",
        priority: "normal",
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        timezone: "UTC",
        daysOfWeek: [],
        enabled: true,
        screenIds: [screen.id],
      },
      { actorUserId: actor.id },
      { mediaAllowedOrigins: ["https://media.example.test"] },
    );
    if (!publication.published)
      throw new Error("withdrawal rollback fixture failed");
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "AuditEvent" ADD CONSTRAINT "integration_reject_release_withdraw" CHECK ("action" <> \'release.withdrawn\')',
    );
    try {
      await expect(
        store.withdrawScheduleAndAudit(
          organization.id,
          publication.schedule.id,
          { actorUserId: actor.id },
        ),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" DROP CONSTRAINT "integration_reject_release_withdraw"',
      );
    }
    expect(
      await prisma.releaseAssignment.count({
        where: { scheduleId: publication.schedule.id },
      }),
    ).toBe(1);
    await expect(
      store.activeOrdinaryReleases(
        organization.id,
        screen.id,
        new Date().toISOString(),
      ),
    ).resolves.toHaveLength(1);
  });

  it("release migration preflight refuses populated legacy schedules", async () => {
    const organization = await createOrganization("release-preflight");
    const playlist = await prisma.playlist.create({
      data: { organizationId: organization.id, name: "Legacy playlist" },
    });
    await prisma.schedule.create({
      data: {
        organizationId: organization.id,
        playlistId: playlist.id,
        name: "Legacy schedule",
        startsAt: new Date(),
      },
    });
    const migration = await readFile(
      new URL(
        "../prisma/migrations/20260912030000_immutable_ordinary_releases/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const preflight = migration.match(
      /DO \$release_preflight\$[\s\S]*?\$release_preflight\$;/,
    )?.[0];
    expect(preflight).toBeTruthy();

    await expect(prisma.$executeRawUnsafe(preflight!)).rejects.toMatchObject({
      code: "P2010",
      meta: expect.objectContaining({ code: "P0001" }),
    });
    expect(await prisma.schedule.count()).toBe(1);
  });

  it("rejects expired and aggregate-oversized media inside PostgreSQL publication", async () => {
    const organization = await createOrganization("media-policy");
    const actor = await createUser(`media-policy-${randomUUID()}@example.test`);
    await prisma.membership.create({
      data: {
        organizationId: organization.id,
        userId: actor.id,
        role: "PUBLISHER",
      },
    });
    const screen = await store.createScreen(organization.id, {
      name: "Media policy screen",
      location: "",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const publish = (playlistId: string) =>
      store.publishScheduleAndAudit(
        organization.id,
        {
          playlistId,
          name: `Media policy ${randomUUID()}`,
          priority: "normal",
          startsAt: new Date(Date.now() - 60_000).toISOString(),
          timezone: "UTC",
          daysOfWeek: [],
          enabled: true,
          screenIds: [screen.id],
        },
        { actorUserId: actor.id },
        { mediaAllowedOrigins: ["https://media.example.test"] },
      );

    const expiredAsset = await store.createMedia(organization.id, {
      name: "Expired",
      kind: "image",
      mimeType: "image/png",
      url: "https://media.example.test/expired.png",
      checksumSha256: "a".repeat(64),
      sizeBytes: 1,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const expiredPlaylist = await store.createPlaylist(organization.id, {
      name: "Expired playlist",
      description: "",
      items: [
        {
          id: "ignored",
          assetId: expiredAsset.id,
          position: 0,
          durationSeconds: 10,
        },
      ],
    });
    await expect(publish(expiredPlaylist.id)).resolves.toEqual({
      published: false,
      reason: "ASSET_EXPIRED",
    });
    await prisma.mediaAsset.update({
      where: { id: expiredAsset.id },
      data: { kind: "WEB", mimeType: "text/html", expiresAt: null },
    });
    await expect(publish(expiredPlaylist.id)).resolves.toEqual({
      published: false,
      reason: "ASSET_UNSUPPORTED",
    });

    const assets = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        store.createMedia(organization.id, {
          name: `Large ${index}`,
          kind: "video",
          mimeType: "video/mp4",
          url: `https://media.example.test/large-${index}.mp4`,
          checksumSha256: String(index).repeat(64),
          sizeBytes: 128 * 1024 * 1024,
        }),
      ),
    );
    const aggregatePlaylist = await store.createPlaylist(organization.id, {
      name: "Aggregate playlist",
      description: "",
      items: assets.map((asset, position) => ({
        id: "ignored",
        assetId: asset.id,
        position,
        durationSeconds: 10,
      })),
    });
    await expect(publish(aggregatePlaylist.id)).resolves.toEqual({
      published: false,
      reason: "RELEASE_TOO_LARGE",
    });
    expect(await prisma.publishedRelease.count()).toBe(0);
    expect(await prisma.releaseAssignment.count()).toBe(0);
    expect(await prisma.schedule.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("enforces case-insensitive email uniqueness in PostgreSQL", async () => {
    await createUser("Owner@Example.Test");

    await expect(createUser("owner@example.test")).rejects.toMatchObject({
      code: "P2002",
    });
    expect(await prisma.user.count()).toBe(1);
  });

  it("migration preflight aborts on legacy case variants without choosing an account", async () => {
    const migrationUrl = new URL(
      "../prisma/migrations/20260912021000_case_insensitive_user_email/migration.sql",
      import.meta.url,
    );
    const migration = await readFile(migrationUrl, "utf8");
    const preflight = migration.match(
      /DO \$identity_preflight\$[\s\S]*?\$identity_preflight\$;/,
    )?.[0];
    expect(preflight).toBeTruthy();

    await prisma.$executeRawUnsafe('DROP INDEX "User_email_lower_key"');
    try {
      await Promise.all([
        createUser("Legacy@Example.Test"),
        createUser("legacy@example.test"),
      ]);

      await expect(prisma.$executeRawUnsafe(preflight!)).rejects.toMatchObject({
        code: "P2010",
        meta: expect.objectContaining({ code: "23505" }),
      });
      const indexes = await prisma.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname = 'User_email_lower_key'
      `;
      expect(indexes[0]?.count).toBe(0);
      expect(await prisma.user.count()).toBe(2);
    } finally {
      await prisma.user.deleteMany();
      await prisma.$executeRawUnsafe(
        'CREATE UNIQUE INDEX "User_email_lower_key" ON "User" (LOWER("email"))',
      );
    }
  });
});
