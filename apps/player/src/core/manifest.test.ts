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
  validUntil: "2026-09-12T00:00:00Z",
  screenId: "screen-1",
  priority: "normal",
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
  async getActiveManifest() {
    return this.active;
  }
  async getPreviousManifest() {
    return this.previous;
  }
  async activateManifest(value: PlayerManifest) {
    this.previous = this.active;
    this.active = value;
  }
  async rollback() {
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
  fail = false;
  async prefetch(asset: { id: string }) {
    if (this.fail) throw new Error("bad hash");
    this.prefetched.push(asset.id);
  }
  async resolve() {
    return "blob:test";
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
});

describe("manifest validation", () => {
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
});
