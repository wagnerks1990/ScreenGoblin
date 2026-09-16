import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPrivateKey, sign } from "node:crypto";
import { PlayerApi } from "./api";

const apiBaseUrl = "http://localhost:3000/api/v1/device";
const verificationKey = "6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw";
const signingSeed = Buffer.alloc(32, 7);
const signingKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    signingSeed,
  ]),
  format: "der",
  type: "pkcs8",
});

const credentials = {
  authMode: "development-bearer" as const,
  installationId: "installation-123",
  screenId: "screen-1",
  deviceToken: "device-secret",
  apiBaseUrl,
  heartbeatIntervalSeconds: 60,
  manifestVerificationKey: verificationKey,
};

const signedManifest = () => {
  const unsigned = {
    protocolVersion: 2,
    mediaDelivery: "authorization-v1",
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
          url: `${apiBaseUrl}/media/asset-1`,
          mediaDelivery: "authorization-v1",
          mediaCapability: `${"a".repeat(48)}.${"b".repeat(43)}`,
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
    signature: sign(
      null,
      Buffer.from(JSON.stringify(unsigned)),
      signingKey,
    ).toString("base64url"),
  };
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

beforeEach(() => vi.stubEnv("VITE_DEVICE_AUTH_DEVELOPMENT_BEARER", "true"));

describe("PlayerApi wire contract", () => {
  it("uses device headers and normalizes the API playlist item shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(signedManifest()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new PlayerApi(apiBaseUrl, credentials).manifest();

    expect(fetchMock).toHaveBeenCalledWith(
      `${apiBaseUrl}/manifest`,
      expect.objectContaining({ method: "POST", cache: "no-store" }),
    );
    const headers = new Headers(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).headers,
    );
    expect(headers.get("X-Device-Token")).toBe("device-secret");
    expect(headers.get("X-Screen-Id")).toBe("screen-1");
    expect(result.manifest.items).toEqual([
      expect.objectContaining({
        id: "asset-1",
        kind: "image",
        durationSeconds: 15,
      }),
    ]);
    const unsigned: Record<string, unknown> = { ...signedManifest() };
    delete unsigned.signatureAlgorithm;
    delete unsigned.signature;
    expect(result.payloadJson).toBe(JSON.stringify(unsigned));
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
      new PlayerApi(apiBaseUrl, credentials).manifest(),
    ).rejects.toThrow("Manifest signature or screen binding is invalid");
  });

  it("sends the strict heartbeat payload without local-only state", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        accepted: true,
        serverTime: "2026-09-11T00:00:01.000Z",
        nextHeartbeatSeconds: 60,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await new PlayerApi(apiBaseUrl, credentials).heartbeat({
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

  it.each([
    { accepted: true, serverTime: "invalid", nextHeartbeatSeconds: 60 },
    {
      accepted: true,
      serverTime: "2026-09-11T00:00:01.000Z",
      nextHeartbeatSeconds: 4,
    },
    {
      accepted: true,
      serverTime: "2026-09-11T00:00:01.000Z",
      nextHeartbeatSeconds: 86_401,
    },
    {
      accepted: true,
      serverTime: "2026-09-11T00:00:01.000Z",
      nextHeartbeatSeconds: 60.5,
    },
    {
      accepted: true,
      serverTime: "2026-09-11T00:00:01.000Z",
      nextHeartbeatSeconds: 60,
      commands: [],
    },
  ])("rejects an invalid heartbeat response %#", async (payload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload)));

    await expect(
      new PlayerApi(apiBaseUrl, credentials).heartbeat({
        installationId: "installation-123",
        playerVersion: "0.1.0",
        uptimeSeconds: 60,
        freeStorageBytes: 1024,
        networkType: "ethernet",
        occurredAt: "2026-09-11T00:00:00.000Z",
        state: "playing",
      }),
    ).rejects.toMatchObject({ kind: "protocol", retryable: false });
  });

  it("propagates an HTTP-date Retry-After without a one-day cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-16T00:00:00.000Z");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 503,
          headers: { "Retry-After": "Fri, 18 Sep 2026 00:00:00 GMT" },
        }),
      ),
    );

    await expect(
      new PlayerApi(apiBaseUrl, credentials).heartbeat({
        installationId: "installation-123",
        playerVersion: "0.1.0",
        uptimeSeconds: 60,
        freeStorageBytes: 1024,
        networkType: "ethernet",
        occurredAt: "2026-09-11T00:00:00.000Z",
        state: "playing",
      }),
    ).rejects.toMatchObject({
      kind: "http",
      retryable: true,
      status: 503,
      retryAfterMs: 172_800_000,
    });
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
    vi.stubEnv("VITE_DEVICE_AUTH_DEVELOPMENT_BEARER", "true");
    const pending = new PlayerApi("http://localhost:3000", undefined, {
      requestTimeoutMs: 250,
    }).pair("123456", "installation-123");

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
        apiBaseUrl,
        { ...credentials, deviceToken: "expired-secret" },
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

    await new PlayerApi(apiBaseUrl, credentials, {
      sleep,
      retryMaxDelayMs: 5_000,
    }).manifest();

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

    await new PlayerApi(apiBaseUrl, credentials, {
      sleep,
      random: () => 0,
      retryBaseDelayMs: 200,
    }).manifest();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("supports caller cancellation for future single-flight synchronization", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new PlayerApi(apiBaseUrl, credentials).manifest({
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: "aborted", retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never enables browser bearer authentication for a non-local server", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(
      () =>
        new PlayerApi("https://signage.example.test/api/v1/device", {
          ...credentials,
          apiBaseUrl: "https://signage.example.test/api/v1/device",
        }),
    ).toThrow("explicit localhost build");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires the explicit build flag even on localhost", async () => {
    vi.stubEnv("VITE_DEVICE_AUTH_DEVELOPMENT_BEARER", "false");
    expect(() => new PlayerApi(apiBaseUrl, credentials)).toThrow(
      "explicit localhost build",
    );
  });
});
