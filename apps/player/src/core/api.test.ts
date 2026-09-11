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

afterEach(() => vi.unstubAllGlobals());

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
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Device-Token": "device-secret",
          "X-Screen-Id": "screen-1",
        }),
      }),
    );
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
});
