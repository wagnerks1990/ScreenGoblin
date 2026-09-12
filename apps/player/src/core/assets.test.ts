import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheAssetRepository } from "./assets";
import type { PlayerAsset } from "./types";

const ABC_SHA256 =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

function asset(overrides: Partial<PlayerAsset> = {}): PlayerAsset {
  return {
    id: "asset-1",
    kind: "image",
    url: "https://cdn.example.test/asset.png",
    mimeType: "image/png",
    checksumSha256: ABC_SHA256,
    sizeBytes: 3,
    durationSeconds: 10,
    ...overrides,
  };
}

function response(
  body: BodyInit = new TextEncoder().encode("abc"),
  headers?: HeadersInit,
): Response {
  return new Response(
    body,
    headers ? { status: 200, headers } : { status: 200 },
  );
}

describe("cache asset staging", () => {
  const cache = {
    match: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    keys: vi.fn(),
  };

  beforeEach(() => {
    cache.match.mockReset().mockResolvedValue(undefined);
    cache.put.mockReset().mockResolvedValue(undefined);
    cache.delete.mockReset().mockResolvedValue(true);
    cache.keys.mockReset().mockResolvedValue([]);
    vi.stubGlobal("caches", {
      open: vi.fn().mockResolvedValue(cache),
      delete: vi.fn().mockResolvedValue(true),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("validates the exact size and checksum before caching", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response(undefined, {
        "Content-Length": "3",
        "Content-Type": "image/png",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await new CacheAssetRepository().prefetch(asset());

    expect(fetchMock).toHaveBeenCalledWith(
      "https://cdn.example.test/asset.png",
      expect.objectContaining({
        cache: "no-store",
        redirect: "error",
        signal: expect.anything(),
      }),
    );
    expect(cache.put).toHaveBeenCalledOnce();
    expect(cache.delete).not.toHaveBeenCalled();
  });

  it("rejects an oversized declared Content-Length before reading the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response(undefined, { "Content-Length": "4" })),
    );

    await expect(new CacheAssetRepository().prefetch(asset())).rejects.toThrow(
      "exceeds size limit",
    );
    expect(cache.put).not.toHaveBeenCalled();
    expect(cache.delete).not.toHaveBeenCalled();
  });

  it("rejects malformed Content-Length values", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(response(undefined, { "Content-Length": "3x" })),
    );

    await expect(new CacheAssetRepository().prefetch(asset())).rejects.toThrow(
      "Invalid Content-Length",
    );
  });

  it("rejects a response without a readable body instead of using an unbounded fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    );

    await expect(new CacheAssetRepository().prefetch(asset())).rejects.toThrow(
      "body is unavailable",
    );
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("cancels a streamed response as soon as it exceeds the signed size", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([97, 98]));
        controller.enqueue(new Uint8Array([99, 100]));
      },
      cancel,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body)));

    await expect(new CacheAssetRepository().prefetch(asset())).rejects.toThrow(
      "exceeds size limit",
    );
    expect(cancel).toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
    expect(cache.delete).not.toHaveBeenCalled();
  });

  it("aborts downloads that exceed the request deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, options: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      }),
    );

    const pending = expect(
      new CacheAssetRepository({ requestTimeoutMs: 10 }).prefetch(asset()),
    ).rejects.toThrow("Download timed out");
    await vi.advanceTimersByTimeAsync(11);

    await pending;
    expect(cache.delete).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("limits concurrent downloads", async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        active += 1;
        peak = Math.max(peak, active);
        return new Promise<Response>((resolve) => {
          releases.push(() => {
            active -= 1;
            resolve(response());
          });
        });
      }),
    );
    const repository = new CacheAssetRepository({ maxConcurrentDownloads: 2 });
    const pending = [1, 2, 3, 4].map((id) =>
      repository.prefetch(asset({ id: `asset-${id}` })),
    );

    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.splice(0, 2).forEach((release) => release());
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.splice(0, 2).forEach((release) => release());
    await Promise.all(pending);

    expect(peak).toBe(2);
  });

  it("hands a released slot to the oldest waiter without allowing barging", async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        started.push(url);
        return new Promise<Response>((resolve) =>
          releases.push(() => resolve(response())),
        );
      }),
    );
    const repository = new CacheAssetRepository({ maxConcurrentDownloads: 1 });
    const first = repository.prefetch(
      asset({ id: "first", url: "https://cdn.test/first" }),
    );
    const second = repository.prefetch(
      asset({ id: "second", url: "https://cdn.test/second" }),
    );

    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();
    const third = repository.prefetch(
      asset({ id: "third", url: "https://cdn.test/third" }),
    );
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(started).toEqual([
      "https://cdn.test/first",
      "https://cdn.test/second",
    ]);
    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();
    await Promise.all([first, second, third]);
  });

  it("deduplicates concurrent downloads for the same cache key", async () => {
    let release: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const repository = new CacheAssetRepository();

    const first = repository.prefetch(asset());
    const second = repository.prefetch(asset());
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(fetchMock).toHaveBeenCalledOnce();
    release?.(response());
    await Promise.all([first, second]);
    expect(cache.put).toHaveBeenCalledOnce();
  });

  it("rejects an asset above the hard buffer cap before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new CacheAssetRepository({ maxBufferedAssetBytes: 2 }).prefetch(asset()),
    ).rejects.toThrow("in-memory staging limit");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses cache reuse above the enforceable verification buffer", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new CacheAssetRepository({ maxBufferedAssetBytes: 2 }).prefetch(asset()),
    ).rejects.toThrow("in-memory staging limit");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rehashes a cache hit before reuse", async () => {
    const fetchMock = vi.fn();
    cache.match.mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetchMock);

    await new CacheAssetRepository().prefetch(asset());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(cache.delete).not.toHaveBeenCalled();
  });

  it("deletes and replaces a corrupt cache hit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    cache.match.mockResolvedValueOnce(response("abd"));
    vi.stubGlobal("fetch", fetchMock);

    await new CacheAssetRepository().prefetch(asset());

    expect(cache.delete).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(cache.put).toHaveBeenCalledOnce();
  });

  it("rehashes cached bytes before resolving them for playback", async () => {
    cache.match.mockResolvedValueOnce(response());
    const createObjectURL = vi.fn().mockReturnValue("blob:verified");
    const NativeURL = URL;
    class MockURL extends NativeURL {
      static createObjectURL = createObjectURL;
    }
    vi.stubGlobal("URL", MockURL);

    await expect(new CacheAssetRepository().resolve(asset())).resolves.toBe(
      "blob:verified",
    );
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(cache.delete).not.toHaveBeenCalled();
  });

  it("deletes corrupt cached bytes instead of resolving them", async () => {
    cache.match.mockResolvedValueOnce(response("abd"));

    await expect(new CacheAssetRepository().resolve(asset())).rejects.toThrow(
      "Checksum mismatch",
    );
    expect(cache.delete).toHaveBeenCalledOnce();
  });

  it("rejects a staging batch whose reservations exceed its aggregate budget", async () => {
    let release: ((value: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ),
    );
    const repository = new CacheAssetRepository({ maxAggregateBytes: 5 });
    const first = repository.prefetch(asset({ id: "first" }));

    await expect(repository.prefetch(asset({ id: "second" }))).rejects.toThrow(
      "aggregate size limit",
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release?.(response());
    await first;
  });

  it("does not disturb the cache after an integrity failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response("abd")));

    await expect(new CacheAssetRepository().prefetch(asset())).rejects.toThrow(
      "Checksum mismatch",
    );
    expect(cache.delete).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("does not race-delete a valid entry when the atomic cache write fails", async () => {
    cache.put.mockRejectedValueOnce(new Error("quota failure"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));

    await expect(new CacheAssetRepository().prefetch(asset())).rejects.toThrow(
      "quota failure",
    );
    expect(cache.delete).not.toHaveBeenCalled();
  });

  it("prunes persistent entries not referenced by retained manifests", async () => {
    const retained = asset({ id: "retained" });
    const retainedKey = new Request(
      `${location.origin}/__sg_asset__/retained/${retained.checksumSha256}`,
    );
    const staleKey = new Request(
      `${location.origin}/__sg_asset__/stale/${"f".repeat(64)}`,
    );
    cache.keys.mockResolvedValueOnce([retainedKey, staleKey]);

    await new CacheAssetRepository().prune([retained]);

    expect(cache.delete).toHaveBeenCalledOnce();
    expect(cache.delete).toHaveBeenCalledWith(staleKey);
  });
});
