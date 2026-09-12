import type { PrismaClient } from "@prisma/client";
import { getRounds } from "bcryptjs";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../src/store/memory.js";
import { PrismaStore } from "../src/store/prisma.js";
import type {
  AuditRecord,
  DataStore,
  SessionUser,
} from "../src/domain/types.js";
import { verifyLoginCredentials } from "../src/routes/auth.js";

const approvedPasswordHash =
  "$2b$12$C6UzMDM.H6dfI/f/IKcEe.82jG7y4g4AY8I8HibLFSWafVkx8S4hS";

const sessionUser = (id: string, email: string, organizationId: string) => ({
  id,
  email,
  name: `User ${id}`,
  passwordHash: `hash-${id}`,
  organizationId,
  role: "OWNER" as const,
  authenticationEpoch: 0,
  authorizationEpoch: 0,
});

const prismaLoginRow = (id: string, email: string) => ({
  id,
  email,
  name: `User ${id}`,
  passwordHash: `hash-${id}`,
  authenticationEpoch: 0,
  disabledAt: null,
  organizationId: "org-a",
  role: "OWNER" as const,
  authorizationEpoch: 0,
});

describe("owner continuity lock contract", () => {
  it("uses the FK-compatible PostgreSQL tenant lock mode", async () => {
    const source = await readFile(
      new URL("../src/store/prisma.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("private async lockOwnerContinuity(");
    const end = source.indexOf("private async hasOtherActiveOwner(", start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const implementation = source.slice(start, end);
    expect(implementation).toContain("FOR NO KEY UPDATE OF organization");
    expect(implementation).not.toMatch(/\bFOR UPDATE\b/);
  });
});

describe("case-insensitive user identity lookup", () => {
  it("fails closed in memory when case variants identify different users", async () => {
    const store = new MemoryStore();
    store.users.push(
      sessionUser("user-a", "Owner@example.test", "org-a"),
      sessionUser("user-b", "owner@example.test", "org-b"),
    );

    await expect(
      store.findUserByEmail("OWNER@example.test"),
    ).resolves.toBeNull();
  });

  it("fails closed in memory when flattened membership data disagrees on identity", async () => {
    const store = new MemoryStore();
    store.users.push(sessionUser("user-a", "owner@example.test", "org-a"), {
      ...sessionUser("user-a", "owner@example.test", "org-b"),
      passwordHash: "different-hash",
    });

    await expect(
      store.findUserByEmail("owner@example.test"),
    ).resolves.toBeNull();
  });

  it("keeps active, disabled, and absent identity eligibility aligned in memory", async () => {
    const store = new MemoryStore();
    const active = sessionUser("user-active", "active@example.test", "org-a");
    const disabled = {
      ...sessionUser("user-disabled", "disabled@example.test", "org-a"),
      disabledAt: "2026-09-12T00:00:00.000Z",
    };
    store.users.push(active, disabled);

    await expect(store.findUserByEmail("ACTIVE@example.test")).resolves.toEqual(
      active,
    );
    await expect(
      store.findUserByEmail("DISABLED@example.test"),
    ).resolves.toBeNull();
    await expect(
      store.findUserByEmail("membershipless@example.test"),
    ).resolves.toBeNull();
    await expect(
      store.findUserByEmail("unknown@example.test"),
    ).resolves.toBeNull();
  });

  it("uses one SQL statement and rejects ambiguous IDs", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValue([
        prismaLoginRow("user-a", "owner@example.test"),
        prismaLoginRow("user-b", "owner@example.test"),
      ]);
    const prisma = {
      $queryRaw: queryRaw,
    } as unknown as PrismaClient;

    await expect(
      new PrismaStore(prisma).findUserByEmail("owner@example.test"),
    ).resolves.toBeNull();
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(queryRaw.mock.calls[0]?.[1]).toBe("owner@example.test");
  });

  it("uses the same single-statement lookup shape for every login eligibility class", async () => {
    const active = prismaLoginRow("user-active", "active@example.test");
    const disabled = {
      ...prismaLoginRow("user-disabled", "disabled@example.test"),
      disabledAt: new Date("2026-09-12T00:00:00Z"),
    };
    const membershipless = {
      ...prismaLoginRow("user-membershipless", "membershipless@example.test"),
      organizationId: null,
      role: null,
      authorizationEpoch: null,
    };
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([active])
      .mockResolvedValueOnce([disabled])
      .mockResolvedValueOnce([membershipless])
      .mockResolvedValueOnce([]);
    const prisma = {
      $queryRaw: queryRaw,
    } as unknown as PrismaClient;
    const store = new PrismaStore(prisma);

    await expect(
      store.findUserByEmail("active@example.test"),
    ).resolves.toMatchObject({
      id: "user-active",
      organizationId: "org-a",
    });
    await expect(
      store.findUserByEmail("disabled@example.test"),
    ).resolves.toBeNull();
    await expect(
      store.findUserByEmail("membershipless@example.test"),
    ).resolves.toBeNull();
    await expect(
      store.findUserByEmail("unknown@example.test"),
    ).resolves.toBeNull();

    expect(queryRaw).toHaveBeenCalledTimes(4);
    const statementShapes = queryRaw.mock.calls.map(([strings]) => [
      ...(strings as TemplateStringsArray),
    ]);
    expect(statementShapes).toEqual([
      statementShapes[0],
      statementShapes[0],
      statementShapes[0],
      statementShapes[0],
    ]);
  });
});

describe("login credential verification shape", () => {
  it("performs one identity lookup and one bcrypt-shaped comparison for every outcome", async () => {
    const active = sessionUser("user-active", "active@example.test", "org-a");
    active.passwordHash = "active-account-hash";
    const results = new Map<string, SessionUser | null>([
      ["active@example.test", active],
      ["unknown@example.test", null],
      ["disabled@example.test", null],
      ["membershipless@example.test", null],
    ]);
    const findUserByEmail = vi.fn(async (email: string) => results.get(email)!);
    const comparedHashes: string[] = [];
    const comparePassword = vi.fn(async (_password: string, digest: string) => {
      comparedHashes.push(digest);
      return false;
    });
    const store = { findUserByEmail } satisfies Pick<
      DataStore,
      "findUserByEmail"
    >;

    for (const email of results.keys()) {
      const lookupCalls = findUserByEmail.mock.calls.length;
      const compareCalls = comparePassword.mock.calls.length;
      await expect(
        verifyLoginCredentials(
          store,
          email,
          "incorrect password",
          comparePassword,
        ),
      ).resolves.toBeNull();
      expect(findUserByEmail.mock.calls.length).toBe(lookupCalls + 1);
      expect(comparePassword.mock.calls.length).toBe(compareCalls + 1);
    }

    expect(comparedHashes[0]).toBe(active.passwordHash);
    expect(new Set(comparedHashes.slice(1))).toHaveLength(1);
    expect(comparedHashes[1]).toMatch(/^\$2b\$12\$/);
    expect(getRounds(comparedHashes[1]!)).toBe(12);
  });
});

describe("identity lifecycle session boundaries", () => {
  const addSession = (
    store: MemoryStore,
    user: SessionUser,
    tokenHash: string,
  ) => {
    store.userSessions.push({
      id: `session-${tokenHash[0]}`,
      organizationId: user.organizationId,
      userId: user.id,
      tokenHash,
      authenticationEpoch: user.authenticationEpoch,
      authorizationEpoch: user.authorizationEpoch,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    });
  };

  it("rotates a multi-organization identity once and audits every affected tenant", async () => {
    const store = new MemoryStore();
    const alpha = sessionUser("user-a", "owner@example.test", "org-a");
    const beta = { ...alpha, organizationId: "org-b", role: "VIEWER" as const };
    store.users.push(alpha, beta);
    addSession(store, alpha, "a".repeat(64));
    addSession(store, beta, "b".repeat(64));

    await expect(
      store.rotateUserPasswordAndAudit("user-a", approvedPasswordHash, {
        reason: "Credential recovery",
      }),
    ).resolves.toEqual({
      updated: true,
      affectedOrganizationIds: ["org-a", "org-b"],
    });

    expect(store.users).toEqual([
      expect.objectContaining({
        organizationId: "org-a",
        passwordHash: approvedPasswordHash,
        authenticationEpoch: 1,
      }),
      expect.objectContaining({
        organizationId: "org-b",
        passwordHash: approvedPasswordHash,
        authenticationEpoch: 1,
      }),
    ]);
    expect(store.userSessions.every((session) => session.revokedAt)).toBe(true);
    expect(
      store.audits.map((event) => [event.organizationId, event.action]),
    ).toEqual([
      ["org-a", "identity.password_rotated"],
      ["org-b", "identity.password_rotated"],
    ]);
    expect(JSON.stringify(store.audits)).not.toContain(approvedPasswordHash);
  });

  it("keeps role restoration and membership removal scoped to one tenant", async () => {
    const store = new MemoryStore();
    const alpha = sessionUser("user-a", "owner@example.test", "org-a");
    const beta = { ...alpha, organizationId: "org-b" };
    const backupOwner = sessionUser("user-b", "backup@example.test", "org-a");
    store.users.push(alpha, beta, backupOwner);
    const alphaHash = "a".repeat(64);
    const betaHash = "b".repeat(64);
    addSession(store, alpha, alphaHash);
    addSession(store, beta, betaHash);

    await store.changeMembershipRoleAndAudit("org-a", "user-a", "VIEWER", {
      reason: "Demote for test",
    });
    await store.changeMembershipRoleAndAudit("org-a", "user-a", "OWNER", {
      reason: "Restore role for test",
    });
    expect(
      store.users.find((user) => user.organizationId === "org-a"),
    ).toMatchObject({
      role: "OWNER",
      authorizationEpoch: 2,
    });
    await expect(
      store.findActiveUserSession("user-a", "org-a", alphaHash),
    ).resolves.toBeNull();
    await expect(
      store.findActiveUserSession("user-a", "org-b", betaHash),
    ).resolves.toMatchObject({ organizationId: "org-b" });

    await store.removeMembershipAndAudit("org-a", "user-a", {
      reason: "Remove tenant access",
    });
    await expect(store.findSessionUser("user-a", "org-a")).resolves.toBeNull();
    await expect(
      store.findActiveUserSession("user-a", "org-b", betaHash),
    ).resolves.toMatchObject({ organizationId: "org-b" });
  });

  it("does not mutate identity state when audit construction fails", async () => {
    class RejectingIdentityAuditStore extends MemoryStore {
      protected override buildAuditRecord(): never {
        throw new Error("audit unavailable");
      }
    }
    const store = new RejectingIdentityAuditStore();
    const user = sessionUser("user-a", "owner@example.test", "org-a");
    store.users.push(
      user,
      sessionUser("user-b", "backup@example.test", "org-a"),
    );
    addSession(store, user, "a".repeat(64));
    const beforeUsers = structuredClone(store.users);
    const beforeSessions = structuredClone(store.userSessions);

    await expect(
      store.disableUserAndAudit("user-a", { reason: "Offboarding" }),
    ).rejects.toThrow("audit unavailable");
    expect(store.users).toEqual(beforeUsers);
    expect(store.userSessions).toEqual(beforeSessions);
    expect(store.audits).toEqual([]);
  });

  it("rolls back a multi-tenant disable when the second audit cannot be built", async () => {
    class RejectingSecondIdentityAuditStore extends MemoryStore {
      private auditBuilds = 0;
      protected override buildAuditRecord(
        event: Omit<AuditRecord, "id" | "createdAt">,
      ): AuditRecord {
        this.auditBuilds += 1;
        if (this.auditBuilds === 2) throw new Error("second audit unavailable");
        return super.buildAuditRecord(event);
      }
    }
    const store = new RejectingSecondIdentityAuditStore();
    const alpha = sessionUser("user-a", "owner@example.test", "org-a");
    const beta = { ...alpha, organizationId: "org-b" };
    store.users.push(
      alpha,
      beta,
      sessionUser("backup-a", "backup-a@example.test", "org-a"),
      sessionUser("backup-b", "backup-b@example.test", "org-b"),
    );
    addSession(store, alpha, "a".repeat(64));
    addSession(store, beta, "b".repeat(64));
    const beforeUsers = structuredClone(store.users);
    const beforeSessions = structuredClone(store.userSessions);

    await expect(
      store.disableUserAndAudit(alpha.id, { reason: "Multi-tenant disable" }),
    ).rejects.toThrow("second audit unavailable");
    expect(store.users).toEqual(beforeUsers);
    expect(store.userSessions).toEqual(beforeSessions);
    expect(store.audits).toEqual([]);
  });

  it("refuses to orphan a tenant through any identity lifecycle helper", async () => {
    const store = new MemoryStore();
    const owner = sessionUser("user-a", "owner@example.test", "org-a");
    const disabledBackup = {
      ...sessionUser("user-b", "backup@example.test", "org-a"),
      disabledAt: new Date().toISOString(),
    };
    store.users.push(owner, disabledBackup);
    addSession(store, owner, "a".repeat(64));
    const beforeUsers = structuredClone(store.users);
    const beforeSessions = structuredClone(store.userSessions);

    for (const mutation of [
      () =>
        store.changeMembershipRoleAndAudit("org-a", owner.id, "ADMIN", {
          reason: "Unsafe demotion",
        }),
      () =>
        store.removeMembershipAndAudit("org-a", owner.id, {
          reason: "Unsafe removal",
        }),
      () => store.disableUserAndAudit(owner.id, { reason: "Unsafe disable" }),
    ])
      await expect(mutation()).resolves.toEqual({
        updated: false,
        reason: "OWNER_CONTINUITY_REQUIRED",
      });

    expect(store.users).toEqual(beforeUsers);
    expect(store.userSessions).toEqual(beforeSessions);
    expect(store.audits).toEqual([]);
  });

  it("permits owner lifecycle changes after an active replacement exists", async () => {
    const store = new MemoryStore();
    const owner = sessionUser("user-a", "owner@example.test", "org-a");
    const replacement = sessionUser(
      "user-b",
      "replacement@example.test",
      "org-a",
    );
    store.users.push(owner, replacement);

    await expect(
      store.changeMembershipRoleAndAudit("org-a", owner.id, "ADMIN", {
        reason: "Replacement is active",
      }),
    ).resolves.toEqual({ updated: true });
    expect(store.users.find(({ id }) => id === owner.id)?.role).toBe("ADMIN");
    expect(store.audits).toHaveLength(1);
  });

  it("validates identity reasons before lookup and continuity results in both stores", async () => {
    const memory = new MemoryStore();
    memory.users.push(sessionUser("user-a", "owner@example.test", "org-a"));
    const transaction = vi.fn();
    const prisma = new PrismaStore({ $transaction: transaction } as never);

    for (const mutation of [
      () => memory.disableUserAndAudit("missing", { reason: " " }),
      () =>
        memory.changeMembershipRoleAndAudit("org-a", "user-a", "VIEWER", {
          reason: " ",
        }),
      () => prisma.disableUserAndAudit("missing", { reason: " " }),
      () =>
        prisma.changeMembershipRoleAndAudit("org-a", "user-a", "VIEWER", {
          reason: " ",
        }),
    ])
      await expect(mutation()).rejects.toThrow(
        "Identity mutation reason must contain",
      );

    expect(transaction).not.toHaveBeenCalled();
    expect(memory.users[0]!.role).toBe("OWNER");
    expect(memory.audits).toEqual([]);
  });

  it("rejects raw or weak password material before opening a mutation", async () => {
    const store = new MemoryStore();
    store.users.push(sessionUser("user-a", "owner@example.test", "org-a"));

    await expect(
      store.rotateUserPasswordAndAudit("user-a", "raw-password", {
        reason: "Unsafe caller",
      }),
    ).rejects.toThrow("approved bcrypt");
    expect(store.users[0]!.passwordHash).toBe("hash-user-a");
    expect(store.audits).toEqual([]);
  });
});
