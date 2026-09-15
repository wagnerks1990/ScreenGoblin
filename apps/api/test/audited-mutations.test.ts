import { describe, expect, it } from "vitest";
import type { AuditRecord } from "../src/domain/types.js";
import { MemoryStore } from "../src/store/memory.js";

const actor = {
  id: "actor",
  email: "actor@example.test",
  name: "Actor",
  passwordHash: "unused",
  organizationId: "org-a",
  role: "OWNER" as const,
  authenticationEpoch: 0,
  authorizationEpoch: 0,
};

const screenInput = {
  name: "Lobby",
  location: "Main building",
  orientation: "landscape" as const,
  resolution: "1920x1080",
  tags: ["public"],
};

const mediaInput = {
  name: "Welcome",
  kind: "image" as const,
  mimeType: "image/png",
  url: "https://media.example.test/welcome.png",
  checksumSha256: "a".repeat(64),
  sizeBytes: 1024,
};

class RejectingAuditStore extends MemoryStore {
  protected override buildAuditRecord(): never {
    throw new Error("audit unavailable");
  }
}

class ToggleRejectingAuditStore extends MemoryStore {
  rejectAudit = false;
  protected override buildAuditRecord(
    event: Omit<AuditRecord, "id" | "createdAt">,
  ): AuditRecord {
    if (this.rejectAudit) throw new Error("audit unavailable");
    return super.buildAuditRecord(event);
  }
}

function authorized<T extends MemoryStore>(store: T): T {
  store.users.push({ ...actor });
  return store;
}

