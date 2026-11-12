import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";

export const LOGIN_EMAIL_CHANGE_ACKNOWLEDGEMENT =
  "I_UNDERSTAND_THIS_CHANGES_AN_OWNER_LOGIN";

export type LoginEmailChangeInput = {
  acknowledgement: string;
  currentEmail: string;
  newEmail: string;
  reason: string;
};

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const inputSchema = z
  .object({
    acknowledgement: z.literal(LOGIN_EMAIL_CHANGE_ACKNOWLEDGEMENT),
    currentEmail: email,
    newEmail: email,
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const changeOwnerLoginEmail = async (
  prisma: Pick<PrismaClient, "$transaction">,
  input: LoginEmailChangeInput,
) => {
  const normalized = inputSchema.parse(input);
  if (normalized.currentEmail === normalized.newEmail)
    throw new Error("The new login email must differ from the current email");

  return prisma.$transaction(async (tx) => {
    const memberships = await tx.$queryRaw<
      Array<{
        userId: string;
        organizationId: string;
        role: string;
        disabledAt: Date | null;
        databaseNow: Date;
      }>
    >`
      SELECT actor."id" AS "userId", membership."organizationId",
             membership."role"::text AS "role", actor."disabledAt",
             CURRENT_TIMESTAMP AS "databaseNow"
      FROM "User" actor
      INNER JOIN "Membership" membership ON membership."userId" = actor."id"
      WHERE LOWER(actor."email") = ${normalized.currentEmail}
      ORDER BY actor."id" ASC, membership."organizationId" ASC
      FOR UPDATE OF actor, membership`;
    const target = memberships[0];
    if (
      !target ||
      new Set(memberships.map((row) => row.userId)).size !== 1 ||
      target.disabledAt !== null ||
      !memberships.some((row) => row.role === "OWNER")
    )
      throw new Error("Target must be one active existing owner");
    if (
      await tx.user.findUnique({
        where: { email: normalized.newEmail },
        select: { id: true },
      })
    )
      throw new Error("Destination login email is unavailable");

    const organizationIds = memberships.map((row) => row.organizationId);
    const grants = await tx.pairingCode.findMany({
      where: {
        organizationId: { in: organizationIds },
        authorizedByUserId: target.userId,
        status: "PENDING",
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    const grantIds = grants.map((row) => row.id);
    await tx.pairingAttempt.updateMany({
      where: {
        pairingCodeId: { in: grantIds },
        boundCredentialId: null,
        cancelledAt: null,
      },
      data: { cancelledAt: target.databaseNow },
    });
    await tx.pairingCode.updateMany({
      where: { id: { in: grantIds }, status: "PENDING" },
      data: { status: "REVOKED" },
    });
    await tx.user.update({
      where: { id: target.userId },
      data: {
        email: normalized.newEmail,
        authenticationEpoch: { increment: 1 },
      },
    });
    await tx.userSession.updateMany({
      where: { userId: target.userId, revokedAt: null },
      data: { revokedAt: target.databaseNow },
    });
    await tx.auditEvent.createMany({
      data: organizationIds.map((organizationId) => ({
        organizationId,
        actorType: "system",
        action: "identity.login_email_changed",
        entityType: "user",
        entityId: target.userId,
        metadata: {
          source: "offline-operator-email-change",
          reason: normalized.reason,
          authenticationEpochAdvanced: true,
          sessionsRevoked: true,
          pendingIssuerAuthorityRevoked: true,
        } satisfies Prisma.InputJsonValue,
      })),
    });
    return { affectedOrganizationCount: organizationIds.length };
  });
};
