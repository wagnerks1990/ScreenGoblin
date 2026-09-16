import type { PrismaClient } from "@prisma/client";
import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const approvedPasswordHash =
  "$2b$12$C6UzMDM.H6dfI/f/IKcEe.82jG7y4g4AY8I8HibLFSWafVkx8S4hS";
const hash = vi.fn(async () => approvedPasswordHash);
const compare = vi.fn(async () => false);

vi.mock("bcryptjs", () => ({ compare, hash }));

const { BOOTSTRAP_RECOVERY_ACKNOWLEDGEMENT, recoverBootstrapPassword } =
  await import("../src/recovery/bootstrap-password.js");

const recoveryInput = {
  acknowledgement: BOOTSTRAP_RECOVERY_ACKNOWLEDGEMENT,
  email: "  OWNER@Example.Test ",
  temporaryPassword: "temporary-owner-password-2026",
};

type RecoveryRow = {
  userId: string;
  organizationId: string;
  role: "OWNER" | "ADMIN" | "PUBLISHER" | "VIEWER";
  passwordHash: string;
  disabledAt: Date | null;
  databaseNow: Date;
  changeBefore: Date;
};

const recoveryRow: RecoveryRow = {
  userId: "user-owner",
  organizationId: "org-a",
  role: "OWNER" as const,
  passwordHash: "$2b$12$current-password-hash",
  disabledAt: null,
  databaseNow: new Date("2026-09-16T12:00:00.000Z"),
  changeBefore: new Date("2026-09-16T12:30:00.000Z"),
};

const fakePrisma = (
  memberships: RecoveryRow[] = [
    recoveryRow,
    { ...recoveryRow, organizationId: "org-b", role: "ADMIN" },
  ],
) => {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue(memberships),
    pairingCode: {
      findMany: vi.fn().mockResolvedValue([{ id: "pending-grant" }]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    pairingAttempt: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: { update: vi.fn().mockResolvedValue({}) },
    userSession: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
    auditEvent: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
  };
  const prisma = {
    $transaction: vi.fn(async (operation) => operation(tx)),
  } as unknown as Pick<PrismaClient, "$transaction">;
  return { prisma, tx };
};

describe("offline bootstrap password recovery", () => {
  beforeEach(() => {
    hash.mockClear();
    compare.mockReset();
    compare.mockResolvedValue(false);
  });

  it("atomically resets one active owner and revokes every authority source", async () => {
    const { prisma, tx } = fakePrisma();

    await expect(
      recoverBootstrapPassword(prisma, recoveryInput),
    ).resolves.toEqual({
      userId: "user-owner",
      normalizedEmail: "owner@example.test",
      affectedOrganizationCount: 2,
      changeBefore: recoveryRow.changeBefore,
    });

    expect(compare).toHaveBeenCalledWith(
      recoveryInput.temporaryPassword,
      recoveryRow.passwordHash,
    );
    expect(hash).toHaveBeenCalledWith(recoveryInput.temporaryPassword, 12);
    expect(tx.$queryRaw.mock.calls[0]?.[1]).toBe("owner@example.test");
    expect(tx.pairingCode.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: { in: ["org-a", "org-b"] },
        authorizedByUserId: "user-owner",
        status: "PENDING",
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    expect(tx.pairingAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        pairingCodeId: { in: ["pending-grant"] },
        boundCredentialId: null,
        cancelledAt: null,
      },
      data: { cancelledAt: recoveryRow.databaseNow },
    });
    expect(tx.pairingCode.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["pending-grant"] }, status: "PENDING" },
      data: { status: "REVOKED" },
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "user-owner" },
      data: {
        passwordHash: approvedPasswordHash,
        bootstrapPasswordExpiresAt: recoveryRow.changeBefore,
        authenticationEpoch: { increment: 1 },
      },
    });
    expect(tx.userSession.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-owner", revokedAt: null },
      data: { revokedAt: recoveryRow.databaseNow },
    });
    const auditData = tx.auditEvent.createMany.mock.calls[0]?.[0].data;
    expect(auditData).toHaveLength(2);
    expect(auditData).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          organizationId: "org-a",
          actorType: "system",
          action: "auth.bootstrap_password_recovery_issued",
          entityId: "user-owner",
        }),
        expect.objectContaining({ organizationId: "org-b" }),
      ]),
    );
    expect(JSON.stringify(auditData)).not.toContain(
      recoveryInput.temporaryPassword,
    );
    expect(JSON.stringify(auditData)).not.toContain(approvedPasswordHash);
  });

  it.each([
    ["missing acknowledgement", { acknowledgement: "" }],
    ["short password", { temporaryPassword: "fifteen-chars!!" }],
    ["overlong UTF-8 password", { temporaryPassword: "👺".repeat(19) }],
  ])("rejects %s before opening a transaction", async (_name, patch) => {
    const { prisma } = fakePrisma();

    await expect(
      recoverBootstrapPassword(prisma, { ...recoveryInput, ...patch }),
    ).rejects.toThrow();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("accepts a 72-byte Unicode temporary password", async () => {
    const { prisma } = fakePrisma();
    await expect(
      recoverBootstrapPassword(prisma, {
        ...recoveryInput,
        temporaryPassword: "👺".repeat(18),
      }),
    ).resolves.toBeDefined();
  });

  it("rejects a temporary password that is bcrypt-equivalent to the current credential", async () => {
    const { prisma, tx } = fakePrisma();
    compare.mockResolvedValueOnce(true);

    await expect(
      recoverBootstrapPassword(prisma, recoveryInput),
    ).rejects.toThrow("must differ from the current password");
    expect(hash).not.toHaveBeenCalled();
    expect(tx.pairingCode.findMany).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.userSession.updateMany).not.toHaveBeenCalled();
    expect(tx.auditEvent.createMany).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-owner", [{ ...recoveryRow, role: "ADMIN" as const }]],
    ["a disabled owner", [{ ...recoveryRow, disabledAt: new Date() }]],
    [
      "ambiguous case-folded identities",
      [recoveryRow, { ...recoveryRow, userId: "different-user" }],
    ],
    ["a missing identity", []],
  ])(
    "fails closed for %s without mutating identity state",
    async (_name, rows) => {
      const { prisma, tx } = fakePrisma(rows);

      await expect(
        recoverBootstrapPassword(prisma, recoveryInput),
      ).rejects.toThrow(
        "Recovery target must be one active existing user with an OWNER membership",
      );
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(tx.userSession.updateMany).not.toHaveBeenCalled();
      expect(tx.auditEvent.createMany).not.toHaveBeenCalled();
    },
  );

  it("keeps the command output free of the supplied password and hash", async () => {
    const source = await readFile(
      new URL("../prisma/recover-bootstrap-password.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /console\.(?:log|error)\([^)]*temporaryPassword/s,
    );
    expect(source).not.toMatch(/console\.(?:log|error)\([^)]*passwordHash/s);
  });
});
