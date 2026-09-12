import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../src/store/memory.js";
import { PrismaStore } from "../src/store/prisma.js";
import {
  DATABASE_MAINTENANCE_BATCH_SIZE,
  DEVICE_AUTH_CHALLENGE_RETENTION_MS,
} from "../src/domain/types.js";

const device = {
  installationId: "installation-store-test",
  model: "Test player",
  osVersion: "14",
  playerVersion: "0.1.0",
};

class ToggleRejectingChallengeIdStore extends MemoryStore {
  rejectChallengeId = false;
  protected override createDeviceAuthChallengeId() {
    if (this.rejectChallengeId)
      throw new Error("challenge entropy unavailable");
    return super.createDeviceAuthChallengeId();
  }
}

const authorizePairing = <T extends MemoryStore>(store: T) => {
  store.users.push({
    id: "user-a",
    email: "owner@example.test",
    name: "Owner",
    passwordHash: "unused",
    organizationId: "org-a",
    role: "OWNER",
    authenticationEpoch: 0,
    authorizationEpoch: 0,
  });
  return store;
};

describe("pairing store invariants", () => {
  it("creates a pairing and its audit atomically", async () => {
    const store = authorizePairing(new MemoryStore());
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    const result = await store.tryCreatePairingAndAudit(
      "org-a",
      "create-hash",
      expiresAt,
      {
        actorUserId: "user-a",
        ipAddress: "192.0.2.20",
        requestId: "request-create",
      },
    );

    expect(result.created).toBe(true);
    expect(store.audits).toEqual([
      expect.objectContaining({
        organizationId: "org-a",
        actorUserId: "user-a",
        action: "pairing.created",
        entityId: result.created ? result.pairing.id : undefined,
        metadata: { expiresAt },
      }),
    ]);
    await expect(
      store.tryCreatePairingAndAudit("org-a", "create-hash", expiresAt, {
        actorUserId: "user-a",
      }),
    ).resolves.toEqual({ created: false, reason: "CODE_COLLISION" });
    expect(store.audits).toHaveLength(1);
  });

  it("does not strand a pairing when its required audit cannot be built", async () => {
    class RejectingAuditStore extends MemoryStore {
      protected override buildAuditRecord(): never {
        throw new Error("audit unavailable");
      }
    }
    const store = authorizePairing(new RejectingAuditStore());

    await expect(
      store.tryCreatePairingAndAudit(
        "org-a",
        "failed-create-hash",
        new Date(Date.now() + 60_000).toISOString(),
        { actorUserId: "user-a" },
      ),
    ).rejects.toThrow("audit unavailable");
    expect(store.pairings).toEqual([]);
    expect(store.audits).toEqual([]);
  });

  it("revalidates current pairing-code authority before any state change", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    for (const actor of [
      { organizationId: "org-a", role: "VIEWER" as const },
      {
        organizationId: "org-a",
        role: "ADMIN" as const,
        disabledAt: expiresAt,
      },
      { organizationId: "org-b", role: "ADMIN" as const },
    ]) {
      const store = new MemoryStore();
      store.users.push({
        id: "user-a",
        email: "operator@example.test",
        name: "Operator",
        passwordHash: "unused",
        authenticationEpoch: 0,
        authorizationEpoch: 0,
        ...actor,
      });
      const expired = await store.createPairing(
        "org-a",
        "expired-hash",
        new Date(0).toISOString(),
      );

      await expect(
        store.tryCreatePairingAndAudit("org-a", "expired-hash", expiresAt, {
          actorUserId: "user-a",
        }),
      ).resolves.toEqual({ created: false, reason: "FORBIDDEN" });
      expect(expired.status).toBe("PENDING");
      expect(store.pairings).toEqual([expired]);
      expect(store.audits).toEqual([]);
    }
  });

  it("distinguishes a live-code collision and permits reuse after expiry", async () => {
    const store = new MemoryStore();
    const first = await store.tryCreatePairing(
      "org-a",
      "shared-hash",
      new Date(Date.now() + 60_000).toISOString(),
    );
    expect(first.created).toBe(true);

    await expect(
      store.tryCreatePairing(
        "org-a",
        "shared-hash",
        new Date(Date.now() + 60_000).toISOString(),
      ),
    ).resolves.toEqual({ created: false, reason: "CODE_COLLISION" });

    if (first.created) first.pairing.expiresAt = new Date(0).toISOString();
    const reused = await store.tryCreatePairing(
      "org-b",
      "shared-hash",
      new Date(Date.now() + 60_000).toISOString(),
    );
    expect(reused.created).toBe(true);
    expect(store.pairings).toMatchObject([
      { status: "EXPIRED" },
      { status: "PENDING", organizationId: "org-b" },
    ]);
  });

  it("claims a pairing and appends its required audit as one store operation", async () => {
    const store = new MemoryStore();
    await store.createPairing(
      "org-a",
      "pair-hash",
      new Date(Date.now() + 60_000).toISOString(),
    );

    const screen = await store.claimPairingAndAudit(
      "pair-hash",
      device,
      "token-hash",
      {
        ipAddress: "192.0.2.10",
        requestId: "request-a",
        metadata: { installationId: "untrusted-override" },
      },
    );

    expect(screen).not.toBeNull();
    expect(store.pairings[0]).toMatchObject({
      status: "CLAIMED",
      screenId: screen?.id,
    });
    expect(store.audits).toEqual([
      expect.objectContaining({
        organizationId: "org-a",
        action: "device.paired",
        entityId: screen?.id,
        ipAddress: "192.0.2.10",
        requestId: "request-a",
        metadata: { installationId: device.installationId },
      }),
    ]);
  });

  it("writes the device, pairing claim, and audit through one Prisma transaction", async () => {
    const timestamp = new Date();
    const transaction = {
      pairingCode: {
        findFirst: vi.fn().mockResolvedValue({
          id: "pair-a",
          organizationId: "org-a",
          expiresAt: new Date(Date.now() + 60_000),
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
      },
      screen: {
        create: vi.fn().mockResolvedValue({
          id: "screen-a",
          organizationId: "org-a",
          name: "New screen e-test",
          location: "Unassigned",
          status: "ONLINE",
          orientation: "LANDSCAPE",
          resolution: "1920x1080",
          tags: [],
          installationId: device.installationId,
          deviceTokenHash: "token-hash",
          createdAt: timestamp,
          updatedAt: timestamp,
          lastSeenAt: timestamp,
        }),
      },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: vi.fn((callback: (tx: typeof transaction) => unknown) =>
        Promise.resolve(callback(transaction)),
      ),
    } as unknown as PrismaClient;

    const screen = await new PrismaStore(prisma).claimPairingAndAudit(
      "pair-hash",
      device,
      "token-hash",
      { requestId: "request-a" },
    );

    expect(screen?.id).toBe("screen-a");
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(transaction.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "org-a",
        action: "device.paired",
        entityId: "screen-a",
        requestId: "request-a",
      }),
    });
  });
});

