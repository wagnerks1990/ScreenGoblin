import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../src/store/memory.js";
import { PrismaStore } from "../src/store/prisma.js";
import type { SessionUser } from "../src/domain/types.js";

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

const prismaUser = (id: string, email: string) => ({
  id,
  email,
  name: `User ${id}`,
  passwordHash: `hash-${id}`,
  authenticationEpoch: 0,
  disabledAt: null,
  createdAt: new Date("2026-09-12T00:00:00Z"),
  updatedAt: new Date("2026-09-12T00:00:00Z"),
  memberships: [
    {
      id: `membership-${id}`,
      organizationId: "org-a",
      userId: id,
      role: "OWNER" as const,
      authorizationEpoch: 0,
    },
  ],
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

  it("uses the normalized index expression and rejects ambiguous IDs", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValue([{ id: "user-a" }, { id: "user-b" }]);
    const findUnique = vi.fn();
    const prisma = {
      $queryRaw: queryRaw,
      user: { findUnique },
    } as unknown as PrismaClient;

    await expect(
      new PrismaStore(prisma).findUserByEmail("owner@example.test"),
    ).resolves.toBeNull();
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(queryRaw.mock.calls[0]?.[1]).toBe("owner@example.test");
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("returns the stable first organization only for one unique Prisma user", async () => {
    const user = prismaUser("user-a", "Owner@example.test");
    user.memberships[0]!.organizationId = "org-a";
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "user-a" }]),
      user: { findUnique: vi.fn().mockResolvedValue(user) },
    } as unknown as PrismaClient;

    await expect(
      new PrismaStore(prisma).findUserByEmail("owner@example.test"),
    ).resolves.toMatchObject({
      id: "user-a",
      email: "Owner@example.test",
      organizationId: "org-a",
    });
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
    store.users.push(alpha, beta);
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
    store.users.push(user);
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
