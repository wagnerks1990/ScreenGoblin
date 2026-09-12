import {
  MEDIA_MAX_ASSET_BYTES,
  MEDIA_MAX_RELEASE_BYTES,
  SUPPORTED_MEDIA_MIME_TYPES,
} from "@screengoblin/contracts";
import type { MediaKind } from "../domain/types.js";

interface PolicyMediaAsset {
  kind: MediaKind;
  mimeType: string;
  checksumSha256: string;
  sizeBytes: number;
  expiresAt?: string | undefined;
}

export type MediaPublicationFailure =
  "ASSET_UNSUPPORTED" | "ASSET_EXPIRED" | "RELEASE_TOO_LARGE";

export const isSupportedMedia = (kind: MediaKind, mimeType: string): boolean =>
  (SUPPORTED_MEDIA_MIME_TYPES[kind] as readonly string[]).includes(mimeType);

export const mediaPublicationFailure = (
  assets: readonly PolicyMediaAsset[],
  at: Date,
): MediaPublicationFailure | undefined => {
  let aggregateBytes = 0;
  for (const asset of assets) {
    if (
      !isSupportedMedia(asset.kind, asset.mimeType) ||
      !Number.isSafeInteger(asset.sizeBytes) ||
      asset.sizeBytes < 1 ||
      asset.sizeBytes > MEDIA_MAX_ASSET_BYTES ||
      !/^[a-f\d]{64}$/i.test(asset.checksumSha256)
    )
      return "ASSET_UNSUPPORTED";
    if (
      asset.expiresAt &&
      (!Number.isFinite(Date.parse(asset.expiresAt)) ||
        Date.parse(asset.expiresAt) <= at.getTime())
    )
      return "ASSET_EXPIRED";
    aggregateBytes += asset.sizeBytes;
    if (aggregateBytes > MEDIA_MAX_RELEASE_BYTES) return "RELEASE_TOO_LARGE";
  }
  return undefined;
};
