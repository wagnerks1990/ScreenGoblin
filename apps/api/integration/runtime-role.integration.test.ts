import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaStore } from "../src/store/prisma.js";

const runtimeDatabaseUrl = process.env.DATABASE_URL;
const ownerDatabaseUrl = process.env.OWNER_DATABASE_URL;
const migrationOwner = process.env.MIGRATION_DATABASE_USER;
const runtimeRole = process.env.POSTGRES_RUNTIME_USER;

if (
  !runtimeDatabaseUrl ||
  !ownerDatabaseUrl ||
  !migrationOwner ||
  !runtimeRole
) {
  throw new Error(
    "DATABASE_URL, OWNER_DATABASE_URL, MIGRATION_DATABASE_USER, and POSTGRES_RUNTIME_USER are required",
  );
}

const assertDisposableDatabase = (databaseUrl: string) => {
  const parsed = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (
    databaseName !== "screengoblin_test" ||
    !new Set(["127.0.0.1", "localhost", "[::1]", "::1"]).has(parsed.hostname)
  ) {
    throw new Error(
      'Runtime-role integration tests require "screengoblin_test" on a loopback host',
    );
  }
};

assertDisposableDatabase(runtimeDatabaseUrl);
assertDisposableDatabase(ownerDatabaseUrl);

const ownerPrisma = new PrismaClient({
  datasources: { db: { url: ownerDatabaseUrl } },
});
const runtimePrisma = new PrismaClient({
  datasources: { db: { url: runtimeDatabaseUrl } },
});
const store = new PrismaStore(runtimePrisma);
const fixtureSuffix = randomUUID();
const fixtureSlug = `runtime-role-${fixtureSuffix}`;
let organizationId: string;
let actorUserId: string;
let actorPasswordHash: string;

const lowercaseDigest = () => randomUUID().replaceAll("-", "").padEnd(64, "0");

class RollbackSuccessfulProbe extends Error {}

const expectPermissionDenied = async (statement: string) => {
  let statementCompleted = false;
  const error = await runtimePrisma
    .$transaction(async (tx) => {
      await tx.$executeRawUnsafe(statement);
      statementCompleted = true;
      throw new RollbackSuccessfulProbe();
    })
    .then(
      () => null,
      (reason: unknown) => reason,
    );

  // If a privilege unexpectedly exists, the deliberate error still rolls the
  // probe back before this assertion fails.
  expect(statementCompleted).toBe(false);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(RollbackSuccessfulProbe);
  const prismaError = error as { code?: unknown; meta?: { code?: unknown } };
  expect(prismaError.code).toBe("P2010");
  expect(prismaError.meta?.code).toBe("42501");
};

beforeAll(async () => {
  const organization = await ownerPrisma.organization.create({
    data: {
      name: "Runtime role integration",
      slug: fixtureSlug,
    },
  });
  organizationId = organization.id;
  actorPasswordHash =
    "$2b$12$C6UzMDM.H6dfI/f/IKcEe.82jG7y4g4AY8I8HibLFSWafVkx8S4hS";
  const actor = await ownerPrisma.user.create({
    data: {
      email: `runtime-role-${fixtureSuffix}@example.test`,
      name: "Runtime Role Owner",
      passwordHash: actorPasswordHash,
      memberships: {
        create: { organizationId, role: "OWNER" },
      },
    },
  });
  actorUserId = actor.id;
});

afterAll(async () => {
  if (organizationId) {
    await ownerPrisma.organization.deleteMany({
      where: { id: organizationId },
    });
  }
  if (actorUserId) {
    await ownerPrisma.user.deleteMany({ where: { id: actorUserId } });
  }
  await Promise.all([ownerPrisma.$disconnect(), runtimePrisma.$disconnect()]);
});

