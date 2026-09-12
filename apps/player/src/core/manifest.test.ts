import { describe, expect, it } from "vitest";
import { ManifestError, ManifestManager, assertManifest } from "./manifest";
import type {
  AssetRepository,
  Credentials,
  PlayerManifest,
  PlayerStore,
} from "./types";

const valid: PlayerManifest = {
  version: "v2",
  generatedAt: "2026-09-11T00:00:00Z",
  validUntil: "2099-09-12T00:00:00Z",
  screenId: "screen-1",
  priority: "normal",
  withdrawn: false,
  items: [
    {
      id: "asset-1",
      kind: "image",
      url: "https://cdn.test/one.png",
      mimeType: "image/png",
      checksumSha256: "a".repeat(64),
      sizeBytes: 42,
      durationSeconds: 15,
    },
  ],
};

class MemoryStore implements PlayerStore {
  credentials: Credentials | undefined;
  active: PlayerManifest | undefined;
  previous: PlayerManifest | undefined;
  async getCredentials() {
    return this.credentials;
  }
  async putCredentials(value: Credentials) {
    this.credentials = value;
  }
  async getPendingPairing() {
    return undefined;
  }
  async putPendingPairing() {}
  async completePairing(value: Credentials) {
    await this.putCredentials(value);
  }
  async deletePendingPairing() {}
  async clearProvisionedState() {}
  async getActiveManifest() {
    return this.active;
  }
  async getPreviousManifest() {
    return this.previous;
  }
  async activateManifest(value: PlayerManifest) {
    const sameRelease = this.active?.version === value.version;
    if (
      !sameRelease &&
      this.active &&
      this.active.priority !== "emergency" &&
      !this.active.withdrawn
    )
      this.previous = this.active;
    this.active = value;
  }
  async rollback(expectedActiveVersion?: string) {
    if (
      expectedActiveVersion !== undefined &&
      this.active?.version !== expectedActiveVersion
    )
      return this.active;
    this.active = this.previous;
    return this.previous;
  }
  async clear() {
    this.active = undefined;
    this.previous = undefined;
  }
}

class MemoryAssets implements AssetRepository {
  prefetched: string[] = [];
  pruned: string[] = [];
  fail = false;
  async prefetch(asset: { id: string }) {
    if (this.fail) throw new Error("bad hash");
    this.prefetched.push(asset.id);
  }
  async resolve() {
    return "blob:test";
  }
  async prune(assets: Array<{ id: string }>) {
    this.pruned = assets.map((asset) => asset.id);
  }
  async removeAll() {
    this.prefetched = [];
  }
}

