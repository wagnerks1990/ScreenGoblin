import type { Prisma, PrismaClient } from "@prisma/client";
import { compare, hash } from "bcryptjs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  COMPATIBILITY_GRANT_SYSTEM_KEY,
  compatibilityGrantCapabilities,
  compatibilityGrantId,
} from "../authorization/compatibility.js";
import { validateTemporaryPassword } from "./temporary-password-policy.js";

export const MEMBER_PROVISION_ACKNOWLEDGEMENT =
  "CREATE_NEW_NON_OWNER_MEMBER_WITH_24_HOUR_ROTATION";

export const MEMBER_PROVISION_ACTION = "identity.member_provisioned";
export const MEMBER_PROVISION_CONTAINMENT_ACTION =
  "auth.bootstrap_password_containment_enabled";

const MEMBER_PROVISION_SOURCE = "offline-member-provisioning";
const MEMBER_PROVISION_VERSION = 1;
const BCRYPT_COST = 12;

export const MEMBER_PROVISION_ROLES = ["ADMIN", "PUBLISHER", "VIEWER"] as const;

export type MemberProvisionRole = (typeof MEMBER_PROVISION_ROLES)[number];

export type MemberProvisionInput = {
  acknowledgement: string;
  organizationSlug: string;
  email: string;
  name: string;
  role: string;
  temporaryPassword: string;
  reason: string;
};

export type NormalizedMemberProvisionInput = Omit<
  MemberProvisionInput,
  "acknowledgement" | "email" | "organizationSlug" | "name" | "role" | "reason"
> & {
  organizationSlug: string;
  normalizedEmail: string;
  name: string;
  role: MemberProvisionRole;
  reason: string;
};

export type MemberProvisionResult = {
  status: "CREATED" | "UNCHANGED";
  userId: string;
  membershipId: string;
  organizationId: string;
  normalizedEmail: string;
  role: MemberProvisionRole;
  changeBefore: Date;
};

type ProvisioningPrisma = Pick<PrismaClient, "$transaction">;

const emailSchema = z.email().max(320);

const bounded = (value: string, field: string, maximum: number) => {
  const normalized = value.trim();
  if (normalized.length === 0 || [...normalized].length > maximum)
    throw new Error(
      `${field} must contain between 1 and ${maximum} characters`,
    );
  return normalized;
};

const rejectPlaceholder = (value: string, field: string) => {
  if (/^replace-with-/i.test(value.trim()))
    throw new Error(`${field} may not be a placeholder`);
};

export const normalizeMemberProvisionInput = (
  input: MemberProvisionInput,
): NormalizedMemberProvisionInput => {
  if (input.acknowledgement !== MEMBER_PROVISION_ACKNOWLEDGEMENT)
    throw new Error(
      `MEMBER_PROVISION_ACKNOWLEDGEMENT must equal ${MEMBER_PROVISION_ACKNOWLEDGEMENT}`,
    );
  if (input.role === "OWNER")
    throw new Error("MEMBER_PROVISION_ROLE may not be OWNER");
  if (!MEMBER_PROVISION_ROLES.includes(input.role as MemberProvisionRole))
    throw new Error(
      "MEMBER_PROVISION_ROLE must be ADMIN, PUBLISHER, or VIEWER",
    );

  const organizationSlug = bounded(
    input.organizationSlug,
    "MEMBER_PROVISION_ORGANIZATION_SLUG",
    100,
  );
  const name = bounded(input.name, "MEMBER_PROVISION_NAME", 100);
  const reason = bounded(input.reason, "MEMBER_PROVISION_REASON", 500);
  const normalizedEmail = input.email.trim().toLowerCase();
  if (!emailSchema.safeParse(normalizedEmail).success)
    throw new Error("MEMBER_PROVISION_EMAIL must be a valid email address");

  rejectPlaceholder(organizationSlug, "MEMBER_PROVISION_ORGANIZATION_SLUG");
  rejectPlaceholder(normalizedEmail, "MEMBER_PROVISION_EMAIL");
  rejectPlaceholder(name, "MEMBER_PROVISION_NAME");
  rejectPlaceholder(reason, "MEMBER_PROVISION_REASON");
  rejectPlaceholder(
    input.temporaryPassword,
    "MEMBER_PROVISION_TEMPORARY_PASSWORD",
  );
  validateTemporaryPassword(
    input.temporaryPassword,
    "MEMBER_PROVISION_TEMPORARY_PASSWORD",
  );

  return {
    organizationSlug,
    normalizedEmail,
    name,
    role: input.role as MemberProvisionRole,
    temporaryPassword: input.temporaryPassword,
    reason,
  };
};

const provisionMetadata = (
  input: NormalizedMemberProvisionInput,
  grantCount: number,
): Prisma.InputJsonObject => ({
  source: MEMBER_PROVISION_SOURCE,
  version: MEMBER_PROVISION_VERSION,
  role: input.role,
  reason: input.reason,
  bootstrapWindowHours: 24,
  grantCount,
});