describe("store serialization invariants", () => {
  it("bounds in-memory device challenge retention without pruning live rows", async () => {
    const store = new ToggleRejectingChallengeIdStore();
    const screen = await store.createScreen("org-a", {
      name: "Retention screen",
      location: "",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const keyId = Buffer.alloc(32, 9).toString("base64url");
    store.deviceCredentials.push({
      id: "credential-a",
      organizationId: "org-a",
      screenId: screen.id,
      detached: false,
      keyId,
      publicKeySpki: Buffer.alloc(91, 9).toString("base64url"),
      algorithm: "ES256",
      securityLevel: "trusted-environment",
      createdAt: new Date().toISOString(),
    });
    const expiredAt = new Date(
      Date.now() - DEVICE_AUTH_CHALLENGE_RETENTION_MS - 60_000,
    ).toISOString();
    store.deviceAuthChallenges.push(
      ...Array.from(
        { length: DATABASE_MAINTENANCE_BATCH_SIZE + 5 },
        (_, index) => ({
          id: `expired-${index.toString().padStart(3, "0")}`,
          organizationId: "org-a",
          credentialId: "credential-a",
          challengeHashSha256: index.toString(16).padStart(64, "0"),
          operation: "manifest" as const,
          requestDigestSha256: "a".repeat(64),
          expiresAt: expiredAt,
          consumedAt: expiredAt,
          createdAt: expiredAt,
        }),
      ),
    );

    const live = await store.issueDeviceAuthChallenge({
      screenId: screen.id,
      keyId,
      challengeHashSha256: "f".repeat(64),
      operation: "manifest",
      requestDigestSha256: "b".repeat(64),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });

    expect(live).not.toBeNull();
    expect(store.deviceAuthChallenges).toHaveLength(6);
    expect(store.deviceAuthChallenges).toContainEqual(live);

    for (let index = 0; index < 3; index += 1) {
      await expect(
        store.issueDeviceAuthChallenge({
          screenId: screen.id,
          keyId,
          challengeHashSha256: (index + 10).toString(16).padStart(64, "0"),
          operation: "manifest",
          requestDigestSha256: "c".repeat(64),
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        }),
      ).resolves.not.toBeNull();
    }
    const retainedAtCap = {
      id: "retained-at-cap",
      organizationId: "org-a",
      credentialId: "credential-a",
      challengeHashSha256: "d".repeat(64),
      operation: "heartbeat" as const,
      requestDigestSha256: "e".repeat(64),
      expiresAt: expiredAt,
      consumedAt: expiredAt,
      createdAt: expiredAt,
    };
    store.deviceAuthChallenges.push(retainedAtCap);
    await expect(
      store.issueDeviceAuthChallenge({
        screenId: screen.id,
        keyId,
        challengeHashSha256: "9".repeat(64),
        operation: "manifest",
        requestDigestSha256: "8".repeat(64),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      }),
    ).resolves.toBeNull();
    expect(store.deviceAuthChallenges).toContainEqual(retainedAtCap);

    const liveIndex = store.deviceAuthChallenges.findIndex(
      (challenge) =>
        challenge.operation === "manifest" && challenge.expiresAt > expiredAt,
    );
    expect(liveIndex).toBeGreaterThanOrEqual(0);
    store.deviceAuthChallenges.splice(liveIndex, 1);
    const beforeEntropyFailure = structuredClone(store.deviceAuthChallenges);
    store.rejectChallengeId = true;
    await expect(
      store.issueDeviceAuthChallenge({
        screenId: screen.id,
        keyId,
        challengeHashSha256: "7".repeat(64),
        operation: "manifest",
        requestDigestSha256: "6".repeat(64),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      }),
    ).rejects.toThrow("challenge entropy unavailable");
    expect(store.deviceAuthChallenges).toEqual(beforeEntropyFailure);
  });

  it("uses a stable organization fallback when an email has multiple memberships", async () => {
    const store = new MemoryStore();
    store.users.push(
      {
        id: "user-a",
        email: "owner@example.test",
        name: "Owner",
        passwordHash: "hash",
        organizationId: "org-z",
        role: "OWNER",
        authenticationEpoch: 0,
        authorizationEpoch: 0,
      },
      {
        id: "user-a",
        email: "owner@example.test",
        name: "Owner",
        passwordHash: "hash",
        organizationId: "org-a",
        role: "VIEWER",
        authenticationEpoch: 0,
        authorizationEpoch: 0,
      },
    );

    await expect(
      store.findUserByEmail("OWNER@example.test"),
    ).resolves.toMatchObject({ organizationId: "org-a", role: "VIEWER" });
  });

  it("rejects database counters that cannot be represented safely in JSON", async () => {
    const timestamp = new Date();
    const prisma = {
      mediaAsset: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "media-a",
            organizationId: "org-a",
            name: "Oversized asset",
            kind: "VIDEO",
            mimeType: "video/mp4",
            url: "https://media.example.test/oversized.mp4",
            checksumSha256: "a".repeat(64),
            sizeBytes: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
            durationSeconds: null,
            expiresAt: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ]),
      },
    } as unknown as PrismaClient;

    await expect(new PrismaStore(prisma).listMedia("org-a")).rejects.toThrow(
      "sizeBytes exceeds the JSON safe-integer range",
    );
  });
});
