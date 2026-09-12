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

beforeAll(async () => {
  await store.ping();
});

beforeEach(async () => {
  // This job owns an isolated CI database. CASCADE keeps cleanup compatible
  // with new tenant-owned tables while retaining the migrated schema itself.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Organization", "User" RESTART IDENTITY CASCADE',
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
      false,
    );
    await expect(store.deletePlaylist(alpha.id, betaPlaylist.id)).resolves.toBe(
      false,
    );
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
    await expect(
      prisma.pairingCode.update({
        where: { id: pairing.id },
        data: {
          screenId: betaScreen.id,
          screenOrganizationId: beta.id,
        },
      }),
    ).rejects.toMatchObject({
      name: "PrismaClientUnknownRequestError",
      message: expect.stringContaining(
        'violates check constraint "PairingCode_screen_organization_check"',
      ),
    });

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

  it("rolls back pairing creation when its required audit actor is invalid", async () => {
    const organization = await createOrganization("pairing-create-rollback");
    const codeHash = `failed-audit-${randomUUID()}`;

    await expect(
      store.tryCreatePairingAndAudit(
        organization.id,
        codeHash,
        new Date(Date.now() + 60_000).toISOString(),
        { actorUserId: `missing-user-${randomUUID()}` },
      ),
    ).rejects.toMatchObject({ code: "P2003" });
    expect(await prisma.pairingCode.count({ where: { codeHash } })).toBe(0);
    expect(
      await prisma.auditEvent.count({
        where: { organizationId: organization.id, action: "pairing.created" },
      }),
    ).toBe(0);
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
      uptimeSeconds: sizeBytes,
      freeStorageBytes: sizeBytes - 1,
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
