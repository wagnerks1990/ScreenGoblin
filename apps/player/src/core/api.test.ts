import { afterEach, describe, expect, it, vi } from "vitest";
import { PlayerApi } from "./api";

const verificationKey = "6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw";
const validSignature =
  "9CQuvlprzcxrX1pjj9voSF6PZBPoAWp15OKhnVQyweAgr7oQ7sxdOSu_6UcDAVMe_DO28hi0pjuQVqb1KqsGBA";

const signedManifest = () => {
  const unsigned = {
    version: "manifest-1",
    generatedAt: "2026-09-11T00:00:00.000Z",
    validUntil: "2026-09-11T00:05:00.000Z",
    screenId: "screen-1",
    priority: "normal",
    items: [
      {
        id: "playlist-item-1",
        position: 0,
        durationSeconds: 15,
        asset: {
          id: "asset-1",
          kind: "image",
          url: "https://media.example.test/welcome.png",
          mimeType: "image/png",
          checksumSha256: "a".repeat(64),
          sizeBytes: 42,
        },
      },
    ],
  };
  return {
    ...unsigned,
    signatureAlgorithm: "Ed25519" as const,
    signature: validSignature,
  };
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PlayerApi wire contract", () => {
  it("uses device headers and normalizes the API playlist item shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(signedManifest()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new PlayerApi(
      "https://signage.example.test/api/v1/device",
      "device-secret",
      "screen-1",
      verificationKey,
    ).manifest();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://signage.example.test/api/v1/device/manifest",
      expect.objectContaining({ cache: "no-store" }),
    );
    const headers = new Headers(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).headers,
    );
    expect(headers.get("X-Device-Token")).toBe("device-secret");
    expect(headers.get("X-Screen-Id")).toBe("screen-1");
    expect(result.items).toEqual([
      expect.objectContaining({
        id: "asset-1",
        kind: "image",
        durationSeconds: 15,
      }),
    ]);
  });

  it("rejects a tampered or wrong-screen manifest", async () => {
    const tampered = { ...signedManifest(), screenId: "screen-2" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(tampered), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    await expect(
      new PlayerApi(
        "https://signage.example.test/api/v1/device",
        "device-secret",
        "screen-1",
        verificationKey,
      ).manifest(),
    ).rejects.toThrow("Manifest signature or screen binding is invalid");
  });

  it("sends the strict heartbeat payload without local-only state", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await new PlayerApi(
      "https://signage.example.test/api/v1/device",
      "device-secret",
      "screen-1",
    ).heartbeat({
      installationId: "installation-123",
      playerVersion: "0.1.0",
      uptimeSeconds: 60,
      freeStorageBytes: 1024,
      networkType: "ethernet",
      occurredAt: "2026-09-11T00:00:00.000Z",
      state: "playing",
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).not.toHaveProperty("state");
  });

  it("aborts a hung pairing request at its deadline without replaying the POST", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const pending = new PlayerApi(
      "https://signage.example.test",
      undefined,
      undefined,
      undefined,
      { requestTimeoutMs: 250 },
    ).pair("123456", "installation-123");

    const rejected = expect(pending).rejects.toMatchObject({
      name: "PlayerApiFailure",
      kind: "timeout",
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(250);
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(
      true,
    );
  });

  it("returns a typed 401 failure without retrying", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 401 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new PlayerApi(
        "https://signage.example.test/api/v1/device",
        "expired-secret",
        "screen-1",
        verificationKey,
        { sleep },
      ).manifest(),
    ).rejects.toEqual(
      expect.objectContaining({
        kind: "http",
        retryable: false,
        status: 401,
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("honors and caps Retry-After for safe 429 and 503 manifest retries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 429,
          headers: { "Retry-After": "2" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 503,
          headers: { "Retry-After": "30" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(signedManifest()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const sleep = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);

    await new PlayerApi(
      "https://signage.example.test/api/v1/device",
      "device-secret",
      "screen-1",
      verificationKey,
      { sleep, retryMaxDelayMs: 5_000 },
    ).manifest();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[2_000], [5_000]]);
  });

  it("recovers from a transient network failure with capped jittered backoff", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(signedManifest()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const sleep = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);

    await new PlayerApi(
      "https://signage.example.test/api/v1/device",
      "device-secret",
      "screen-1",
      verificationKey,
      { sleep, random: () => 0, retryBaseDelayMs: 200 },
    ).manifest();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("supports caller cancellation for future single-flight synchronization", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new PlayerApi(
        "https://signage.example.test/api/v1/device",
        "device-secret",
        "screen-1",
        verificationKey,
      ).manifest({ signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "aborted", retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
