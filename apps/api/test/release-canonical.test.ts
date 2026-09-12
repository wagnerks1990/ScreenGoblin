import { describe, expect, it } from "vitest";
import type { MediaRecord, PlaylistRecord } from "../src/domain/types.js";
import {
  assignmentSnapshotDigest,
  canonicalAssignmentSnapshot,
  canonicalReleaseSnapshot,
  ReleaseSnapshotError,
  releaseSnapshotDigest,
} from "../src/releases/canonical.js";

const timestamp = "2026-09-12T00:00:00.000Z";
const asset = (id: string): MediaRecord => ({
  id,
  organizationId: "org-a",
  name: `Asset ${id}`,
  kind: "image",
  mimeType: "image/png",
  url: `https://media.example.test/${id}.png`,
  checksumSha256: id.repeat(64).slice(0, 64),
  sizeBytes: 3,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const playlist = (items: PlaylistRecord["items"]): PlaylistRecord => ({
  id: "playlist-a",
  organizationId: "org-a",
  name: "Lobby",
  description: "Welcome",
  items,
  createdAt: timestamp,
  updatedAt: timestamp,
});

describe("canonical release snapshots", () => {
  it("sorts items and produces a stable golden digest", () => {
    const snapshot = canonicalReleaseSnapshot(
      playlist([
        { id: "item-b", assetId: "b", position: 1, durationSeconds: 20 },
        { id: "item-a", assetId: "a", position: 0, durationSeconds: 10 },
      ]),
      [asset("b"), asset("a")],
    );
    expect(snapshot.items.map((item) => item.id)).toEqual(["item-a", "item-b"]);
    expect(releaseSnapshotDigest(snapshot)).toBe(
      "24fe8d5c9e4fe1c49b770ffffd3ec5ae75132fc29484336f672b8936acfcc316",
    );
    expect(releaseSnapshotDigest(snapshot)).toBe(
      releaseSnapshotDigest(
        canonicalReleaseSnapshot(
          playlist([
            { id: "item-a", assetId: "a", position: 0, durationSeconds: 10 },
            { id: "item-b", assetId: "b", position: 1, durationSeconds: 20 },
          ]),
          [asset("a"), asset("b")],
        ),
      ),
    );
  });

  it("binds assignment identity to targets and the frozen playback window", () => {
    const base = {
      releaseDigestSha256: "a".repeat(64),
      state: "ASSIGNED" as const,
      schedule: {
        name: "School day",
        priority: "normal" as const,
        startsAt: "2026-09-12T12:00:00.000Z",
        endsAt: "2026-09-12T20:00:00.000Z",
        timezone: "UTC",
        daysOfWeek: [5, 1],
        dailyStartMinutes: 480,
        dailyEndMinutes: 1020,
        enabled: true,
      },
      screenIds: ["screen-b", "screen-a"],
    };
    const digest = assignmentSnapshotDigest(canonicalAssignmentSnapshot(base));
    expect(digest).toBe(
      assignmentSnapshotDigest(
        canonicalAssignmentSnapshot({
          ...base,
          screenIds: ["screen-a", "screen-b", "screen-a"],
          schedule: { ...base.schedule, daysOfWeek: [1, 5, 1] },
        }),
      ),
    );
    expect(
      assignmentSnapshotDigest(
        canonicalAssignmentSnapshot({
          ...base,
          screenIds: ["screen-a"],
        }),
      ),
    ).not.toBe(digest);
    expect(
      assignmentSnapshotDigest(
        canonicalAssignmentSnapshot({
          ...base,
          schedule: {
            ...base.schedule,
            endsAt: "2026-09-12T19:00:00.000Z",
          },
        }),
      ),
    ).not.toBe(digest);
  });

  it("binds release identity to URL and checksum facts", () => {
    const source = playlist([
      { id: "item-a", assetId: "a", position: 0, durationSeconds: 10 },
    ]);
    const originalAsset = asset("a");
    const digest = releaseSnapshotDigest(
      canonicalReleaseSnapshot(source, [originalAsset]),
    );
    expect(
      releaseSnapshotDigest(
        canonicalReleaseSnapshot(source, [
          { ...originalAsset, url: `${originalAsset.url}?revision=2` },
        ]),
      ),
    ).not.toBe(digest);
    expect(
      releaseSnapshotDigest(
        canonicalReleaseSnapshot(source, [
          { ...originalAsset, checksumSha256: "f".repeat(64) },
        ]),
      ),
    ).not.toBe(digest);
  });

  it("changes the digest when frozen playback facts change", () => {
    const source = playlist([
      { id: "item-a", assetId: "a", position: 0, durationSeconds: 10 },
    ]);
    const first = canonicalReleaseSnapshot(source, [asset("a")]);
    const changed = canonicalReleaseSnapshot(
      {
        ...source,
        items: [{ ...source.items[0]!, durationSeconds: 11 }],
      },
      [asset("a")],
    );
    expect(releaseSnapshotDigest(changed)).not.toBe(
      releaseSnapshotDigest(first),
    );
  });

  it("fails closed for empty snapshots and unresolved assets", () => {
    expect(() => canonicalReleaseSnapshot(playlist([]), [])).toThrowError(
      new ReleaseSnapshotError("NO_PLAYABLE_ITEMS"),
    );
    expect(() =>
      canonicalReleaseSnapshot(
        playlist([
          { id: "item-a", assetId: "a", position: 0, durationSeconds: 10 },
        ]),
        [],
      ),
    ).toThrowError(new ReleaseSnapshotError("ASSET_NOT_FOUND"));
  });
});
