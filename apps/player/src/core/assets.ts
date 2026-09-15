import { Capacitor, registerPlugin } from "@capacitor/core";
import { verifySha256 } from "./crypto";
import type { AssetRepository, PlayerAsset } from "./types";

const CACHE_NAME = "screengoblin-content-v1";
const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 2;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_AGGREGATE_BYTES = 512 * 1024 * 1024;
// CacheStorage cannot incrementally hash a response. Keep the maximum single
// in-memory verification buffer realistic for an Android TV WebView.
const DEFAULT_MAX_BUFFERED_ASSET_BYTES = 128 * 1024 * 1024;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const NATIVE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "video/mp4",
  "application/json",
]);
const EMERGENCY_TEMPLATE_MIME = "application/vnd.screengoblin.emergency+json";

interface NativeAssetOptions {
  assetId: string;
  url: string;
  mediaCapability: string;
  mimeType: string;
  checksumSha256: string;
  sizeBytes: number;
}

interface NativeAssetIdentity {
  assetId: string;
  mimeType: string;
  checksumSha256: string;
  sizeBytes: number;
}

interface NativeAssetPath {
  path: string;
}

interface NativeAssetCachePlugin {
  prefetch(options: NativeAssetOptions): Promise<NativeAssetPath>;
  resolve(options: NativeAssetIdentity): Promise<NativeAssetPath>;
  prune(options: {
    retainedAssets: Array<Omit<NativeAssetIdentity, "sizeBytes">>;
  }): Promise<void>;
  removeAll(): Promise<void>;
  storageStats(): Promise<{ availableBytes: number }>;
}

const nativeAssetCache =
  registerPlugin<NativeAssetCachePlugin>("NativeAssetCache");

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

function nativeAssetOptions(asset: PlayerAsset): NativeAssetOptions {
  if (
    !asset.id ||
    !asset.url ||
    asset.mediaDelivery !== "authorization-v1" ||
    !asset.mediaCapability ||
    !NATIVE_MIME_TYPES.has(asset.mimeType) ||
    !SHA256_HEX.test(asset.checksumSha256) ||
    !Number.isSafeInteger(asset.sizeBytes) ||
    asset.sizeBytes < 1
  )
    throw new Error(
      `Invalid native asset metadata for ${asset.id || "unknown"}`,
    );
  return {
    assetId: asset.id,
    url: asset.url,
    mediaCapability: asset.mediaCapability,
    mimeType: asset.mimeType,
    checksumSha256: asset.checksumSha256,
    sizeBytes: asset.sizeBytes,
  };
}

function isInlineEmergencyTemplate(asset: PlayerAsset): boolean {
  return (
    asset.kind === "template" &&
    asset.mimeType === EMERGENCY_TEMPLATE_MIME &&
    asset.url.startsWith("data:application/json;base64,")
  );
}

function nativeAssetIdentity(asset: PlayerAsset): NativeAssetIdentity {
  if (
    !asset.id ||
    !NATIVE_MIME_TYPES.has(asset.mimeType) ||
    !SHA256_HEX.test(asset.checksumSha256) ||
    !Number.isSafeInteger(asset.sizeBytes) ||
    asset.sizeBytes < 1
  )
    throw new Error(
      `Invalid native asset metadata for ${asset.id || "unknown"}`,
    );
  return {
    assetId: asset.id,
    mimeType: asset.mimeType,
    checksumSha256: asset.checksumSha256,
    sizeBytes: asset.sizeBytes,
  };
}

function nativePlaybackUrl(result: NativeAssetPath, assetId: string): string {
  const containsControlCharacter =
    typeof result?.path === "string" &&
    Array.from(result.path).some((character) => {
      const codePoint = character.charCodeAt(0);
      return codePoint < 32 || codePoint === 127;
    });
  if (
    !result ||
    typeof result.path !== "string" ||
    !result.path.startsWith("file:///") ||
    containsControlCharacter
  )
    throw new Error(`Android returned an invalid cached path for ${assetId}`);
  const converted = Capacitor.convertFileSrc(result.path);
  if (typeof converted !== "string" || converted.length === 0)
    throw new Error(`Android returned an unusable cached path for ${assetId}`);
  return converted;
}