describe("manifest transaction", () => {
  it("prefetches before atomically activating", async () => {
    const store = new MemoryStore();
    const assets = new MemoryAssets();
    await new ManifestManager(store, assets).stageAndActivate(valid);
    expect(assets.prefetched).toEqual(["asset-1"]);
    expect(assets.pruned).toEqual(["asset-1"]);
    expect(store.active).toEqual(valid);
  });

  it("preserves the last-known-good manifest when staging fails", async () => {
    const store = new MemoryStore();
    const assets = new MemoryAssets();
    store.active = { ...valid, version: "v1" };
    assets.fail = true;
    await expect(
      new ManifestManager(store, assets).stageAndActivate(valid),
    ).rejects.toThrow("bad hash");
    expect(store.active.version).toBe("v1");
  });

  it("retains and restores the previous release", async () => {
    const store = new MemoryStore();
    const assets = new MemoryAssets();
    store.active = { ...valid, version: "v1" };
    const manager = new ManifestManager(store, assets);
    await manager.stageAndActivate(valid);
    expect((await manager.rollback())?.version).toBe("v1");
  });

  it("refreshes a repeated release envelope without rotating rollback history", async () => {
    const store = new MemoryStore();
    const assets = new MemoryAssets();
    const baseline = { ...valid, version: "v1" };
    store.active = baseline;
    const manager = new ManifestManager(store, assets);

    await manager.stageAndActivate(valid);
    const refreshed = {
      ...valid,
      generatedAt: "2026-09-11T00:01:00Z",
      validUntil: "2099-09-12T00:01:00Z",
    };
    await manager.stageAndActivate(refreshed);

    expect(assets.prefetched).toEqual(["asset-1"]);
    expect(store.active).toEqual(refreshed);
    expect(store.previous).toEqual(baseline);
  });

  it("rolls back a newly activated release after a playback failure", async () => {
    const store = new MemoryStore();
    const baseline = { ...valid, version: "v1" };
    store.active = baseline;
    const manager = new ManifestManager(store, new MemoryAssets());

    await manager.stageAndActivate(valid);

    expect((await manager.rollback())?.version).toBe("v1");
    expect(store.active).toEqual(baseline);
  });

  it("does not let a stale rollback overwrite a newer active release", async () => {
    const store = new MemoryStore();
    const stale = { ...valid, version: "stale" };
    const current = { ...valid, version: "current" };
    store.previous = { ...valid, version: "rollback-baseline" };
    store.active = current;

    const result = await new ManifestManager(
      store,
      new MemoryAssets(),
    ).rollback(stale.version);

    expect(result).toEqual(current);
    expect(store.active).toEqual(current);
  });

  it("atomically records a withdrawal without recovering stale playback", async () => {
    const store = new MemoryStore();
    const baseline = { ...valid, version: "v1" };
    store.active = baseline;
    const manager = new ManifestManager(store, new MemoryAssets());
    const withdrawal: PlayerManifest = {
      ...valid,
      version: "withdrawn-v2",
      priority: "normal",
      withdrawn: true,
      items: [],
    };

    await expect(manager.stageAndActivate(withdrawal)).resolves.toBeUndefined();
    expect(store.active).toEqual(withdrawal);
    expect(store.previous).toEqual(baseline);

    // A fresh manager represents an application reconnect/restart. The signed
    // blank marker must win over the retained safety rollback.
    await expect(
      new ManifestManager(store, new MemoryAssets()).recover(),
    ).resolves.toBeUndefined();
    expect(store.active).toEqual(withdrawal);
  });

  it("resumes a new release after reconnecting from a withdrawal", async () => {
    const store = new MemoryStore();
    const baseline = { ...valid, version: "v1" };
    store.previous = baseline;
    store.active = {
      ...valid,
      version: "withdrawn-v2",
      withdrawn: true,
      items: [],
    };
    const manager = new ManifestManager(store, new MemoryAssets());
    const republished = { ...valid, version: "v3" };

    await expect(manager.recover()).resolves.toBeUndefined();
    await expect(manager.stageAndActivate(republished)).resolves.toEqual(
      republished,
    );
    expect(store.active).toEqual(republished);
    expect(store.previous).toEqual(baseline);
  });

  it("activates an ended schedule marker without downloading or playing it", async () => {
    const store = new MemoryStore();
    const assets = new MemoryAssets();
    store.active = { ...valid, version: "old-schedule" };
    const ended = {
      ...valid,
      version: "ended-schedule",
      playbackEndsAt: "2020-01-01T00:00:00Z",
    };
    const manager = new ManifestManager(store, assets);

    await expect(manager.stageAndActivate(ended)).resolves.toBeUndefined();
    expect(assets.prefetched).toEqual([]);
    expect(store.active).toEqual(ended);
    await expect(manager.recover()).resolves.toBeUndefined();
    expect(store.active).toEqual(ended);
  });

  it("keeps normal last-known-good playback after only the envelope lease expires", async () => {
    const store = new MemoryStore();
    const leased = {
      ...valid,
      generatedAt: "2020-01-01T00:00:00Z",
      validUntil: "2020-01-01T00:05:00Z",
    };
    store.active = leased;

    await expect(
      new ManifestManager(store, new MemoryAssets()).recover(),
    ).resolves.toEqual(leased);
  });

  it("never recovers an expired emergency and restores normal content", async () => {
    const store = new MemoryStore();
    store.active = {
      ...valid,
      version: "emergency-expired",
      priority: "emergency",
      validUntil: "2020-01-01T00:01:00Z",
    };
    store.previous = { ...valid, version: "normal-last-known-good" };
    const recovered = await new ManifestManager(
      store,
      new MemoryAssets(),
    ).recover();
    expect(recovered?.version).toBe("normal-last-known-good");
    expect(store.active?.priority).toBe("normal");
  });

  it("preserves the normal baseline across repeated emergency polls and clear", async () => {
    const store = new MemoryStore();
    const manager = new ManifestManager(store, new MemoryAssets());
    const normal = { ...valid, version: "normal-v1" };
    const emergency = {
      ...valid,
      version: "emergency-v1",
      priority: "emergency" as const,
    };
    store.active = normal;
    await manager.stageAndActivate(emergency);
    await manager.stageAndActivate({ ...emergency, version: "emergency-v2" });
    expect(store.previous?.version).toBe("normal-v1");

    const restored = { ...normal, version: "normal-v2" };
    await manager.stageAndActivate(restored);
    expect((await manager.rollback())?.priority).toBe("normal");
    expect((await manager.rollback())?.version).toBe("normal-v1");
  });

  it("retains active emergency assets and the normal rollback baseline during pruning", async () => {
    const store = new MemoryStore();
    const assets = new MemoryAssets();
    const baseline = {
      ...valid,
      version: "normal-v1",
      items: [{ ...valid.items[0]!, id: "normal-asset" }],
    };
    store.active = baseline;
    const emergency = {
      ...valid,
      version: "emergency-v1",
      priority: "emergency" as const,
      items: [{ ...valid.items[0]!, id: "emergency-asset" }],
    };

    await new ManifestManager(store, assets).stageAndActivate(emergency);

    expect(assets.pruned).toEqual(["emergency-asset", "normal-asset"]);
  });
});

