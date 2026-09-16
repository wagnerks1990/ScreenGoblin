import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { compare, hash } from "bcryptjs";
import {
  COMPATIBILITY_GRANT_SYSTEM_KEY,
  compatibilityGrantCapabilities,
  compatibilityGrantId,
} from "../src/authorization/compatibility.js";
import {
  decideExistingBootstrapContainment,
  readSeedEnvironment,
} from "./seed-password.js";
const prisma = new PrismaClient();
const {
  email,
  password,
  organizationName,
  organizationSlug,
  administratorName,
} = readSeedEnvironment();
const passwordHash = await hash(password, 12);
const bootstrapAuditAction = "auth.bootstrap_password_containment_enabled";
const bootstrapSeedLockIdentity = `ScreenGoblin bootstrap seed identity v1\n${email.length}:${email}`;
const result = await prisma.$transaction(async (tx) => {
  const lockRows = await tx.$queryRaw<
    Array<{ acquired: number }>
  >`SELECT 1::integer AS acquired
       FROM pg_advisory_xact_lock(hashtextextended(${bootstrapSeedLockIdentity}, 0))`;
  if (lockRows[0]?.acquired !== 1)
    throw new Error("Bootstrap seed lock was unavailable");
  const organization = await tx.organization.upsert({
    where: { slug: organizationSlug },
    update: {},
    create: { name: organizationName, slug: organizationSlug },
  });
  await tx.location.upsert({
    where: {
      organizationId_name: {
        organizationId: organization.id,
        name: "Unassigned",
      },
    },
    update: {},
    create: { organizationId: organization.id, name: "Unassigned" },
  });

  const locked = await tx.$queryRaw<
    Array<{
      id: string;
      passwordHash: string;
      bootstrapPasswordExpiresAt: Date | null;
      databaseNow: Date;
      bootstrapDeadline: Date;
    }>
  >`SELECT actor.id,
           actor."passwordHash",
           actor."bootstrapPasswordExpiresAt",
           CURRENT_TIMESTAMP AS "databaseNow",
           CURRENT_TIMESTAMP + INTERVAL '24 hours' AS "bootstrapDeadline"
      FROM "User" actor
     WHERE LOWER(actor.email) = LOWER(${email})
     FOR UPDATE`;
  const existing = locked[0];
  if (existing) {
    const memberships = await tx.membership.findMany({
      where: { userId: existing.id },
      orderBy: [{ organizationId: "asc" }, { id: "asc" }],
    });
    const alreadyOwner = memberships.some(
      (membership) =>
        membership.organizationId === organization.id &&
        membership.role === "OWNER",
    );
    if (!alreadyOwner)
      throw new Error(
        "Bootstrap email already exists without the requested owner membership; refusing to change privileges",
      );

    const priorContainmentAudit = await tx.auditEvent.findFirst({
      where: {
        actorType: "system",
        action: bootstrapAuditAction,
        entityType: "user",
        entityId: existing.id,
      },
      select: { id: true },
    });
    const containmentDecision = decideExistingBootstrapContainment({
      bootstrapPasswordExpiresAt: existing.bootstrapPasswordExpiresAt,
      databaseNow: existing.databaseNow,
      hasContainmentAudit: priorContainmentAudit !== null,
      seedPasswordMatches: await compare(password, existing.passwordHash),
    });
    if (containmentDecision === "MARK") {
      await tx.user.update({
        where: { id: existing.id },
        data: {
          authenticationEpoch: { increment: 1 },
          bootstrapPasswordExpiresAt: existing.bootstrapDeadline,
        },
      });
      await tx.userSession.updateMany({
        where: { userId: existing.id, revokedAt: null },
        data: { revokedAt: existing.databaseNow },
      });
      await tx.auditEvent.createMany({
        data: memberships.map((membership) => ({
          organizationId: membership.organizationId,
          actorType: "system",
          action: bootstrapAuditAction,
          entityType: "user",
          entityId: existing.id,
          metadata: {
            source: "deployment-seed",
            previousCredentialPreserved: true,
            authenticationEpochAdvanced: true,
            sessionsRevoked: true,
          },
        })),
      });
      return { status: "marked-existing" as const };
    }
    return { status: "unchanged-existing" as const };
  }

  const [databaseClock] = await tx.$queryRaw<
    Array<{ deadline: Date }>
  >`SELECT CURRENT_TIMESTAMP + INTERVAL '24 hours' AS deadline`;
  if (!databaseClock) throw new Error("Database clock was unavailable");
  const created = await tx.user.create({
    data: {
      email,
      name: administratorName,
      passwordHash,
      bootstrapPasswordExpiresAt: databaseClock.deadline,
      memberships: {
        create: { organizationId: organization.id, role: "OWNER" },
      },
    },
    include: { memberships: true },
  });
  const membership = created.memberships.find(
    (candidate) => candidate.organizationId === organization.id,
  );
  if (!membership) throw new Error("Bootstrap membership was not created");
  await tx.accessGrant.createMany({
    data: compatibilityGrantCapabilities("OWNER").map((capability) => ({
      id: compatibilityGrantId(
        organization.id,
        membership.id,
        membership.authorizationEpoch,
        capability,
      ),
      organizationId: organization.id,
      subjectUserId: created.id,
      subjectMembershipId: membership.id,
      capability,
      scopeType: "ORGANIZATION",
      creatorKind: "SYSTEM",
      createdBySystemKey: COMPATIBILITY_GRANT_SYSTEM_KEY,
    })),
  });
  await tx.auditEvent.create({
    data: {
      organizationId: organization.id,
      actorType: "system",
      action: bootstrapAuditAction,
      entityType: "user",
      entityId: created.id,
      metadata: {
        source: "deployment-seed",
        previousCredentialPreserved: false,
        authenticationEpochAdvanced: false,
        sessionsRevoked: false,
      },
    },
  });
  return { status: "created" as const };
});
if (result.status === "created") {
  console.log(`Created bootstrap organization owner ${email}.`);
} else if (result.status === "marked-existing") {
  console.log(`Contained existing bootstrap owner credential for ${email}.`);
} else {
  console.log(
    `Bootstrap owner ${email} already exists; no credentials changed.`,
  );
}
await prisma.$disconnect();
