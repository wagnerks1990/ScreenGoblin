import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSignedPlayerManifest } from "./manifest";
import { IndexedDbPlayerStore } from "./storage";
import type { SignedPlayerManifest } from "./types";

const signedManifest = (
  version: string,
  withdrawn = false,
): SignedPlayerManifest =>
  createSignedPlayerManifest(
    {
      protocolVersion: 2,
      mediaDelivery: "authorization-v1",
      version,
      generatedAt: "2026-09-12T00:00:00.000Z",
      validUntil: "2099-09-12T00:05:00.000Z",
      screenId: "screen-1",
      priority: "normal",
      withdrawn,
      items: withdrawn
        ? []
        : [
            {
              id: "playlist-item-1",
              position: 0,
              durationSeconds: 15,
              asset: {
                id: `asset-${version}`,
                kind: "image",
                url: `https://media.example.test/${version}.png`,
                mediaDelivery: "authorization-v1",
                mediaCapability: `${"a".repeat(48)}.${"b".repeat(43)}`,
                mimeType: "image/png",
                checksumSha256: "a".repeat(64),
                sizeBytes: 42,
              },
            },
          ],
    },
    "Ed25519",
    "test-signature",
  );

describe("IndexedDbPlayerStore rollback state", () => {
  beforeEach(async () => new IndexedDbPlayerStore().clear());
  afterEach(async () => new IndexedDbPlayerStore().clear());

  it("persists a withdrawal tombstone without a rollback slot across reboot", async () => {
    const firstProcess = new IndexedDbPlayerStore();
    const baseline = signedManifest("baseline");
    const withdrawal = signedManifest("withdrawal", true);
    const replacement = signedManifest("replacement");

    await firstProcess.activateManifest(baseline);
    await firstProcess.activateManifest(withdrawal);
    expect(await firstProcess.getPreviousManifest()).toBeUndefined();

    const rebootedProcess = new IndexedDbPlayerStore();
    expect(await rebootedProcess.getActiveManifest()).toEqual(withdrawal);
    expect(await rebootedProcess.getPreviousManifest()).toBeUndefined();

    await rebootedProcess.activateManifest(replacement);
    expect(await rebootedProcess.getPreviousManifest()).toBeUndefined();
  });

  it("retains normal A to B rollback behavior", async () => {
    const store = new IndexedDbPlayerStore();
    const baseline = signedManifest("baseline");
    const replacement = signedManifest("replacement");

    await store.activateManifest(baseline);
    await store.activateManifest(replacement);

    expect(await store.getPreviousManifest()).toEqual(baseline);
    expect(await store.rollback(replacement.manifest.version)).toEqual(
      baseline,
    );
  });
});
