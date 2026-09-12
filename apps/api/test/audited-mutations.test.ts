import { describe, expect, it } from "vitest";
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

function authorized<T extends MemoryStore>(store: T): T {
  store.users.push({ ...actor });
  return store;
}

describe("atomic audited administrative mutations", () => {
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

  it("does not activate or clear emergencies when the audit write fails", async () => {
    const activationStore = authorized(new RejectingAuditStore());
    const screen = await activationStore.createScreen("org-a", screenInput);
    await expect(
      activationStore.activateEmergencyAndAudit(
        "org-a",
        {
          title: "Drill",
          message: "Audit rollback drill",
          backgroundColor: "#C1121F",
          targetScreenIds: [screen.id],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        { actorUserId: actor.id },
      ),
    ).rejects.toThrow("audit unavailable");
    expect(activationStore.emergencies).toEqual([]);
    expect(activationStore.audits).toEqual([]);

    const clearStore = authorized(new RejectingAuditStore());
    const emergency = {
      id: "emergency-to-clear",
      organizationId: "org-a",
      title: "Drill",
      message: "Must remain active",
      backgroundColor: "#C1121F",
      targetScreenIds: ["screen-1"],
      startsAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdById: actor.id,
      createdAt: new Date().toISOString(),
    };
    clearStore.emergencies.push(emergency);
    await expect(
      clearStore.clearEmergencyAndAudit("org-a", emergency.id, {
        actorUserId: actor.id,
      }),
    ).rejects.toThrow("audit unavailable");
    expect(clearStore.emergencies[0]?.clearedAt).toBeUndefined();
    expect(clearStore.audits).toEqual([]);
  });

  it("rechecks emergency authority and validates every target before writing", async () => {
    for (const scenario of [
      "VIEWER",
      "disabled",
      "missing",
      "cross-organization",
    ] as const) {
      const store = authorized(new MemoryStore());
      const screen = await store.createScreen("org-a", screenInput);
      if (scenario === "VIEWER") store.users[0]!.role = "VIEWER";
      if (scenario === "disabled")
        store.users[0]!.disabledAt = new Date().toISOString();
      if (scenario === "cross-organization")
        store.users[0]!.organizationId = "org-b";
      const actorUserId = scenario === "missing" ? "missing" : actor.id;
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
          { actorUserId },
        ),
      ).resolves.toEqual({ activated: false, reason: "FORBIDDEN" });
      expect(store.emergencies).toEqual([]);
      expect(store.audits).toEqual([]);
    }

    const store = authorized(new MemoryStore());
    const local = await store.createScreen("org-a", screenInput);
    const foreign = await store.createScreen("org-b", screenInput);
    await expect(
      store.activateEmergencyAndAudit(
        "org-a",
        {
          title: "Mixed targets",
          message: "Must fail atomically",
          backgroundColor: "#C1121F",
          targetScreenIds: [local.id, foreign.id],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        { actorUserId: actor.id },
      ),
    ).resolves.toEqual({ activated: false, reason: "INVALID_SCREEN" });
    expect(store.emergencies).toEqual([]);
    expect(store.audits).toEqual([]);
  });

  it("owns emergency targets and records activation and clear atomically", async () => {
    const store = authorized(new MemoryStore());
    const screen = await store.createScreen("org-a", screenInput);
    const targetScreenIds = [screen.id, screen.id];
    const result = await store.activateEmergencyAndAudit(
      "org-a",
      {
        title: "Drill",
        message: "Atomic path",
        backgroundColor: "#C1121F",
        targetScreenIds,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      {
        actorUserId: actor.id,
        ipAddress: "192.0.2.20",
        requestId: "emergency-activate",
      },
    );
    if (!result.activated) throw new Error(result.reason);
    targetScreenIds.push("mutated");
    expect(result.emergency.targetScreenIds).toEqual([screen.id]);
    expect(store.audits[0]).toMatchObject({
      action: "emergency.activated",
      entityId: result.emergency.id,
      ipAddress: "192.0.2.20",
      requestId: "emergency-activate",
      metadata: { targetCount: 1 },
    });

    await expect(
      store.clearEmergencyAndAudit("org-a", result.emergency.id, {
        actorUserId: actor.id,
        requestId: "emergency-clear",
      }),
    ).resolves.toMatchObject({ cleared: true });
    expect(result.emergency.clearedAt).toBeDefined();
    expect(store.audits[1]).toMatchObject({
      action: "emergency.cleared",
      entityId: result.emergency.id,
      requestId: "emergency-clear",
    });
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