describe("least-privilege PostgreSQL runtime role", () => {
  it("has no owner attributes, elevated role memberships, or migrator inheritance", async () => {
    const [identity] = await runtimePrisma.$queryRaw<
      Array<{
        currentUser: string;
        superuser: boolean;
        createRole: boolean;
        createDb: boolean;
        replication: boolean;
        bypassRls: boolean;
        inherit: boolean;
        membershipCount: bigint;
        canSetMigrator: boolean;
      }>
    >`
      SELECT current_user AS "currentUser",
             role.rolsuper AS superuser,
             role.rolcreaterole AS "createRole",
             role.rolcreatedb AS "createDb",
             role.rolreplication AS replication,
             role.rolbypassrls AS "bypassRls",
             role.rolinherit AS inherit,
             (
               SELECT count(*)
               FROM pg_catalog.pg_auth_members membership
               WHERE membership.member = role.oid
             ) AS "membershipCount",
             pg_has_role(current_user, ${migrationOwner}, 'MEMBER') AS "canSetMigrator"
      FROM pg_catalog.pg_roles role
      WHERE role.rolname = current_user`;

    expect(identity).toEqual({
      currentUser: runtimeRole,
      superuser: false,
      createRole: false,
      createDb: false,
      replication: false,
      bypassRls: false,
      inherit: false,
      membershipCount: 0n,
      canSetMigrator: false,
    });
  });

  it("supports representative runtime reads, writes, audits, sessions, and release preparation", async () => {
    const screenResult = await store.createScreenAndAudit(
      organizationId,
      {
        name: "Runtime role screen",
        location: "",
        orientation: "landscape",
        resolution: "1920x1080",
        tags: ["runtime-role"],
      },
      { actorUserId, requestId: "runtime-role-screen" },
    );
    expect(screenResult.created).toBe(true);
    if (!screenResult.created) throw new Error(screenResult.reason);

    const session = await store.createUserSessionAndAudit(
      organizationId,
      {
        tokenHash: lowercaseDigest(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        expectedPasswordHash: actorPasswordHash,
        expectedRole: "OWNER",
        expectedAuthenticationEpoch: 0,
        expectedAuthorizationEpoch: 0,
      },
      { actorUserId, requestId: "runtime-role-login" },
    );
    expect(session).toMatchObject({ created: true });

    const media = await store.createMedia(organizationId, {
      name: "Runtime role asset",
      kind: "image",
      mimeType: "image/png",
      url: "https://media.example.test/runtime-role.png",
      checksumSha256: "a".repeat(64),
      sizeBytes: 100,
    });
    const playlist = await store.createPlaylist(organizationId, {
      name: "Runtime role playlist",
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
    const candidate = await store.createReleaseCandidateAndAudit(
      organizationId,
      {
        playlistId: playlist.id,
        name: "Runtime role release candidate",
        priority: "normal",
        startsAt: new Date(Date.now() + 60_000).toISOString(),
        timezone: "UTC",
        daysOfWeek: [],
        enabled: true,
        screenIds: [screenResult.value.id],
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      },
      { actorUserId, requestId: "runtime-role-candidate" },
      { mediaAllowedOrigins: ["https://media.example.test"] },
      {
        keyHash: lowercaseDigest(),
        requestDigestSha256: lowercaseDigest(),
      },
    );
    expect(candidate).toMatchObject({ completed: true });
    await expect(store.listScreens(organizationId)).resolves.toContainEqual(
      expect.objectContaining({ id: screenResult.value.id }),
    );
    await expect(store.listAudits(organizationId, 20)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "screen.created" }),
        expect.objectContaining({ action: "auth.login_succeeded" }),
        expect.objectContaining({ action: "release.candidate.created" }),
      ]),
    );
  });

  it("denies database escape, migration, evidence mutation, and root deletion operations", async () => {
    const quoteIdentifier = (value: string) =>
      `"${value.replaceAll('"', '""')}"`;
    const probes = [
      "CREATE TEMPORARY TABLE runtime_privilege_probe (id integer)",
      `SET ROLE ${quoteIdentifier(migrationOwner)}`,
      "CREATE SCHEMA runtime_privilege_probe",
      'ALTER TABLE public."Screen" ADD COLUMN runtime_privilege_probe integer',
      'TRUNCATE TABLE public."Screen"',
      'SELECT 1 FROM public."_prisma_migrations" LIMIT 1',
      `UPDATE public."AuditEvent" SET action = 'runtime.probe' WHERE false`,
      `DELETE FROM public."AuditEvent" WHERE false`,
      `DELETE FROM public."Organization" WHERE false`,
      `DELETE FROM public."User" WHERE false`,
    ];
    for (const statement of probes) await expectPermissionDenied(statement);
  });
});
