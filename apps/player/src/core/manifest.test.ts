import { describe, expect, it, vi } from "vitest";
import {
  ManifestError,
  ManifestManager,
  assertManifest,
  manifestPlaybackEndsAt,
  createSignedPlayerManifest,
} from "./manifest";
import { verifyManifestPayloadSignature } from "./crypto";
import type {
  AssetRepository,
  Credentials,
  PlayerManifest,
  PlayerStore,
  SignedPlayerManifest,
} from "./types";

vi.mock("./crypto", () => ({
  verifyManifestPayloadSignature: vi.fn().mockResolvedValue(true),
}));

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

const trust = {
  screenId: "screen-1",
  manifestVerificationKey: "test-verification-key",
};

const signed = (manifest: PlayerManifest): SignedPlayerManifest =>
  createSignedPlayerManifest(
    {
      version: manifest.version,
      generatedAt: manifest.generatedAt,
      validUntil: manifest.validUntil,
      screenId: manifest.screenId,
      priority: manifest.priority,
      withdrawn: manifest.withdrawn,
      ...(manifest.playbackEndsAt
        ? { playbackEndsAt: manifest.playbackEndsAt }
        : {}),
      items: manifest.items.map((asset, position) => ({
        id: `item-${position}`,
        position,
        durationSeconds: asset.durationSeconds,
        asset: Object.fromEntries(
          Object.entries(asset).filter(([key]) => key !== "durationSeconds"),
        ),
      })),
    },
    "Ed25519",
    "test-signature",
  );

