import type { PrismaClient } from "@prisma/client";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  MEMBER_PROVISION_ACKNOWLEDGEMENT,
  normalizeMemberProvisionInput,
  provisionMember,
} from "../src/identity/member-provisioning.js";

const validInput = {
  acknowledgement: MEMBER_PROVISION_ACKNOWLEDGEMENT,
  organizationSlug: "  ACME-SIGNS  ",
  email: "  PUBLISHER@Example.Test  ",
  name: "  Release Publisher  ",
  role: "PUBLISHER" as const,
  temporaryPassword: "temporary-member-password-2026",
  reason: "  Establish maker-checker release operations.  ",
};

const transactionSpy = () => {
  const transaction = vi.fn();
  return {
    prisma: { $transaction: transaction } as unknown as Pick<
      PrismaClient,
      "$transaction"
    >,
    transaction,
  };
};

describe("offline member provisioning input", () => {
  it("normalizes operator-controlled identifiers and free text", () => {
    expect(normalizeMemberProvisionInput(validInput)).toEqual({
      organizationSlug: "ACME-SIGNS",
      normalizedEmail: "publisher@example.test",
      name: "Release Publisher",
      role: "PUBLISHER",
      temporaryPassword: validInput.temporaryPassword,
      reason: "Establish maker-checker release operations.",
    });
  });

  it.each(["ADMIN", "PUBLISHER", "VIEWER"] as const)(
    "accepts the non-owner %s role",
    (role) => {
      expect(normalizeMemberProvisionInput({ ...validInput, role }).role).toBe(
        role,
      );
    },
  );

  it.each([
    ["an invalid acknowledgement", { acknowledgement: "provision it" }],
    ["the OWNER role", { role: "OWNER" }],
    ["an unknown role", { role: "OPERATOR" }],
    ["an empty organization slug", { organizationSlug: " \t " }],
    ["an overlong organization slug", { organizationSlug: "s".repeat(101) }],
    ["an empty name", { name: " \t " }],
    ["an overlong name", { name: "n".repeat(101) }],
    ["an empty reason", { reason: " \t " }],
    ["an overlong reason", { reason: "r".repeat(501) }],
    ["an empty email", { email: " \t " }],
    ["an email without an at-sign", { email: "not-an-email" }],
    [
      "an overlong normalized email",
      { email: `${"e".repeat(309)}@example.test` },
    ],
    ["a short password", { temporaryPassword: "fifteen-chars!!" }],
    ["an overlong UTF-8 password", { temporaryPassword: "👺".repeat(19) }],
  ])("rejects %s before opening a transaction", async (_name, patch) => {
    const { prisma, transaction } = transactionSpy();

    await expect(
      provisionMember(prisma, { ...validInput, ...patch } as typeof validInput),
    ).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("accepts exact scalar bounds and a 72-byte Unicode password", () => {
    const normalized = normalizeMemberProvisionInput({
      ...validInput,
      organizationSlug: "s".repeat(100),
      email: `${"e".repeat(307)}@example.test`,
      name: "n".repeat(100),
      temporaryPassword: "👺".repeat(18),
      reason: "r".repeat(500),
    });

    expect(normalized.organizationSlug).toHaveLength(100);
    expect(normalized.normalizedEmail).toHaveLength(320);
    expect(Buffer.byteLength(normalized.temporaryPassword, "utf8")).toBe(72);
    expect(normalized.name).toHaveLength(100);
    expect(normalized.reason).toHaveLength(500);
  });

  it("does not trim or case-fold the supplied password", () => {
    const temporaryPassword = "  Temporary-Password-2026  ";
    expect(
      normalizeMemberProvisionInput({ ...validInput, temporaryPassword })
        .temporaryPassword,
    ).toBe(temporaryPassword);
  });

  it("keeps the command output free of the supplied password and its hash", async () => {
    const source = await readFile(
      new URL("../prisma/provision-member.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /console\.(?:log|error)\([^)]*temporaryPassword/s,
    );
    expect(source).not.toMatch(/console\.(?:log|error)\([^)]*passwordHash/s);
    const consoleCalls = source.match(/console\.(?:log|error)\([\s\S]*?\);/g);
    expect(consoleCalls).toHaveLength(1);
    expect(consoleCalls?.[0]).not.toMatch(
      /process\.env|MEMBER_PROVISION_TEMPORARY_PASSWORD|\binput\b/,
    );
  });
});