const containmentMetadata = (): Prisma.InputJsonObject => ({
  source: MEMBER_PROVISION_SOURCE,
  version: MEMBER_PROVISION_VERSION,
  previousCredentialPreserved: false,
  authenticationEpochAdvanced: false,
  sessionsRevoked: false,
  bootstrapWindowHours: 24,
});

const exactJson = (
  actual: Prisma.JsonValue,
  expected: Prisma.InputJsonObject,
) => isDeepStrictEqual(actual, expected);

const datesEqual = (left: Date, right: Date) =>
  left.getTime() === right.getTime();

const exactlyOneDayAfter = (later: Date, earlier: Date) =>
  later.getTime() - earlier.getTime() === 24 * 60 * 60 * 1000;

export const provisionMember = async (
  prisma: ProvisioningPrisma,
  rawInput: MemberProvisionInput,
): Promise<MemberProvisionResult> => {
  // Validate OWNER and every operator-controlled scalar before allocating a
  // bcrypt hash or opening a database transaction.
  const input = normalizeMemberProvisionInput(rawInput);
  const passwordHash = await hash(input.temporaryPassword, BCRYPT_COST);

  // A waiter can establish a SERIALIZABLE snapshot before the holder commits.
  // Retry the database's explicit serialization failure with a fresh snapshot;
  // all other conflicts remain fail-closed.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const lockIdentity = `ScreenGoblin member provision identity v1\n${Buffer.byteLength(input.normalizedEmail, "utf8")}:${input.normalizedEmail}`;
          const lockRows = await tx.$queryRaw<
            Array<{ acquired: number }>
          >`SELECT 1::integer AS acquired
          FROM pg_advisory_xact_lock(hashtextextended(${lockIdentity}, 0))`;
          if (lockRows[0]?.acquired !== 1)
            throw new Error("Member provisioning lock was unavailable");

          const organization = await tx.organization.findUnique({
            where: { slug: input.organizationSlug },
            select: { id: true, slug: true },
          });
          if (!organization)
            throw new Error("MEMBER_PROVISION_ORGANIZATION_SLUG must exist");

          const [clock] = await tx.$queryRaw<
            Array<{ databaseNow: Date; bootstrapDeadline: Date }>
          >`SELECT CURRENT_TIMESTAMP AS "databaseNow",
               CURRENT_TIMESTAMP + INTERVAL '24 hours' AS "bootstrapDeadline"`;
          if (!clock) throw new Error("Database clock was unavailable");

          const existingRows = await tx.$queryRaw<
            Array<{
              id: string;
              email: string;
              name: string;
              passwordHash: string;
              authenticationEpoch: number;
              bootstrapPasswordExpiresAt: Date | null;
              disabledAt: Date | null;
              createdAt: Date;
              updatedAt: Date;
            }>
          >`SELECT actor."id",
               actor."email",
               actor."name",
               actor."passwordHash",
               actor."authenticationEpoch",
               actor."bootstrapPasswordExpiresAt",
               actor."disabledAt",
               actor."createdAt",
               actor."updatedAt"
          FROM "User" actor
         WHERE LOWER(actor."email") = ${input.normalizedEmail}
         ORDER BY actor."id" ASC
         FOR UPDATE`;

          if (existingRows.length > 1)
            throw new Error(
              "Normalized member email resolves to multiple identities",
            );
          const existing = existingRows[0];
          if (existing) {
            const memberships = await tx.membership.findMany({
              where: { userId: existing.id },
              orderBy: [{ organizationId: "asc" }, { id: "asc" }],
            });
            const membership = memberships[0];
            const grants = await tx.accessGrant.findMany({
              where: { subjectUserId: existing.id },
              orderBy: { id: "asc" },
            });
            const audits = await tx.auditEvent.findMany({
              where: {
                organizationId: organization.id,
                actorType: "system",
                OR: [
                  {
                    action: MEMBER_PROVISION_ACTION,
                    entityType: "membership",
                    entityId: membership?.id ?? "",
                  },
                  {
                    action: MEMBER_PROVISION_CONTAINMENT_ACTION,
                    entityType: "user",
                    entityId: existing.id,
                  },
                ],
              },
              orderBy: [{ action: "asc" }, { id: "asc" }],
            });
            const expectedCapabilities = compatibilityGrantCapabilities(
              input.role,
            );
            const expectedGrantIds = expectedCapabilities
              .map((capability) =>
                membership
                  ? compatibilityGrantId(
                      organization.id,
                      membership.id,
                      membership.authorizationEpoch,
                      capability,
                    )
                  : "",
              )
              .sort();
            const actualGrantIds = grants.map(({ id }) => id).sort();
            const provisionAudit = audits.find(
              ({ action }) => action === MEMBER_PROVISION_ACTION,
            );
            const containmentAudit = audits.find(
              ({ action }) => action === MEMBER_PROVISION_CONTAINMENT_ACTION,
            );
            const exactState =
              existing.email === input.normalizedEmail &&
              existing.name === input.name &&
              existing.authenticationEpoch === 0 &&
              existing.disabledAt === null &&
              datesEqual(existing.updatedAt, existing.createdAt) &&
              existing.bootstrapPasswordExpiresAt !== null &&
              existing.bootstrapPasswordExpiresAt > clock.databaseNow &&
              exactlyOneDayAfter(
                existing.bootstrapPasswordExpiresAt,
                existing.createdAt,
              ) &&
              memberships.length === 1 &&
              membership?.organizationId === organization.id &&
              membership.role === input.role &&
              membership.authorizationEpoch === 0 &&
              grants.length === expectedGrantIds.length &&
              isDeepStrictEqual(actualGrantIds, expectedGrantIds) &&
              grants.every(
                (grant) =>
                  grant.organizationId === organization.id &&
                  grant.subjectUserId === existing.id &&
                  grant.subjectMembershipId === membership.id &&
                  grant.scopeType === "ORGANIZATION" &&
                  grant.locationId === null &&
                  grant.screenGroupId === null &&
                  grant.screenId === null &&
                  grant.expiresAt === null &&
                  grant.revokedAt === null &&
                  grant.creatorKind === "SYSTEM" &&
                  grant.createdByUserId === null &&
                  grant.createdBySystemKey === COMPATIBILITY_GRANT_SYSTEM_KEY &&
                  datesEqual(grant.startsAt, existing.createdAt) &&
                  datesEqual(grant.createdAt, existing.createdAt),
              ) &&
              audits.length === 2 &&
              provisionAudit !== undefined &&
              containmentAudit !== undefined &&
              provisionAudit.actorUserId === null &&
              provisionAudit.entityType === "membership" &&
              provisionAudit.entityId === membership.id &&
              containmentAudit.actorUserId === null &&
              containmentAudit.entityType === "user" &&
              containmentAudit.entityId === existing.id &&
              datesEqual(provisionAudit.createdAt, existing.createdAt) &&
              datesEqual(containmentAudit.createdAt, existing.createdAt) &&
              exactJson(
                provisionAudit.metadata,
                provisionMetadata(input, expectedCapabilities.length),
              ) &&
              exactJson(containmentAudit.metadata, containmentMetadata()) &&
              (await compare(input.temporaryPassword, existing.passwordHash));

            if (!exactState)
              throw new Error(
                "Member email already exists without an exact active provisioning marker; refusing to change identity or privileges",
              );
            return {
              status: "UNCHANGED",
              userId: existing.id,
              membershipId: membership.id,
              organizationId: organization.id,
              normalizedEmail: input.normalizedEmail,
              role: input.role,
              changeBefore: existing.bootstrapPasswordExpiresAt!,
            };
          }

          const created = await tx.user.create({
            data: {
              email: input.normalizedEmail,
              name: input.name,
              passwordHash,
              bootstrapPasswordExpiresAt: clock.bootstrapDeadline,
              createdAt: clock.databaseNow,
              updatedAt: clock.databaseNow,
              memberships: {
                create: { organizationId: organization.id, role: input.role },
              },
            },
            include: { memberships: true },
          });
          const membership = created.memberships[0];
          if (
            created.memberships.length !== 1 ||
            !membership ||
            membership.organizationId !== organization.id ||
            membership.authorizationEpoch !== 0
          )
            throw new Error(
              "Member provisioning did not create one exact membership",
            );

          const grantCapabilities = compatibilityGrantCapabilities(input.role);
          await tx.accessGrant.createMany({
            data: grantCapabilities.map((capability) => ({
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
              startsAt: clock.databaseNow,
              createdAt: clock.databaseNow,
            })),
          });
          await tx.auditEvent.createMany({
            data: [
              {
                organizationId: organization.id,
                actorType: "system",
                action: MEMBER_PROVISION_ACTION,
                entityType: "membership",
                entityId: membership.id,
                metadata: provisionMetadata(input, grantCapabilities.length),
                createdAt: clock.databaseNow,
              },
              {
                organizationId: organization.id,
                actorType: "system",
                action: MEMBER_PROVISION_CONTAINMENT_ACTION,
                entityType: "user",
                entityId: created.id,
                metadata: containmentMetadata(),
                createdAt: clock.databaseNow,
              },
            ],
          });
          return {
            status: "CREATED",
            userId: created.id,
            membershipId: membership.id,
            organizationId: organization.id,
            normalizedEmail: input.normalizedEmail,
            role: input.role,
            changeBefore: clock.bootstrapDeadline,
          };
        },
        { isolationLevel: "Serializable" },
      );
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : undefined;
      if (code !== "P2034" || attempt === 3) throw error;
    }
  }
  throw new Error("Member provisioning serialization retry was exhausted");
};
