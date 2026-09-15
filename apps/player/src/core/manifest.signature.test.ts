import { describe, expect, it } from "vitest";
import { ManifestManager } from "./manifest";
import type {
  AssetRepository,
  Credentials,
  PendingProofPairing,
  PlayerStore,
  SignedPlayerManifest,
} from "./types";

const verificationKey = "6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw";
const validSignature =
  "9CQuvlprzcxrX1pjj9voSF6PZBPoAWp15OKhnVQyweAgr7oQ7sxdOSu_6UcDAVMe_DO28hi0pjuQVqb1KqsGBA";
const trust = {
  screenId: "screen-1",
  manifestVerificationKey: verificationKey,
};

const unsigned = () => ({
  version: "manifest-1",
  generatedAt: "2026-09-11T00:00:00.000Z",
  validUntil: "2026-09-11T00:05:00.000Z",
  screenId: "screen-1",
  priority: "normal" as const,
  items: [
    {
      id: "playlist-item-1",
      position: 0,
      durationSeconds: 15,
      asset: {
        id: "asset-1",
        kind: "image" as const,
        url: "https://media.example.test/welcome.png",
        mimeType: "image/png",
        checksumSha256: "a".repeat(64),
        sizeBytes: 42,
      },
    },
  ],
});
const legacyEnvelope = (): SignedPlayerManifest => {
  const payload = unsigned();
  return {
    formatVersion: 1,
    payloadJson: JSON.stringify(payload),
    signatureAlgorithm: "Ed25519",
    signature: validSignature,
    manifest: {
      version: payload.version,
      generatedAt: payload.generatedAt,
      validUntil: payload.validUntil,
      screenId: payload.screenId,
      priority: payload.priority,
      withdrawn: false,
      items: payload.items.map((item) => ({
        ...item.asset,
        durationSeconds: item.durationSeconds,
      })),
    },
  };
};

class SignedMemoryStore implements PlayerStore {
  active: SignedPlayerManifest | undefined;
  previous: SignedPlayerManifest | undefined;
  clears = 0;
  async getCredentials(): Promise<Credentials | undefined> {
    return undefined;
  }
  async putCredentials() {}
  async getPendingPairing(): Promise<PendingProofPairing | undefined> {
    return undefined;
  }
  async putPendingPairing() {}
  async completePairing() {}
  async deletePendingPairing() {}
  async clearProvisionedState() {}
  async getActiveManifest() {
    return this.active;
  }
  async getPreviousManifest() {
    return this.previous;
  }
  async activateManifest(value: SignedPlayerManifest) {
    this.active = value;
  }
  async clearPreviousManifest(expectedActiveVersion?: string) {
    if (
      expectedActiveVersion === undefined ||
      this.active?.manifest.version === expectedActiveVersion
    )
      this.previous = undefined;
  }
  async rollback(_expectedActiveVersion?: string, eligibleUntilMs?: number) {
    if (eligibleUntilMs !== undefined && eligibleUntilMs <= Date.now()) {
      this.previous = undefined;
      return undefined;
    }
    this.active = this.previous;
    return this.active;
  }
  async clearManifests() {
    this.clears += 1;
    this.active = undefined;
    this.previous = undefined;
  }
  async clear() {
    await this.clearManifests();
  }
}

const assets: AssetRepository = {
  async prefetch() {},
  async resolve() {
    return "blob:test";
  },
  async removeAll() {},
};

describe("stored manifest signature verification", () => {
  it("recovers an intact exact signed payload offline", async () => {
    const store = new SignedMemoryStore();
    store.active = legacyEnvelope();

    await expect(
      new ManifestManager(store, assets).recover(trust),
    ).resolves.toMatchObject({
      version: "manifest-1",
      screenId: "screen-1",
    });
    expect(store.clears).toBe(0);
  });

  it("clears a payload changed after signature verification", async () => {
    const store = new SignedMemoryStore();
    store.active = legacyEnvelope();
    store.active.payloadJson = store.active.payloadJson.replace(
      '"priority":"normal"',
      '"priority":"emergency"',
    );

    await expect(
      new ManifestManager(store, assets).recover(trust),
    ).resolves.toBeUndefined();
    expect(store.clears).toBe(1);
  });

  it("clears an envelope verified against the wrong pinned key", async () => {
    const store = new SignedMemoryStore();
    store.active = legacyEnvelope();

    await expect(
      new ManifestManager(store, assets).recover({
        ...trust,
        manifestVerificationKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    ).resolves.toBeUndefined();
    expect(store.clears).toBe(1);
  });
});