describe("manifest validation", () => {
  it("accepts only explicit empty normal withdrawals", () => {
    expect(() =>
      assertManifest({ ...valid, withdrawn: true, items: [] }),
    ).not.toThrow();
    expect(() =>
      assertManifest({ ...valid, withdrawn: false, items: [] }),
    ).toThrow("no playable items");
    expect(() =>
      assertManifest({
        ...valid,
        priority: "emergency",
        withdrawn: true,
        items: [],
      }),
    ).toThrow("empty normal releases");
    expect(() => assertManifest({ ...valid, withdrawn: true })).toThrow(
      "empty normal releases",
    );
  });

  it("rejects duplicate asset identifiers", () => {
    expect(() =>
      assertManifest({ ...valid, items: [valid.items[0], valid.items[0]] }),
    ).toThrow(ManifestError);
  });
  it("permits web content without a content checksum", () => {
    expect(() =>
      assertManifest({
        ...valid,
        items: [{ ...valid.items[0], kind: "web", checksumSha256: "" }],
      }),
    ).not.toThrow();
  });
  it("rejects executable URLs and oversized assets", () => {
    expect(() =>
      assertManifest({
        ...valid,
        items: [{ ...valid.items[0], url: "javascript:alert(1)" }],
      }),
    ).toThrow(ManifestError);
    expect(() =>
      assertManifest({
        ...valid,
        items: [{ ...valid.items[0], sizeBytes: 2 * 1024 * 1024 * 1024 + 1 }],
      }),
    ).toThrow(ManifestError);
  });

  it("rejects manifests generated too far in the future", () => {
    expect(() =>
      assertManifest({
        ...valid,
        generatedAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        validUntil: new Date(Date.now() + 20 * 60_000).toISOString(),
      }),
    ).toThrow("generation time is too far in the future");
  });

  it("rejects a malformed hard playback boundary", () => {
    expect(() =>
      assertManifest({ ...valid, playbackEndsAt: "not-a-date" }),
    ).toThrow("playback boundary is invalid");
  });
});
