import { verifySha256 } from "./crypto";
import type { AssetRepository, PlayerAsset } from "./types";

const CACHE_NAME = "screengoblin-content-v1";

function cacheKey(asset: PlayerAsset): Request {
  const url = new URL(
    `/__sg_asset__/${encodeURIComponent(asset.id)}/${asset.checksumSha256}`,
    location.origin,
  );
  return new Request(url);
}

export class CacheAssetRepository implements AssetRepository {
  async prefetch(asset: PlayerAsset): Promise<void> {
    if (asset.kind === "web") return;
    const cache = await caches.open(CACHE_NAME);
    const key = cacheKey(asset);
    if (await cache.match(key)) return;
    const response = await fetch(asset.url, { cache: "no-store" });
    if (!response.ok)
      throw new Error(
        `Download failed for ${asset.id}: HTTP ${response.status}`,
      );
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== asset.sizeBytes)
      throw new Error(`Size mismatch for ${asset.id}`);
    if (!(await verifySha256(buffer, asset.checksumSha256)))
      throw new Error(`Checksum mismatch for ${asset.id}`);
    await cache.put(
      key,
      new Response(buffer, {
        headers: {
          "Content-Type": asset.mimeType,
          "Content-Length": String(buffer.byteLength),
        },
      }),
    );
  }

  async resolve(asset: PlayerAsset): Promise<string> {
    if (asset.kind === "web") return asset.url;
    const response = await (
      await caches.open(CACHE_NAME)
    ).match(cacheKey(asset));
    if (!response) throw new Error(`Cached asset unavailable: ${asset.id}`);
    return URL.createObjectURL(await response.blob());
  }

  async removeAll(): Promise<void> {
    await caches.delete(CACHE_NAME);
  }
}
