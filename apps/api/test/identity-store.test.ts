import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../src/store/memory.js";
import { PrismaStore } from "../src/store/prisma.js";

const sessionUser = (id: string, email: string, organizationId: string) => ({
  id,
  email,
  name: `User ${id}`,
  passwordHash: `hash-${id}`,
  organizationId,
  role: "OWNER" as const,
});

const prismaUser = (id: string, email: string) => ({
  id,
  email,
  name: `User ${id}`,
  passwordHash: `hash-${id}`,
  disabledAt: null,
  createdAt: new Date("2026-09-12T00:00:00Z"),
  updatedAt: new Date("2026-09-12T00:00:00Z"),
  memberships: [
    {
      id: `membership-${id}`,
      organizationId: "org-a",
      userId: id,
      role: "OWNER" as const,
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
