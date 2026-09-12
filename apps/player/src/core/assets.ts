import { verifySha256 } from "./crypto";
import type { AssetRepository, PlayerAsset } from "./types";

const CACHE_NAME = "screengoblin-content-v1";
const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 2;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_AGGREGATE_BYTES = 512 * 1024 * 1024;
// CacheStorage cannot incrementally hash a response. Keep the maximum single
// in-memory verification buffer realistic for an Android TV WebView.
const DEFAULT_MAX_BUFFERED_ASSET_BYTES = 128 * 1024 * 1024;

export interface CacheAssetRepositoryOptions {
  maxConcurrentDownloads?: number;
  requestTimeoutMs?: number;
  maxAggregateBytes?: number;
  maxBufferedAssetBytes?: number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function cacheKey(asset: PlayerAsset): Request {
  const url = new URL(
    `/__sg_asset__/${encodeURIComponent(asset.id)}/${asset.checksumSha256}`,
    location.origin,
  );
  return new Request(url);
}

function declaredContentLength(response: Response, asset: PlayerAsset): void {
  const value = response.headers.get("Content-Length");
  if (value === null) return;
  if (!/^\d+$/.test(value))
    throw new Error(`Invalid Content-Length for ${asset.id}`);
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > asset.sizeBytes)
    throw new Error(`Download exceeds size limit for ${asset.id}`);
}

async function boundedBody(
  response: Response,
  asset: PlayerAsset,
): Promise<ArrayBuffer> {
  declaredContentLength(response, asset);
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`Download body is unavailable for ${asset.id}`);

  const buffer = new Uint8Array(asset.sizeBytes);
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (value.byteLength > asset.sizeBytes - received) {
        await reader.cancel("asset size limit exceeded");
        throw new Error(`Download exceeds size limit for ${asset.id}`);
      }
      buffer.set(value, received);
      received += value.byteLength;
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // The stream may already be errored or cancelled.
    }
    throw error;
  }

  if (received !== asset.sizeBytes)
    throw new Error(`Size mismatch for ${asset.id}`);
  return buffer.buffer;
}

export class CacheAssetRepository implements AssetRepository {
  private readonly maxConcurrentDownloads: number;
  private readonly requestTimeoutMs: number;
  private readonly maxAggregateBytes: number;
  private readonly maxBufferedAssetBytes: number;
  private activeDownloads = 0;
  private reservedBytes = 0;
  private readonly downloadWaiters: Array<() => void> = [];
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(options: CacheAssetRepositoryOptions = {}) {
    this.maxConcurrentDownloads = positiveInteger(
      options.maxConcurrentDownloads ?? DEFAULT_MAX_CONCURRENT_DOWNLOADS,
      "maxConcurrentDownloads",
    );
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    this.maxAggregateBytes = positiveInteger(
      options.maxAggregateBytes ?? DEFAULT_MAX_AGGREGATE_BYTES,
      "maxAggregateBytes",
    );
    this.maxBufferedAssetBytes = positiveInteger(
      options.maxBufferedAssetBytes ?? DEFAULT_MAX_BUFFERED_ASSET_BYTES,
      "maxBufferedAssetBytes",
    );
  }

  private reserve(asset: PlayerAsset): () => void {
    if (
      !Number.isSafeInteger(asset.sizeBytes) ||
      asset.sizeBytes < 0 ||
      asset.sizeBytes > this.maxAggregateBytes - this.reservedBytes
    )
      throw new Error("Asset staging exceeds aggregate size limit");
    this.reservedBytes += asset.sizeBytes;
    return () => {
      this.reservedBytes -= asset.sizeBytes;
    };
  }

  private async acquireDownloadSlot(): Promise<() => void> {
    if (
      this.activeDownloads >= this.maxConcurrentDownloads ||
      this.downloadWaiters.length > 0
    ) {
      await new Promise<void>((resolve) => this.downloadWaiters.push(resolve));
    } else {
      this.activeDownloads += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.downloadWaiters.shift();
      if (next) next();
      else this.activeDownloads -= 1;
    };
  }

  async prefetch(asset: PlayerAsset): Promise<void> {
    if (asset.kind === "web") return;
    const key = cacheKey(asset);
    const existing = this.inFlight.get(key.url);
    if (existing) return existing;
    const operation = this.prefetchOnce(asset, key);
    this.inFlight.set(key.url, operation);
    try {
      await operation;
    } finally {
      if (this.inFlight.get(key.url) === operation)
        this.inFlight.delete(key.url);
    }
  }

  private async prefetchOnce(asset: PlayerAsset, key: Request): Promise<void> {
    const releaseReservation = this.reserve(asset);
    let releaseSlot: (() => void) | undefined;
    try {
      releaseSlot = await this.acquireDownloadSlot();
      const cache = await caches.open(CACHE_NAME);
      if (asset.sizeBytes > this.maxBufferedAssetBytes)
        throw new Error(`Asset ${asset.id} exceeds in-memory staging limit`);
      const cached = await cache.match(key);
      if (cached) {
        try {
          const buffer = await boundedBody(cached, asset);
          if (await verifySha256(buffer, asset.checksumSha256)) return;
        } catch {
          // Treat unreadable persistent bytes as corrupt and replace them from
          // the signed source below. A cache-key match alone is not integrity.
        }
        await cache.delete(key);
      }

      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort("asset download timed out"),
        this.requestTimeoutMs,
      );
      try {
        const response = await fetch(asset.url, {
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(
            `Download failed for ${asset.id}: HTTP ${response.status}`,
          );
        const buffer = await boundedBody(response, asset);
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
      } catch (error) {
        if (controller.signal.aborted)
          throw new Error(`Download timed out for ${asset.id}`, {
            cause: error,
          });
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      releaseSlot?.();
      releaseReservation();
    }
  }

  async resolve(asset: PlayerAsset): Promise<string> {
    if (asset.kind === "web") return asset.url;
    if (asset.sizeBytes > this.maxBufferedAssetBytes)
      throw new Error(`Asset ${asset.id} exceeds in-memory playback limit`);
    const cache = await caches.open(CACHE_NAME);
    const key = cacheKey(asset);
    const response = await cache.match(key);
    if (!response) throw new Error(`Cached asset unavailable: ${asset.id}`);
    try {
      const buffer = await boundedBody(response, asset);
      if (!(await verifySha256(buffer, asset.checksumSha256)))
        throw new Error(`Checksum mismatch for ${asset.id}`);
      return URL.createObjectURL(new Blob([buffer], { type: asset.mimeType }));
    } catch (error) {
      await cache.delete(key);
      throw error;
    }
  }

  async prune(retainedAssets: PlayerAsset[]): Promise<void> {
    const retained = new Set(
      retainedAssets
        .filter((asset) => asset.kind !== "web")
        .map((asset) => cacheKey(asset).url),
    );
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    for (const key of keys) {
      if (!retained.has(key.url)) await cache.delete(key);
    }
  }

  async removeAll(): Promise<void> {
    await caches.delete(CACHE_NAME);
  }
}