describe("atomic audited administrative mutations", () => {
  it("does not compact Memory publication responses on audit or replay-integrity failure", async () => {
    const store = authorized(new ToggleRejectingAuditStore());
    const screen = await store.createScreen("org-a", screenInput);
    const media = await store.createMedia("org-a", mediaInput);
    const playlist = await store.createPlaylist("org-a", {
      name: "Retention playlist",
      description: "",
      items: [
        {
          id: "ignored",
          assetId: media.id,
          position: 0,
          durationSeconds: 10,
        },
      ],
    });
    const input = {
      playlistId: playlist.id,
      name: "Retention schedule",
      priority: "normal" as const,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      timezone: "UTC",
      daysOfWeek: [],
      enabled: true,
      screenIds: [screen.id],
    };
    const expiredResponse = {
      organizationId: "org-a",
      operation: "schedule.publish" as const,
      keyHash: "1".repeat(64),
      actorUserId: actor.id,
      requestDigestSha256: "2".repeat(64),
      response: {
        id: "historical-schedule",
        organizationId: "org-a",
        playlistId: playlist.id,
        name: "Historical schedule",
        priority: "normal" as const,
        startsAt: input.startsAt,
        timezone: "UTC",
        daysOfWeek: [],
        enabled: true,
        screenIds: [screen.id],
        releaseId: "historical-release",
        assignmentId: "historical-assignment",
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z",
      },
      createdAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-02T00:00:00.000Z",
    };
    store.idempotencyRecords.push(expiredResponse);
    store.rejectAudit = true;
    await expect(
      store.publishScheduleAndAudit(
        "org-a",
        input,
        { actorUserId: actor.id },
        { mediaAllowedOrigins: ["https://media.example.test"] },
        { keyHash: "3".repeat(64), requestDigestSha256: "4".repeat(64) },
      ),
    ).rejects.toThrow("audit unavailable");
    expect(expiredResponse.response).toBeDefined();
    expect(store.schedules).toEqual([]);

    store.rejectAudit = false;
    const idempotency = {
      keyHash: "5".repeat(64),
      requestDigestSha256: "6".repeat(64),
    };
    const published = await store.publishScheduleAndAudit(
      "org-a",
      input,
      { actorUserId: actor.id },
      { mediaAllowedOrigins: ["https://media.example.test"] },
      idempotency,
    );
    if (!published.published) throw new Error("publication fixture failed");
    const replayFailureSentinel = {
      ...structuredClone(expiredResponse),
      keyHash: "7".repeat(64),
      response: structuredClone(published.schedule),
    };
    store.idempotencyRecords.push(replayFailureSentinel);
    store.releases = [];
    await expect(
      store.publishScheduleAndAudit(
        "org-a",
        input,
        { actorUserId: actor.id },
        { mediaAllowedOrigins: ["https://media.example.test"] },
        idempotency,
      ),
    ).rejects.toThrow("Idempotent publication references are missing");
    expect(replayFailureSentinel.response).toBeDefined();
  });

  it("keeps Memory device replacement and revocation mutations audit-atomic", async () => {
    const timestamp = new Date().toISOString();
    const seed = async () => {
      const store = authorized(new ToggleRejectingAuditStore());
      const screen = await store.createScreen("org-a", screenInput);
      store.deviceCredentials.push({
        id: `credential-${screen.id}`,
        organizationId: "org-a",
        screenId: screen.id,
        detached: false,
        keyId: `old-key-${screen.id}`,
        publicKeySpki: "old-spki",
        algorithm: "ES256",
        securityLevel: "software",
        createdAt: timestamp,
      });
      Object.assign(screen, {
        status: "online" as const,
        lastSeenAt: timestamp,
        manifestVersion: "old-manifest",
        nowPlayingAssetId: "old-asset",
        uptimeSeconds: 9,
        freeStorageBytes: 10,
        networkType: "old-network",
      });
      return { store, screen };
    };
    const snapshot = (store: MemoryStore) =>
      structuredClone({
        screens: store.screens,
        credentials: store.deviceCredentials,
        pairings: store.pairings,
        attempts: store.pairingAttempts,
        challenges: store.deviceAuthChallenges,
        audits: store.audits,
      });

    const requested = await seed();
    requested.store.rejectAudit = true;
    const beforeRequest = snapshot(requested.store);
    await expect(
      requested.store.requestScreenReenrollmentAndAudit(
        "org-a",
        requested.screen.id,
        "replacement-code",
        new Date(Date.now() + 60_000).toISOString(),
        "Replace failed hardware",
        { actorUserId: actor.id },
      ),
    ).rejects.toThrow("audit unavailable");
    expect(snapshot(requested.store)).toEqual(beforeRequest);

    const revoked = await seed();
    revoked.store.rejectAudit = true;
    const beforeRevoke = snapshot(revoked.store);
    await expect(
      revoked.store.revokeDeviceCredentialAndAudit("org-a", revoked.screen.id, {
        actorUserId: actor.id,
      }),
    ).rejects.toThrow("audit unavailable");
    expect(snapshot(revoked.store)).toEqual(beforeRevoke);

    const replacement = await seed();
    const grant = await replacement.store.requestScreenReenrollmentAndAudit(
      "org-a",
      replacement.screen.id,
      "replacement-code",
      new Date(Date.now() + 60_000).toISOString(),
      "Replace failed hardware",
      { actorUserId: actor.id },
    );
    if (!grant.created) throw new Error(grant.reason);
    replacement.store.pairingAttempts.push({
      id: "replacement-candidate",
      organizationId: "org-a",
      pairingCodeId: grant.pairing.id,
      keyId: "replacement-key",
      publicKeySpki: "replacement-spki",
      algorithm: "ES256",
      securityLevel: "software",
      challengeHashSha256: "a".repeat(64),
      transcriptDigestSha256: "b".repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      provedAt: timestamp,
      installationId: "replacement-installation",
      model: "Replacement",
      osVersion: "15",
      playerVersion: "0.2.0",
      createdAt: timestamp,
    });
    replacement.store.rejectAudit = true;
    const beforeActivation = snapshot(replacement.store);
    await expect(
      replacement.store.activateReenrollmentCandidateAndAudit(
        "org-a",
        replacement.screen.id,
        grant.pairing.id,
        "replacement-candidate",
        { actorUserId: actor.id },
      ),
    ).rejects.toThrow("audit unavailable");
    expect(snapshot(replacement.store)).toEqual(beforeActivation);

    const reasserted = await seed();
    const pending = await reasserted.store.requestScreenReenrollmentAndAudit(
      "org-a",
      reasserted.screen.id,
      "replacement-code",
      new Date(Date.now() + 60_000).toISOString(),
      "Replace failed hardware",
      { actorUserId: actor.id },
    );
    if (!pending.created) throw new Error(pending.reason);
    reasserted.store.rejectAudit = true;
    const beforeReassertion = snapshot(reasserted.store);
    await expect(
      reasserted.store.revokeDeviceCredentialAndAudit(
        "org-a",
        reasserted.screen.id,
        { actorUserId: actor.id },
      ),
    ).rejects.toThrow("audit unavailable");
    expect(snapshot(reasserted.store)).toEqual(beforeReassertion);
  });

  it("keeps location classification tenant-bound and audit-atomic", async () => {
    const store = authorized(new MemoryStore());
    const alpha = await store.createLocationAndAudit("org-a", "Main campus", {
      actorUserId: actor.id,
    });
    if (!alpha.created) throw new Error(alpha.reason);
    const foreign = new MemoryStore();
    foreign.users.push({ ...actor, organizationId: "org-b" });
    const beta = await foreign.createLocationAndAudit("org-b", "Other campus", {
      actorUserId: actor.id,
    });
    if (!beta.created) throw new Error(beta.reason);
    store.locations.push(beta.value);

    await expect(
      store.createScreenAndAudit(
        "org-a",
        { ...screenInput, locationId: beta.value.id },
        { actorUserId: actor.id },
      ),
    ).resolves.toEqual({ created: false, reason: "INVALID_LOCATION" });
    const screen = await store.createScreenAndAudit(
      "org-a",
      { ...screenInput, locationId: alpha.value.id },
      { actorUserId: actor.id },
    );
    if (!screen.created) throw new Error(screen.reason);
    expect(screen.value).toMatchObject({
      location: "Main building",
      locationId: alpha.value.id,
      locationName: "Main campus",
    });
    await expect(
      store.deleteLocationAndAudit("org-a", alpha.value.id, {
        actorUserId: actor.id,
      }),
    ).resolves.toEqual({ deleted: false, reason: "IN_USE" });
  });

  it("rolls back location changes when audit creation fails", async () => {
    const createStore = authorized(new RejectingAuditStore());
    await expect(
      createStore.createLocationAndAudit("org-a", "Main campus", {
        actorUserId: actor.id,
      }),
    ).rejects.toThrow("audit unavailable");
    expect(createStore.locations).toEqual([]);

    const updateStore = authorized(new RejectingAuditStore());
    updateStore.locations.push({
      id: "location-a",
      organizationId: "org-a",
      name: "Before",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(
      updateStore.updateLocationAndAudit("org-a", "location-a", "After", {
        actorUserId: actor.id,
      }),
    ).rejects.toThrow("audit unavailable");
    expect(updateStore.locations[0]!.name).toBe("Before");

    const deleteStore = authorized(new RejectingAuditStore());
    deleteStore.locations.push({
      id: "location-delete",
      organizationId: "org-a",
      name: "Still present",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(
      deleteStore.deleteLocationAndAudit("org-a", "location-delete", {
        actorUserId: actor.id,
      }),
    ).rejects.toThrow("audit unavailable");
    expect(deleteStore.locations).toHaveLength(1);
  });
  it("does not create or update screens when the audit write fails", async () => {
    const createStore = authorized(new RejectingAuditStore());
    await expect(
      createStore.createScreenAndAudit("org-a", screenInput, {
        actorUserId: actor.id,
      }),
    ).rejects.toThrow("audit unavailable");
    expect(createStore.screens).toEqual([]);
    expect(createStore.audits).toEqual([]);

    const updateStore = authorized(new RejectingAuditStore());
    const screen = await updateStore.createScreen("org-a", screenInput);
    const before = structuredClone(screen);
    await expect(
      updateStore.updateScreenAndAudit(
        "org-a",
        screen.id,
        { name: "Changed" },
        { actorUserId: actor.id },
      ),
    ).rejects.toThrow("audit unavailable");
    expect(updateStore.screens).toEqual([before]);
    expect(updateStore.audits).toEqual([]);
  });

  it("does not create or delete media when the audit write fails", async () => {
    const createStore = authorized(new RejectingAuditStore());
    await expect(
      createStore.createMediaAndAudit("org-a", mediaInput, {
        actorUserId: actor.id,
      }),
    ).rejects.toThrow("audit unavailable");
    expect(createStore.media).toEqual([]);

    const deleteStore = authorized(new RejectingAuditStore());
    const media = await deleteStore.createMedia("org-a", mediaInput);
    await expect(
      deleteStore.deleteMediaAndAudit("org-a", media.id, {
        actorUserId: actor.id,
      }),
    ).rejects.toThrow("audit unavailable");
    expect(deleteStore.media).toEqual([media]);
    expect(deleteStore.audits).toEqual([]);
  });

  it("does not create or delete playlists when the audit write fails", async () => {
    const playlistInput = {
      name: "Lobby rotation",
      description: "",
      items: [],
    };
    const createStore = authorized(new RejectingAuditStore());
    await expect(
      createStore.createPlaylistAndAudit("org-a", playlistInput, {
        actorUserId: actor.id,
      }),
    ).rejects.toThrow("audit unavailable");
    expect(createStore.playlists).toEqual([]);

    const deleteStore = authorized(new RejectingAuditStore());
    const playlist = await deleteStore.createPlaylist("org-a", playlistInput);
    await expect(
      deleteStore.deletePlaylistAndAudit("org-a", playlist.id, {
        actorUserId: actor.id,
      }),
    ).rejects.toThrow("audit unavailable");
    expect(deleteStore.playlists).toEqual([playlist]);
    expect(deleteStore.audits).toEqual([]);
  });

  it("rechecks current authority and tenant membership before every write", async () => {
    const store = authorized(new MemoryStore());
    const screen = await store.createScreen("org-a", screenInput);
    const media = await store.createMedia("org-a", mediaInput);
    const playlist = await store.createPlaylist("org-a", {
      name: "Lobby rotation",
      description: "",
      items: [],
    });
    store.users[0]!.role = "VIEWER";

    await expect(
      store.createScreenAndAudit("org-a", screenInput, {
        actorUserId: actor.id,
      }),
    ).resolves.toEqual({ created: false, reason: "FORBIDDEN" });
    await expect(
      store.updateScreenAndAudit(
        "org-a",
        screen.id,
        { name: "Changed" },
        { actorUserId: actor.id },
      ),
    ).resolves.toEqual({ updated: false, reason: "FORBIDDEN" });
    await expect(
      store.createMediaAndAudit("org-a", mediaInput, {
        actorUserId: actor.id,
      }),
    ).resolves.toEqual({ created: false, reason: "FORBIDDEN" });
    await expect(
      store.createPlaylistAndAudit(
        "org-a",
        { name: "New", description: "", items: [] },
        { actorUserId: actor.id },
      ),
    ).resolves.toEqual({ created: false, reason: "FORBIDDEN" });
    await expect(
      store.deleteMediaAndAudit("org-a", media.id, {
        actorUserId: actor.id,
      }),
    ).resolves.toEqual({ deleted: false, reason: "FORBIDDEN" });
    await expect(
      store.deletePlaylistAndAudit("org-a", playlist.id, {
        actorUserId: actor.id,
      }),
    ).resolves.toEqual({ deleted: false, reason: "FORBIDDEN" });
    expect(store.screens).toEqual([screen]);
    expect(store.media).toEqual([media]);
    expect(store.playlists).toEqual([playlist]);
    expect(store.audits).toEqual([]);
  });

  it("rejects missing and cross-tenant playlist assets without partial writes", async () => {
    const store = authorized(new MemoryStore());
    const foreign = await store.createMedia("org-b", mediaInput);

    for (const assetId of ["missing", foreign.id]) {
      await expect(
        store.createPlaylistAndAudit(
          "org-a",
          {
            name: `Playlist ${assetId}`,
            description: "",
            items: [{ id: "", assetId, position: 0, durationSeconds: 15 }],
          },
          { actorUserId: actor.id },
        ),
      ).resolves.toEqual({ created: false, reason: "INVALID_ASSET" });
    }
    expect(store.playlists).toEqual([]);
    expect(store.audits).toEqual([]);
  });

  it("owns mutable input arrays instead of retaining caller references", async () => {
    const store = authorized(new MemoryStore());
    const tags = ["public", "public", "lobby"];
    const createdScreen = await store.createScreenAndAudit(
      "org-a",
      { ...screenInput, tags },
      { actorUserId: actor.id },
    );
    if (!createdScreen.created) throw new Error(createdScreen.reason);
    tags.push("mutated");
    expect(createdScreen.value.tags).toEqual(["public", "lobby"]);

    const media = await store.createMedia("org-a", mediaInput);
    const items = [
      { id: "", assetId: media.id, position: 0, durationSeconds: 15 },
    ];
    const createdPlaylist = await store.createPlaylistAndAudit(
      "org-a",
      { name: "Owned items", description: "", items },
      { actorUserId: actor.id },
    );
    if (!createdPlaylist.created) throw new Error(createdPlaylist.reason);
    items[0]!.durationSeconds = 99;
    items.push({
      id: "",
      assetId: media.id,
      position: 1,
      durationSeconds: 10,
    });
    expect(createdPlaylist.value.items).toHaveLength(1);
    expect(createdPlaylist.value.items[0]!.durationSeconds).toBe(15);
  });

  it("denies every legacy role before emergency state or audit writes", async () => {
    for (const role of ["OWNER", "ADMIN", "PUBLISHER", "VIEWER"] as const) {
      const store = authorized(new MemoryStore());
      store.users[0]!.role = role;
      const screen = await store.createScreen("org-a", screenInput);
      const now = new Date().toISOString();
      const emergency = {
        id: `contained-${role.toLowerCase()}`,
        organizationId: "org-a",
        title: "Contained",
        message: "Must remain active",
        backgroundColor: "#C1121F",
        targetScreenIds: [screen.id],
        startsAt: now,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        createdById: actor.id,
        createdAt: now,
      };
      store.emergencies.push(emergency);
      await expect(
        store.activateEmergencyAndAudit(
          "org-a",
          {
            title: "Denied",
            message: "Must not activate",
            backgroundColor: "#C1121F",
            targetScreenIds: [screen.id],
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          { actorUserId: actor.id },
        ),
      ).resolves.toEqual({ activated: false, reason: "FORBIDDEN" });
      await expect(
        store.clearEmergencyAndAudit("org-a", emergency.id, {
          actorUserId: actor.id,
        }),
      ).resolves.toEqual({ cleared: false, reason: "FORBIDDEN" });
      expect(store.emergencies).toEqual([emergency]);
      expect(store.emergencies[0]?.clearedAt).toBeUndefined();
      expect(store.audits).toEqual([]);
    }
  });

  it("records request context and the existing action metadata on success", async () => {
    const store = authorized(new MemoryStore());
    const result = await store.createScreenAndAudit("org-a", screenInput, {
      actorUserId: actor.id,
      ipAddress: "192.0.2.10",
      requestId: "request-1",
    });
    expect(result.created).toBe(true);
    expect(store.audits).toMatchObject([
      {
        organizationId: "org-a",
        actorUserId: actor.id,
        action: "screen.created",
        entityType: "screen",
        ipAddress: "192.0.2.10",
        requestId: "request-1",
        metadata: { name: "Lobby" },
      },
    ]);
  });
});
