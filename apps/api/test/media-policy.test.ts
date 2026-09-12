import {
  MEDIA_MAX_ASSET_BYTES,
  MEDIA_MAX_RELEASE_BYTES,
} from "@screengoblin/contracts";
import { describe, expect, it } from "vitest";
import type { MediaRecord } from "../src/domain/types.js";
import {
  isSupportedMedia,
  mediaPublicationFailure,
} from "../src/utils/media-policy.js";

const now = new Date("2026-09-12T12:00:00.000Z");
const asset = (overrides: Partial<MediaRecord> = {}): MediaRecord => ({
  id: "asset-a",
  organizationId: "org-a",
  name: "Asset",
  kind: "image",
  mimeType: "image/png",
  url: "https://media.example.test/asset.png",
  checksumSha256: "a".repeat(64),
  sizeBytes: 1,
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
  ...overrides,
});

describe("media publication policy", () => {
  it("allows only the bounded pilot MIME matrix and disables web content", () => {
    expect(isSupportedMedia("image", "image/png")).toBe(true);
    expect(isSupportedMedia("image", "image/jpeg")).toBe(true);
    expect(isSupportedMedia("video", "video/mp4")).toBe(true);
    expect(isSupportedMedia("template", "application/json")).toBe(true);
    expect(isSupportedMedia("image", "image/svg+xml")).toBe(false);
    expect(isSupportedMedia("video", "text/html")).toBe(false);
    expect(isSupportedMedia("web", "text/html")).toBe(false);
  });

  it("fails closed for malformed, expired, or oversized assets", () => {
    expect(mediaPublicationFailure([asset()], now)).toBeUndefined();
    expect(
      mediaPublicationFailure([asset({ checksumSha256: "not-a-hash" })], now),
    ).toBe("ASSET_UNSUPPORTED");
    expect(
      mediaPublicationFailure(
        [asset({ sizeBytes: MEDIA_MAX_ASSET_BYTES + 1 })],
        now,
      ),
    ).toBe("ASSET_UNSUPPORTED");
    expect(
      mediaPublicationFailure([asset({ expiresAt: now.toISOString() })], now),
    ).toBe("ASSET_EXPIRED");
  });

  it("enforces the aggregate release limit across repeated playlist assets", () => {
    const quarter = MEDIA_MAX_RELEASE_BYTES / 4;
    const allowed = Array.from({ length: 4 }, (_, index) =>
      asset({ id: `asset-${index}`, sizeBytes: quarter }),
    );
    expect(mediaPublicationFailure(allowed, now)).toBeUndefined();
    expect(
      mediaPublicationFailure([...allowed, asset({ id: "asset-5" })], now),
    ).toBe("RELEASE_TOO_LARGE");
  });
});
