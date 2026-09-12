import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/store/memory.js";

const actor = {
  id: "actor",
  email: "actor@example.test",
  name: "Actor",
  passwordHash: "unused",
  organizationId: "org-a",
  role: "OWNER" as const,
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
