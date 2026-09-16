import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { compare, hash } from "bcryptjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  COMPATIBILITY_GRANT_CAPABILITIES,
  COMPATIBILITY_GRANT_SYSTEM_KEY,
  compatibilityGrantId,
} from "../src/authorization/compatibility.js";
import {
  MEMBER_PROVISION_ACKNOWLEDGEMENT,
  MEMBER_PROVISION_ACTION,
  MEMBER_PROVISION_CONTAINMENT_ACTION,
  provisionMember,
} from "../src/identity/member-provisioning.js";

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
const parsedDatabaseUrl = new URL(databaseUrl);
const databaseName = decodeURIComponent(parsedDatabaseUrl.pathname.slice(1));
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
if (
  databaseName !== "screengoblin_test" ||
  !loopbackHosts.has(parsedDatabaseUrl.hostname)
) {
  throw new Error(
    "Refusing to truncate PostgreSQL: integration tests require the exact " +
      'database name "screengoblin_test" on a loopback host',
  );
}

const prisma = new PrismaClient();
const baseInput = (organizationSlug: string, email: string) => ({
  acknowledgement: MEMBER_PROVISION_ACKNOWLEDGEMENT,
  organizationSlug,
  email,
  name: "Release Publisher",
  role: "PUBLISHER" as const,
  temporaryPassword: "temporary-member-password-2026",
  reason: "Establish maker-checker release operations.",
});
const createOrganization = (label: string) =>
  prisma.organization.create({
    data: {
      name: `Member provision ${label}`,
      slug: `${label}-${randomUUID()}`,
    },
  });

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Organization", "User", "DeviceKeyTombstone", "LoginFailureEvent" RESTART IDENTITY CASCADE',
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("offline member provisioning", () => {
  it.each(["ADMIN", "PUBLISHER", "VIEWER"] as const)(
    "atomically provisions a %s with exact attribution, grants, and audit evidence",
    async (role) => {
      const organization = await createOrganization(role.toLowerCase());
      const input = {
        ...baseInput(organization.slug, `${role}@Example.Test`),
        role,
      };
      const [before] = await prisma.$queryRaw<Array<{ databaseNow: Date }>>`
        SELECT CURRENT_TIMESTAMP AS "databaseNow"`;
      if (!before) throw new Error("Database clock was unavailable");

      const result = await provisionMember(prisma, input);
      const [after] = await prisma.$queryRaw<Array<{ databaseNow: Date }>>`
        SELECT CURRENT_TIMESTAMP AS "databaseNow"`;
      if (!after) throw new Error("Database clock was unavailable");

      expect(result).toMatchObject({
        status: "CREATED",
        organizationId: organization.id,
        normalizedEmail: `${role.toLowerCase()}@example.test`,
        role,
      });
      expect(result.changeBefore.getTime()).toBeGreaterThanOrEqual(
        before.databaseNow.getTime() + 24 * 60 * 60_000,
      );
      expect(result.changeBefore.getTime()).toBeLessThanOrEqual(
        after.databaseNow.getTime() + 24 * 60 * 60_000,
      );

      const user = await prisma.user.findUniqueOrThrow({
        where: { id: result.userId },
      });
      expect(user).toMatchObject({
        email: `${role.toLowerCase()}@example.test`,
        name: input.name,
        disabledAt: null,
        bootstrapPasswordExpiresAt: result.changeBefore,
      });
      await expect(
        compare(input.temporaryPassword, user.passwordHash),
      ).resolves.toBe(true);
      await expect(
        prisma.membership.findUniqueOrThrow({
          where: { id: result.membershipId },
        }),
      ).resolves.toMatchObject({
        organizationId: organization.id,
        userId: result.userId,
        role,
        authorizationEpoch: 0,
      });
      await expect(
        prisma.membershipAttribution.findUniqueOrThrow({
          where: {
            organizationId_userId: {
              organizationId: organization.id,
              userId: result.userId,
            },
          },
        }),
      ).resolves.toBeDefined();

      const grants = await prisma.accessGrant.findMany({
        where: {
          organizationId: organization.id,
          subjectUserId: result.userId,
        },
        orderBy: { capability: "asc" },
      });
      const capabilities = [...COMPATIBILITY_GRANT_CAPABILITIES[role]].sort();
      expect(grants.map(({ capability }) => capability)).toEqual(capabilities);
      expect(grants).toEqual(
        capabilities.map((capability) =>
          expect.objectContaining({
            id: compatibilityGrantId(
              organization.id,
              result.membershipId,
              0,
              capability,
            ),
            subjectMembershipId: result.membershipId,
            scopeType: "ORGANIZATION",
            locationId: null,
            screenGroupId: null,
            screenId: null,
            expiresAt: null,
            revokedAt: null,
            creatorKind: "SYSTEM",
            createdByUserId: null,
            createdBySystemKey: COMPATIBILITY_GRANT_SYSTEM_KEY,
          }),
        ),
      );
      expect(
        grants.every(
          ({ startsAt, createdAt }) =>
            startsAt.getTime() === user.createdAt.getTime() &&
            createdAt.getTime() === user.createdAt.getTime(),
        ),
      ).toBe(true);

      const audits = await prisma.auditEvent.findMany({
        where: {
          organizationId: organization.id,
          action: {
            in: [MEMBER_PROVISION_ACTION, MEMBER_PROVISION_CONTAINMENT_ACTION],
          },
        },
      });
      expect(audits).toHaveLength(2);
      expect(audits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            organizationId: organization.id,
            actorUserId: null,
            actorType: "system",
            action: MEMBER_PROVISION_ACTION,
            entityType: "membership",
            entityId: result.membershipId,
            metadata: {
              source: "offline-member-provisioning",
              version: 1,
              reason: input.reason,
              role,
              grantCount: capabilities.length,
              bootstrapWindowHours: 24,
            },
          }),
          expect.objectContaining({
            organizationId: organization.id,
            actorUserId: null,
            actorType: "system",
            action: MEMBER_PROVISION_CONTAINMENT_ACTION,
            entityType: "user",
            entityId: result.userId,
            metadata: {
              source: "offline-member-provisioning",
              version: 1,
              previousCredentialPreserved: false,
              authenticationEpochAdvanced: false,
              sessionsRevoked: false,
              bootstrapWindowHours: 24,
            },
          }),
        ]),
      );
      expect(
        audits.every(
          ({ createdAt }) => createdAt.getTime() === user.createdAt.getTime(),
        ),
      ).toBe(true);
      expect(JSON.stringify(audits)).not.toContain(input.temporaryPassword);
      expect(JSON.stringify(audits)).not.toContain(user.passwordHash);
      expect(JSON.stringify(result)).not.toContain(input.temporaryPassword);
      expect(JSON.stringify(result)).not.toContain(user.passwordHash);
    },
  );

  it("rejects a missing organization and an email already owned by another identity", async () => {
    await expect(
      provisionMember(
        prisma,
        baseInput("missing-organization", "missing@example.test"),
      ),
    ).rejects.toThrow();
    expect(await prisma.user.count()).toBe(0);

    const organization = await createOrganization("existing-email");
    const existing = await prisma.user.create({
      data: {
        email: "existing@example.test",
        name: "Existing identity",
        passwordHash: await hash("existing-user-password-2026", 4),
      },
    });
    await expect(
      provisionMember(
        prisma,
        baseInput(organization.slug, existing.email.toUpperCase()),
      ),
    ).rejects.toThrow();
    expect(await prisma.membership.count()).toBe(0);
    expect(await prisma.accessGrant.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("returns an exact rerun unchanged without extending expiry or writing evidence", async () => {
    const organization = await createOrganization("rerun");
    const input = baseInput(organization.slug, "rerun@example.test");
    const created = await provisionMember(prisma, input);
    const before = {
      users: await prisma.user.count(),
      memberships: await prisma.membership.count(),
      grants: await prisma.accessGrant.count(),
      audits: await prisma.auditEvent.count(),
      user: await prisma.user.findUniqueOrThrow({
        where: { id: created.userId },
      }),
      grantRows: await prisma.accessGrant.findMany({
        where: { subjectUserId: created.userId },
        orderBy: { id: "asc" },
      }),
      auditRows: await prisma.auditEvent.findMany({
        where: { organizationId: organization.id },
        orderBy: { id: "asc" },
      }),
    };

    const rerun = await provisionMember(prisma, {
      ...input,
      organizationSlug: `  ${organization.slug}  `,
      email: "  RERUN@EXAMPLE.TEST  ",
      name: `  ${input.name}  `,
      reason: `  ${input.reason}  `,
    });

    expect(rerun).toEqual({ ...created, status: "UNCHANGED" });
    expect(rerun.changeBefore).toEqual(created.changeBefore);
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: created.userId } }),
    ).resolves.toMatchObject({
      bootstrapPasswordExpiresAt: created.changeBefore,
    });
    expect({
      users: await prisma.user.count(),
      memberships: await prisma.membership.count(),
      grants: await prisma.accessGrant.count(),
      audits: await prisma.auditEvent.count(),
      user: await prisma.user.findUniqueOrThrow({
        where: { id: created.userId },
      }),
      grantRows: await prisma.accessGrant.findMany({
        where: { subjectUserId: created.userId },
        orderBy: { id: "asc" },
      }),
      auditRows: await prisma.auditEvent.findMany({
        where: { organizationId: organization.id },
        orderBy: { id: "asc" },
      }),
    }).toEqual(before);
  });

  it.each([
    ["password", { temporaryPassword: "different-temporary-password-2026" }],
    ["reason", { reason: "Different operator justification" }],
    ["role", { role: "ADMIN" as const }],
    ["name", { name: "Different Member Name" }],
  ])("rejects a rerun with conflicting %s", async (_field, patch) => {
    const organization = await createOrganization(`conflict-${_field}`);
    const input = baseInput(
      organization.slug,
      `conflict-${_field}@example.test`,
    );
    const created = await provisionMember(prisma, input);

    await expect(
      provisionMember(prisma, { ...input, ...patch }),
    ).rejects.toThrow();
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.membership.count()).toBe(1);
    expect(await prisma.accessGrant.count()).toBe(
      COMPATIBILITY_GRANT_CAPABILITIES.PUBLISHER.length,
    );
    expect(await prisma.auditEvent.count()).toBe(2);
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: created.userId } }),
    ).resolves.toMatchObject({
      name: input.name,
      bootstrapPasswordExpiresAt: created.changeBefore,
    });
  });

  it("rejects organization changes and incomplete pre-existing state", async () => {
    const organization = await createOrganization("organization-conflict");
    const otherOrganization = await createOrganization(
      "organization-conflict-other",
    );
    const input = baseInput(
      organization.slug,
      "organization-conflict@example.test",
    );
    await provisionMember(prisma, input);
    await expect(
      provisionMember(prisma, {
        ...input,
        organizationSlug: otherOrganization.slug,
      }),
    ).rejects.toThrow();

    const partialEmail = "partial-state@example.test";
    await prisma.user.create({
      data: {
        email: partialEmail,
        name: input.name,
        passwordHash: await hash(input.temporaryPassword, 4),
        bootstrapPasswordExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(
      provisionMember(
        prisma,
        baseInput(organization.slug, partialEmail.toUpperCase()),
      ),
    ).rejects.toThrow();
    expect(await prisma.membership.count()).toBe(1);

    const partialMemberEmail = "partial-membership@example.test";
    const partialMember = await prisma.user.create({
      data: {
        email: partialMemberEmail,
        name: input.name,
        passwordHash: await hash(input.temporaryPassword, 4),
        bootstrapPasswordExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.membership.create({
      data: {
        organizationId: organization.id,
        userId: partialMember.id,
        role: input.role,
      },
    });
    await expect(
      provisionMember(
        prisma,
        baseInput(organization.slug, partialMemberEmail.toUpperCase()),
      ),
    ).rejects.toThrow();
    expect(
      await prisma.accessGrant.count({
        where: { subjectUserId: partialMember.id },
      }),
    ).toBe(0);
    expect(
      await prisma.auditEvent.count({ where: { entityId: partialMember.id } }),
    ).toBe(0);
  });

  it("refuses rerun after password rotation", async () => {
    const organization = await createOrganization("rotated");
    const input = baseInput(organization.slug, "rotated@example.test");
    const created = await provisionMember(prisma, input);
    const rotatedHash = await hash("permanent-rotated-password-2026", 4);
    await prisma.user.update({
      where: { id: created.userId },
      data: { passwordHash: rotatedHash, bootstrapPasswordExpiresAt: null },
    });

    await expect(provisionMember(prisma, input)).rejects.toThrow();
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: created.userId } }),
    ).resolves.toMatchObject({
      passwordHash: rotatedHash,
      bootstrapPasswordExpiresAt: null,
    });
    expect(await prisma.auditEvent.count()).toBe(2);
  });

  it("refuses rerun after the temporary credential marker expires", async () => {
    const organization = await createOrganization("expired");
    const input = baseInput(organization.slug, "expired@example.test");
    const created = await provisionMember(prisma, input);
    const expiredAt = new Date("2020-01-01T00:00:00.000Z");
    await prisma.user.update({
      where: { id: created.userId },
      data: { bootstrapPasswordExpiresAt: expiredAt },
    });

    await expect(provisionMember(prisma, input)).rejects.toThrow();
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: created.userId } }),
    ).resolves.toMatchObject({ bootstrapPasswordExpiresAt: expiredAt });
    expect(await prisma.membership.count()).toBe(1);
    expect(await prisma.accessGrant.count()).toBe(
      COMPATIBILITY_GRANT_CAPABILITIES.PUBLISHER.length,
    );
    expect(await prisma.auditEvent.count()).toBe(2);
  });

  it("serializes identical and conflicting concurrent requests", async () => {
    const organization = await createOrganization("concurrent-identical");
    const identical = baseInput(
      organization.slug,
      "concurrent-identical@example.test",
    );
    const identicalResults = await Promise.all([
      provisionMember(prisma, identical),
      provisionMember(prisma, identical),
      provisionMember(prisma, identical),
    ]);
    expect(identicalResults.map(({ status }) => status).sort()).toEqual([
      "CREATED",
      "UNCHANGED",
      "UNCHANGED",
    ]);
    expect(new Set(identicalResults.map(({ userId }) => userId)).size).toBe(1);
    expect(await prisma.auditEvent.count()).toBe(2);

    const otherOrganization = await createOrganization("concurrent-conflict");
    const conflicting = baseInput(
      otherOrganization.slug,
      "concurrent-conflict@example.test",
    );
    const conflictResults = await Promise.allSettled([
      provisionMember(prisma, conflicting),
      provisionMember(prisma, {
        ...conflicting,
        temporaryPassword: "different-concurrent-password-2026",
      }),
    ]);
    expect(
      conflictResults.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      conflictResults.filter(({ status }) => status === "rejected"),
    ).toHaveLength(1);
    expect(
      await prisma.user.count({
        where: { email: conflicting.email.toLowerCase() },
      }),
    ).toBe(1);
  });

  it.each([
    [
      "audit",
      'ALTER TABLE "AuditEvent" ADD CONSTRAINT "integration_reject_member_provision_audit" CHECK ("action" <> \'identity.member_provisioned\')',
      'ALTER TABLE "AuditEvent" DROP CONSTRAINT "integration_reject_member_provision_audit"',
    ],
    [
      "grant",
      'ALTER TABLE "AccessGrant" ADD CONSTRAINT "integration_reject_member_provision_grant" CHECK ("createdBySystemKey" IS DISTINCT FROM \'legacy-role-backfill-v1\')',
      'ALTER TABLE "AccessGrant" DROP CONSTRAINT "integration_reject_member_provision_grant"',
    ],
  ])(
    "rolls back every mutation after an induced %s failure",
    async (kind, add, drop) => {
      const organization = await createOrganization(`rollback-${kind}`);
      const input = baseInput(
        organization.slug,
        `rollback-${kind}@example.test`,
      );
      await prisma.$executeRawUnsafe(add);
      try {
        await expect(provisionMember(prisma, input)).rejects.toThrow();
      } finally {
        await prisma.$executeRawUnsafe(drop);
      }

      expect(await prisma.user.count()).toBe(0);
      expect(await prisma.membership.count()).toBe(0);
      expect(await prisma.membershipAttribution.count()).toBe(0);
      expect(await prisma.accessGrant.count()).toBe(0);
      expect(await prisma.auditEvent.count()).toBe(0);
    },
  );
});