class MemoryStore implements PlayerStore {
  credentials: Credentials | undefined;
  active: PlayerManifest | undefined;
  previous: PlayerManifest | undefined;
  rawActive: SignedPlayerManifest | undefined;
  rawPrevious: SignedPlayerManifest | undefined;
  manifestClears = 0;
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
    return this.rawActive ?? (this.active ? signed(this.active) : undefined);
  }
  async getPreviousManifest() {
    return (
      this.rawPrevious ?? (this.previous ? signed(this.previous) : undefined)
    );
  }
  async activateManifest(value: SignedPlayerManifest) {
    const sameRelease = this.active?.version === value.manifest.version;
    if (
      !sameRelease &&
      this.active &&
      this.active.priority !== "emergency" &&
      !this.active.withdrawn
    )
      this.previous = this.active;
    this.active = value.manifest;
    this.rawActive = undefined;
  }
  async rollback(expectedActiveVersion?: string) {
    if (
      expectedActiveVersion !== undefined &&
      this.active?.version !== expectedActiveVersion
    )
      return this.active ? signed(this.active) : undefined;
    this.active = this.previous;
    return this.previous ? signed(this.previous) : undefined;
  }
  async clearManifests() {
    this.manifestClears += 1;
    this.active = undefined;
    this.previous = undefined;
    this.rawActive = undefined;
    this.rawPrevious = undefined;
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
  it("recovers only an intact signed envelope for the pinned screen", async () => {
    const store = new MemoryStore();
    store.rawActive = signed(valid);

    await expect(
      new ManifestManager(store, new MemoryAssets()).recover(trust),
    ).resolves.toEqual(valid);

    store.rawActive = signed(valid);
    store.rawActive.manifest.playbackEndsAt = "2099-01-01T00:00:00Z";
    await expect(
      new ManifestManager(store, new MemoryAssets()).recover(trust),
    ).resolves.toBeUndefined();
    expect(store.manifestClears).toBe(1);
  });

  it("fails closed and removes legacy unsigned cached manifests", async () => {
    const store = new MemoryStore();
    store.rawActive = valid as unknown as SignedPlayerManifest;

    await expect(
      new ManifestManager(store, new MemoryAssets()).recover(trust),
    ).resolves.toBeUndefined();
    expect(store.manifestClears).toBe(1);
    expect(store.active).toBeUndefined();
  });

  it("rejects a stored envelope whose signature no longer verifies", async () => {
    const store = new MemoryStore();
    store.rawActive = signed(valid);
    vi.mocked(verifyManifestPayloadSignature).mockResolvedValueOnce(false);

    await expect(
      new ManifestManager(store, new MemoryAssets()).recover(trust),
    ).resolves.toBeUndefined();
    expect(store.manifestClears).toBe(1);
  });

  it("verifies a rollback envelope before promoting it", async () => {
    const store = new MemoryStore();
    store.active = { ...valid, version: "current" };
    store.rawPrevious = signed({ ...valid, version: "previous" });
    store.rawPrevious.manifest.priority = "emergency";

    await expect(
      new ManifestManager(store, new MemoryAssets()).rollback(trust, "current"),
    ).resolves.toBeUndefined();
    expect(store.manifestClears).toBe(1);
  });

  it("does not revive a previous release when the active marker is missing", async () => {
    const store = new MemoryStore();
    store.previous = { ...valid, version: "previous" };

    await expect(
      new ManifestManager(store, new MemoryAssets()).recover(trust),
    ).resolves.toBeUndefined();
    expect(store.manifestClears).toBe(1);
    expect(store.previous).toBeUndefined();
  });

  it("prefetches before atomically activating", async () => {
    const store = new MemoryStore();
    const assets = new MemoryAssets();
    await new ManifestManager(store, assets).stageAndActivate(
      signed(valid),
      trust,
    );
    expect(assets.prefetched).toEqual(["asset-1"]);
    expect(assets.pruned).toEqual(["asset-1"]);
    expect(store.active).toEqual(valid);
  });

  it("does not trust a tampered active hint when deciding whether to prefetch", async () => {
    const store = new MemoryStore();
    const assets = new MemoryAssets();
    store.rawActive = signed({ ...valid, version: "old" });
    store.rawActive.manifest.version = valid.version;

    await new ManifestManager(store, assets).stageAndActivate(
      signed(valid),
      trust,
    );

    expect(store.manifestClears).toBe(1);
    expect(assets.prefetched).toEqual(["asset-1"]);
    expect(store.active).toEqual(valid);
  });

  it("does not let stalled asset staging block an emergency rollback", async () => {
    const store = new MemoryStore();
    let finishPrefetch!: () => void;
    class StalledAssets extends MemoryAssets {
      override async prefetch(): Promise<void> {
        await new Promise<void>((resolve) => {
          finishPrefetch = resolve;
        });
      }
    }
    const manager = new ManifestManager(store, new StalledAssets());
    store.active = {
      ...valid,
      version: "emergency-v1",
      priority: "emergency",
      generatedAt: "2019-01-01T00:00:00Z",
      validUntil: "2020-01-01T00:00:00Z",
    };
    store.previous = { ...valid, version: "normal-baseline" };
    const activate = manager.stageAndActivate(
      signed({ ...valid, version: "replacement-v1" }),
      trust,
    );
    await vi.waitFor(() => expect(finishPrefetch).toBeTypeOf("function"));
    const rollback = manager.rollback(trust, "emergency-v1");

    await expect(rollback).resolves.toMatchObject({
      version: "normal-baseline",
    });
    finishPrefetch();
    await expect(activate).resolves.toMatchObject({
      version: "replacement-v1",
    });
  });

  it("serializes a fresh activation after stale recovery cleanup", async () => {
    const store = new MemoryStore();
    const manager = new ManifestManager(store, new MemoryAssets());
    store.rawActive = signed({ ...valid, version: "corrupt-old" });
    let finishVerification!: (valid: boolean) => void;
    vi.mocked(verifyManifestPayloadSignature).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishVerification = resolve;
        }),
    );

    const recovery = manager.recover(trust);
    await vi.waitFor(() => expect(finishVerification).toBeTypeOf("function"));
    const activation = manager.stageAndActivate(signed(valid), trust);
    finishVerification(false);

    await expect(recovery).resolves.toBeUndefined();
    await expect(activation).resolves.toEqual(valid);
    expect(store.manifestClears).toBe(1);
    expect(store.active).toEqual(valid);
  });

  it("preserves the last-known-good manifest when staging fails", async () => {
    const store = new MemoryStore();
    const assets = new MemoryAssets();
    store.active = { ...valid, version: "v1" };
    assets.fail = true;
    await expect(
      new ManifestManager(store, assets).stageAndActivate(signed(valid), trust),
    ).rejects.toThrow("bad hash");
    expect(store.active.version).toBe("v1");
  });

  it("retains and restores the previous release", async () => {
    const store = new MemoryStore();
    const assets = new MemoryAssets();
    store.active = { ...valid, version: "v1" };
    const manager = new ManifestManager(store, assets);
    await manager.stageAndActivate(signed(valid), trust);
    expect((await manager.rollback(trust))?.version).toBe("v1");
  });

  it("refreshes a repeated release envelope without rotating rollback history", async () => {
    const store = new MemoryStore();
    const assets = new MemoryAssets();
    const baseline = { ...valid, version: "v1" };
    store.active = baseline;
    const manager = new ManifestManager(store, assets);

    await manager.stageAndActivate(signed(valid), trust);
    const refreshed = {
      ...valid,
      generatedAt: "2026-09-11T00:01:00Z",
      validUntil: "2099-09-12T00:01:00Z",
    };
    await manager.stageAndActivate(signed(refreshed), trust);

    expect(assets.prefetched).toEqual(["asset-1"]);
    expect(store.active).toEqual(refreshed);
    expect(store.previous).toEqual(baseline);
  });

  it("rolls back a newly activated release after a playback failure", async () => {
    const store = new MemoryStore();
    const baseline = { ...valid, version: "v1" };
    store.active = baseline;
    const manager = new ManifestManager(store, new MemoryAssets());

    await manager.stageAndActivate(signed(valid), trust);

    expect((await manager.rollback(trust))?.version).toBe("v1");
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
    ).rollback(trust, stale.version);

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

    await expect(
      manager.stageAndActivate(signed(withdrawal), trust),
    ).resolves.toBeUndefined();
    expect(store.active).toEqual(withdrawal);
    expect(store.previous).toEqual(baseline);

    // A fresh manager represents an application reconnect/restart. The signed
    // blank marker must win over the retained safety rollback.
    await expect(
      new ManifestManager(store, new MemoryAssets()).recover(trust),
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

    await expect(manager.recover(trust)).resolves.toBeUndefined();
    await expect(
      manager.stageAndActivate(signed(republished), trust),
    ).resolves.toEqual(republished);
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

    await expect(
      manager.stageAndActivate(signed(ended), trust),
    ).resolves.toBeUndefined();
    expect(assets.prefetched).toEqual([]);
    expect(store.active).toEqual(ended);
    await expect(manager.recover(trust)).resolves.toBeUndefined();
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
      new ManifestManager(store, new MemoryAssets()).recover(trust),
    ).resolves.toEqual(leased);
  });

  it("does not activate or recover media after its signed expiry", async () => {
    const store = new MemoryStore();
    const assets = new MemoryAssets();
    const expired = {
      ...valid,
      generatedAt: "2020-01-01T00:00:00Z",
      items: [
        {
          ...valid.items[0]!,
          expiresAt: "2020-01-01T00:01:00Z",
        },
      ],
    };
    const manager = new ManifestManager(store, assets);

    await expect(
      manager.stageAndActivate(signed(expired), trust),
    ).resolves.toBeUndefined();
    expect(assets.prefetched).toEqual([]);
    await expect(manager.recover(trust)).resolves.toBeUndefined();

    store.active = { ...valid, version: "current" };
    store.previous = expired;
    await expect(manager.rollback(trust, "current")).resolves.toBeUndefined();
  });

  it("does not recover a legacy cached web manifest", async () => {
    const store = new MemoryStore();
    const invalid = signed(valid);
    invalid.manifest.items = [
      { ...valid.items[0]!, kind: "web", mimeType: "text/html" },
    ];
    store.rawActive = invalid;

    await expect(
      new ManifestManager(store, new MemoryAssets()).recover(trust),
    ).resolves.toBeUndefined();
  });

  it("never recovers an expired emergency and restores normal content", async () => {
    const store = new MemoryStore();
    store.active = {
      ...valid,
      version: "emergency-expired",
      priority: "emergency",
      generatedAt: "2019-01-01T00:00:00Z",
      validUntil: "2020-01-01T00:01:00Z",
    };
    store.previous = { ...valid, version: "normal-last-known-good" };
    const recovered = await new ManifestManager(
      store,
      new MemoryAssets(),
    ).recover(trust);
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
    await manager.stageAndActivate(signed(emergency), trust);
    await manager.stageAndActivate(
      signed({ ...emergency, version: "emergency-v2" }),
      trust,
    );
    expect(store.previous?.version).toBe("normal-v1");

    const restored = { ...normal, version: "normal-v2" };
    await manager.stageAndActivate(signed(restored), trust);
    expect((await manager.rollback(trust))?.priority).toBe("normal");
    expect((await manager.rollback(trust))?.version).toBe("normal-v1");
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

    await new ManifestManager(store, assets).stageAndActivate(
      signed(emergency),
      trust,
    );

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
  it("denies ordinary web content and unsupported MIME pairs", () => {
    expect(() =>
      assertManifest({
        ...valid,
        items: [
          {
            ...valid.items[0],
            kind: "web",
            mimeType: "text/html",
            checksumSha256: "",
          },
        ],
      }),
    ).toThrow(ManifestError);
    expect(() =>
      assertManifest({
        ...valid,
        items: [{ ...valid.items[0], mimeType: "image/svg+xml" }],
      }),
    ).toThrow(ManifestError);
    expect(() =>
      assertManifest({
        ...valid,
        items: [
          {
            ...valid.items[0],
            url: "https://user:secret@cdn.test/legacy.png",
          },
        ],
      }),
    ).toThrow(ManifestError);
  });

  it("preserves the signed emergency template exception", () => {
    expect(() =>
      assertManifest({
        ...valid,
        priority: "emergency",
        items: [
          {
            ...valid.items[0],
            kind: "template",
            mimeType: "application/vnd.screengoblin.emergency+json",
            url: "data:application/json;base64,e30=",
          },
        ],
      }),
    ).not.toThrow();
  });

  it("validates signed asset expiry and uses the earliest playback boundary", () => {
    const expiring = {
      ...valid,
      playbackEndsAt: "2099-09-12T00:02:00Z",
      items: [
        {
          ...valid.items[0]!,
          expiresAt: "2099-09-12T00:01:00Z",
        },
      ],
    };
    expect(() => assertManifest(expiring)).not.toThrow();
    expect(manifestPlaybackEndsAt(expiring)).toBe(
      Date.parse("2099-09-12T00:01:00Z"),
    );
    expect(() =>
      assertManifest({
        ...valid,
        items: [{ ...valid.items[0]!, expiresAt: "not-a-date" }],
      }),
    ).toThrow("expiry is invalid");
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