function throwCombinedFailures(operation: string, failures: unknown[]): void {
  if (failures.length === 0) return;
  throw new AggregateError(failures, `Failed to ${operation} all asset caches`);
}

function nativeErrorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
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
        const inlineEmergency = isInlineEmergencyTemplate(asset);
        if (
          !inlineEmergency &&
          (asset.mediaDelivery !== "authorization-v1" ||
            typeof asset.mediaCapability !== "string" ||
            !/^[A-Za-z0-9_-]{1,4052}\.[A-Za-z0-9_-]{43}$/.test(
              asset.mediaCapability,
            ))
        )
          throw new Error(`Asset authorization is invalid for ${asset.id}`);
        const response = await fetch(asset.url, {
          cache: "no-store",
          credentials: "omit",
          ...(inlineEmergency
            ? {}
            : {
                headers: {
                  Authorization: `MediaCapability ${asset.mediaCapability}`,
                },
              }),
          referrerPolicy: "no-referrer",
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

/** Android's bounded native cache, with resolve-only verified upgrade fallback. */
export class NativeAssetRepository implements AssetRepository {
  constructor(
    private readonly legacyRepository: AssetRepository = new CacheAssetRepository(),
  ) {}

  async prefetch(asset: PlayerAsset): Promise<void> {
    if (asset.kind === "web") return;
    if (isInlineEmergencyTemplate(asset)) {
      await this.legacyRepository.prefetch(asset);
      return;
    }
    const result = await nativeAssetCache.prefetch(nativeAssetOptions(asset));
    nativePlaybackUrl(result, asset.id);
  }

  async resolve(asset: PlayerAsset): Promise<string> {
    if (asset.kind === "web") return asset.url;
    if (isInlineEmergencyTemplate(asset))
      return await this.legacyRepository.resolve(asset);
    let result: NativeAssetPath;
    try {
      result = await nativeAssetCache.resolve(nativeAssetIdentity(asset));
    } catch (error) {
      if (nativeErrorCode(error) !== "CACHE_MISS") throw error;
      // Active signed content from an older build may exist only in
      // CacheStorage. Its resolve path rechecks exact size and SHA-256 and
      // never downloads, so this fallback cannot silently substitute network.
      return await this.legacyRepository.resolve(asset);
    }
    // A malformed native success is a hard error, never a fallback trigger.
    return nativePlaybackUrl(result, asset.id);
  }

  async prune(retainedAssets: PlayerAsset[]): Promise<void> {
    const retainedNative = retainedAssets
      .filter(
        (asset) => asset.kind !== "web" && !isInlineEmergencyTemplate(asset),
      )
      .map((asset) => {
        const { assetId, mimeType, checksumSha256 } =
          nativeAssetIdentity(asset);
        return { assetId, mimeType, checksumSha256 };
      });
    const results = await Promise.allSettled([
      nativeAssetCache.prune({ retainedAssets: retainedNative }),
      this.legacyRepository.prune?.(retainedAssets) ?? Promise.resolve(),
    ]);
    throwCombinedFailures(
      "prune",
      results
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => result.reason),
    );
  }

  async removeAll(): Promise<void> {
    const results = await Promise.allSettled([
      nativeAssetCache.removeAll(),
      this.legacyRepository.removeAll(),
    ]);
    throwCombinedFailures(
      "remove",
      results
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => result.reason),
    );
  }
}

export function createAssetRepository(): AssetRepository {
  return Capacitor.getPlatform() === "android"
    ? new NativeAssetRepository()
    : new CacheAssetRepository();
}

export async function nativeAvailableStorageBytes(): Promise<number> {
  const result = await nativeAssetCache.storageStats();
  if (
    !result ||
    !Number.isSafeInteger(result.availableBytes) ||
    result.availableBytes < 0
  )
    throw new Error("Android returned invalid asset storage statistics");
  return result.availableBytes;
}
