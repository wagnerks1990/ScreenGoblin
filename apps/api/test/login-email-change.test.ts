import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  changeOwnerLoginEmail,
  LOGIN_EMAIL_CHANGE_ACKNOWLEDGEMENT,
} from "../src/identity/change-login-email.js";

const input = {
  acknowledgement: LOGIN_EMAIL_CHANGE_ACKNOWLEDGEMENT,
  currentEmail: " OWNER@Example.Test ",
  newEmail: " NEW@Example.Test ",
  reason: "Operator requested login change",
};
const row = {
  userId: "owner",
  organizationId: "org-a",
  role: "OWNER",
  disabledAt: null as Date | null,
  databaseNow: new Date(),
};
const fixture = (
  rows = [row, { ...row, organizationId: "org-b", role: "ADMIN" }],
) => {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue(rows),
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    userSession: { updateMany: vi.fn() },
    pairingCode: {
      findMany: vi.fn().mockResolvedValue([{ id: "grant" }]),
      updateMany: vi.fn(),
    },
    pairingAttempt: { updateMany: vi.fn() },
    auditEvent: { createMany: vi.fn() },
  };
  const transaction = vi.fn(async (operation) => operation(tx));
  return {
    tx,
    transaction,
    prisma: { $transaction: transaction } as unknown as Pick<
      PrismaClient,
      "$transaction"
    >,
  };
};
describe("offline owner login email change", () => {
  it("normalizes identity, revokes authority across memberships, and preserves password and bootstrap deadline", async () => {
    const { prisma, tx } = fixture();
    await expect(changeOwnerLoginEmail(prisma, input)).resolves.toEqual({
      affectedOrganizationCount: 2,
    });
    expect(tx.$queryRaw.mock.calls[0]?.[1]).toBe("owner@example.test");
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "owner" },
      data: {
        email: "new@example.test",
        authenticationEpoch: { increment: 1 },
      },
    });
    expect(tx.userSession.updateMany).toHaveBeenCalledWith({
      where: { userId: "owner", revokedAt: null },
      data: { revokedAt: row.databaseNow },
    });
    expect(tx.pairingCode.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: { in: ["org-a", "org-b"] },
        authorizedByUserId: "owner",
        status: "PENDING",
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    expect(tx.pairingAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        pairingCodeId: { in: ["grant"] },
        boundCredentialId: null,
        cancelledAt: null,
      },
      data: { cancelledAt: row.databaseNow },
    });
    expect(tx.pairingCode.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["grant"] }, status: "PENDING" },
      data: { status: "REVOKED" },
    });
    const audits = tx.auditEvent.createMany.mock.calls[0]?.[0].data;
    expect(
      audits.map((audit: { organizationId: string }) => audit.organizationId),
    ).toEqual(["org-a", "org-b"]);
    expect(JSON.stringify(audits)).not.toContain("example.test");
  });
  it.each([
    { acknowledgement: "" },
    { newEmail: "invalid" },
    { currentEmail: "invalid" },
    { newEmail: "owner@example.test" },
    { reason: " " },
    { reason: "x".repeat(501) },
  ])(
    "rejects invalid or unchanged input before opening a transaction: %j",
    async (patch) => {
      const { prisma, transaction } = fixture();
      await expect(
        changeOwnerLoginEmail(prisma, { ...input, ...patch }),
      ).rejects.toThrow();
      expect(transaction).not.toHaveBeenCalled();
    },
  );
  it.each([
    [],
    [{ ...row, role: "ADMIN" }],
    [{ ...row, disabledAt: new Date() }],
    [row, { ...row, userId: "another-owner" }],
  ])(
    "rejects missing, non-owner, disabled, and ambiguous targets",
    async (...rows) => {
      const { prisma, tx } = fixture(rows as (typeof row)[]);
      await expect(changeOwnerLoginEmail(prisma, input)).rejects.toThrow(
        "Target must be one active existing owner",
      );
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(tx.auditEvent.createMany).not.toHaveBeenCalled();
    },
  );
  it("rejects an occupied destination before changing authority", async () => {
    const { prisma, tx } = fixture();
    tx.user.findUnique.mockResolvedValueOnce({ id: "other-user" });
    await expect(changeOwnerLoginEmail(prisma, input)).rejects.toThrow(
      "unavailable",
    );
    expect(tx.pairingCode.findMany).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
  });
  it("propagates audit failures to abort the enclosing transaction", async () => {
    const { prisma, tx } = fixture();
    tx.auditEvent.createMany.mockRejectedValueOnce(
      new Error("audit unavailable"),
    );
    await expect(changeOwnerLoginEmail(prisma, input)).rejects.toThrow(
      "audit unavailable",
    );
  });
});
