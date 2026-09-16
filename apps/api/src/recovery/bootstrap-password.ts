import type { Prisma, PrismaClient } from "@prisma/client";
import { compare, hash } from "bcryptjs";

export const BOOTSTRAP_RECOVERY_ACKNOWLEDGEMENT =
  "I_UNDERSTAND_THIS_RESETS_AN_OWNER_PASSWORD";
export const BOOTSTRAP_RECOVERY_WINDOW_MINUTES = 30;

const recoveryAuditAction = "auth.bootstrap_password_recovery_issued";

export type BootstrapPasswordRecoveryInput = {
  acknowledgement: string;
  email: string;
  temporaryPassword: string;
};

export type BootstrapPasswordRecoveryResult = {
  userId: string;
  normalizedEmail: string;
  affectedOrganizationCount: number;
  changeBefore: Date;
};

type RecoveryPrisma = Pick<PrismaClient, "$transaction">;

const normalizeRecoveryInput = (input: BootstrapPasswordRecoveryInput) => {
  if (input.acknowledgement !== BOOTSTRAP_RECOVERY_ACKNOWLEDGEMENT)
    throw new Error(
      `BOOTSTRAP_RECOVERY_ACKNOWLEDGEMENT must equal ${BOOTSTRAP_RECOVERY_ACKNOWLEDGEMENT}`,
    );
  const normalizedEmail = input.email.trim().toLowerCase();
  if (
    normalizedEmail.length === 0 ||
    normalizedEmail.length > 254 ||
    !normalizedEmail.includes("@")
  )
    throw new Error(
      "BOOTSTRAP_RECOVERY_EMAIL must identify one existing owner",
    );
  const codePointLength = Array.from(input.temporaryPassword).length;
  const byteLength = Buffer.byteLength(input.temporaryPassword, "utf8");
  if (codePointLength < 16 || byteLength > 72)
    throw new Error(
      "BOOTSTRAP_RECOVERY_TEMPORARY_PASSWORD must contain at least 16 Unicode code points and at most 72 UTF-8 bytes",
    );
  return { normalizedEmail, temporaryPassword: input.temporaryPassword };
};

export const recoverBootstrapPassword = async (
  prisma: RecoveryPrisma,
  input: BootstrapPasswordRecoveryInput,
): Promise<BootstrapPasswordRecoveryResult> => {
  const { normalizedEmail, temporaryPassword } = normalizeRecoveryInput(input);

  return prisma.$transaction(async (tx) => {
    const memberships = await tx.$queryRaw<
      Array<{
        userId: string;
        organizationId: string;
        role: "OWNER" | "ADMIN" | "PUBLISHER" | "VIEWER";
        passwordHash: string;
        disabledAt: Date | null;
        databaseNow: Date;
        changeBefore: Date;
      }>
    >`
      SELECT actor."id" AS "userId",
             membership."organizationId",
             membership."role",
             actor."passwordHash",
             actor."disabledAt",
             CURRENT_TIMESTAMP AS "databaseNow",
             CURRENT_TIMESTAMP + INTERVAL '30 minutes' AS "changeBefore"
      FROM "User" actor
      INNER JOIN "Membership" membership ON membership."userId" = actor."id"
      WHERE LOWER(actor."email") = ${normalizedEmail}
      ORDER BY actor."id" ASC, membership."organizationId" ASC
      FOR UPDATE OF actor, membership`;
    const userIds = new Set(memberships.map(({ userId }) => userId));
    const target = memberships[0];
    if (
      !target ||
      userIds.size !== 1 ||
      target.disabledAt !== null ||
      !memberships.some(({ role }) => role === "OWNER")
    )
      throw new Error(
        "Recovery target must be one active existing user with an OWNER membership",
      );
    if (await compare(temporaryPassword, target.passwordHash))
      throw new Error(
        "BOOTSTRAP_RECOVERY_TEMPORARY_PASSWORD must differ from the current password",
      );
    const passwordHash = await hash(temporaryPassword, 12);

    const organizationIds = memberships.map(
      ({ organizationId }) => organizationId,
    );
    const pendingGrants = await tx.pairingCode.findMany({
      where: {
        organizationId: { in: organizationIds },
        authorizedByUserId: target.userId,
        status: "PENDING",
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    const pendingGrantIds = pendingGrants.map(({ id }) => id);
    await tx.pairingAttempt.updateMany({
      where: {
        pairingCodeId: { in: pendingGrantIds },
        boundCredentialId: null,
        cancelledAt: null,
      },
      data: { cancelledAt: target.databaseNow },
    });
    await tx.pairingCode.updateMany({
      where: { id: { in: pendingGrantIds }, status: "PENDING" },
      data: { status: "REVOKED" },
    });
    await tx.user.update({
      where: { id: target.userId },
      data: {
        passwordHash,
        bootstrapPasswordExpiresAt: target.changeBefore,
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
        action: recoveryAuditAction,
        entityType: "user",
        entityId: target.userId,
        metadata: {
          source: "offline-operator-recovery",
          authenticationEpochAdvanced: true,
          sessionsRevoked: true,
          pendingIssuerAuthorityRevoked: true,
          rotationWindowMinutes: BOOTSTRAP_RECOVERY_WINDOW_MINUTES,
        } satisfies Prisma.InputJsonValue,
      })),
    });

    return {
      userId: target.userId,
      normalizedEmail,
      affectedOrganizationCount: organizationIds.length,
      changeBefore: target.changeBefore,
    };
  });
};
