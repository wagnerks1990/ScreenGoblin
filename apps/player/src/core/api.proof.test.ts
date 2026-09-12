import { canonicalJson } from "@screengoblin/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  identity: {
    algorithm: "ES256" as const,
    publicKeySpki: "p256-spki",
    keyId: "device-key-1",
    securityLevel: "strongbox" as const,
  },
  getDeviceIdentity: vi.fn(),
  signDeviceChallenge: vi.fn(),
}));

vi.mock("./device", () => ({
  hasNativeDeviceIdentity: () => true,
  getDeviceIdentity: native.getDeviceIdentity,
  signDeviceChallenge: native.signDeviceChallenge,
}));

import { PlayerApi } from "./api";
import { sha256Hex, utf8 } from "./crypto";

const verificationKey = "6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw";
const validSignature =
  "9CQuvlprzcxrX1pjj9voSF6PZBPoAWp15OKhnVQyweAgr7oQ7sxdOSu_6UcDAVMe_DO28hi0pjuQVqb1KqsGBA";
const pairedScreenId = "cm1screen00000000000000001";
const pairedCredentialId = "cm1credential0000000000001";
const proofCredentials = {
  authMode: "proof-v1" as const,
  installationId: native.identity.keyId,
  screenId: "screen-1",
  credentialId: "credential-1",
  keyId: native.identity.keyId,
  apiBaseUrl: "https://signage.example.test/api/v1/device",
  heartbeatIntervalSeconds: 60,
  manifestVerificationKey: verificationKey,
};

const challengeIds: Record<string, string> = {
  pair: "CgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo",
  "manifest-1": "CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws",
  "manifest-2": "DAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw",
  heartbeat: "DQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0",
  "bad-key": "Dg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4ODg4",
};
const challengeValues: Record<string, string> = {
  pair: "AQEBAQEBAQEBAQEBAQEBAQ",
  "manifest-1": "AgICAgICAgICAgICAgICAg",
  "manifest-2": "AwMDAwMDAwMDAwMDAwMDAw",
  heartbeat: "BAQEBAQEBAQEBAQEBAQEBA",
  "bad-key": "BQUFBQUFBQUFBQUFBQUFBQ",
};
const challenge = (suffix: string) => ({
  id: challengeIds[suffix]!,
  challenge: challengeValues[suffix]!,
  expiresAt: "2099-09-12T00:01:00.000Z",
});

const manifest = () => ({
  version: "manifest-1",
  generatedAt: "2026-09-11T00:00:00.000Z",
  validUntil: "2026-09-11T00:05:00.000Z",
  screenId: proofCredentials.screenId,
  priority: "normal" as const,
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
  signatureAlgorithm: "Ed25519" as const,
  signature: validSignature,
});

beforeEach(() => {
  native.getDeviceIdentity.mockResolvedValue(native.identity);
  native.signDeviceChallenge.mockImplementation(
    async (_challenge: string, expectedKeyId: string) => ({
      keyId: expectedKeyId,
      signatureFormat: "ES256-DER" as const,
      signature: "der_signature",
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("PlayerApi proof-v1", () => {
  it("enrolls with a two-stage challenge and retries the identical final proof", async () => {
    const issued = challenge("pair");
    const response = {
      authMode: "proof-v1",
      screenId: pairedScreenId,
      credentialId: pairedCredentialId,
      keyId: native.identity.keyId,
      apiBaseUrl: proofCredentials.apiBaseUrl,
      heartbeatIntervalSeconds: 60,
      manifestVerificationKey: verificationKey,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(issued))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json(response));
    const sleep = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);

    const result = await new PlayerApi(
      "https://signage.example.test",
      undefined,
      { sleep },
    ).pair("123456", native.identity.keyId);

    expect(result).toEqual({
      ...response,
      installationId: native.identity.keyId,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://signage.example.test/api/v1/device/pair/challenge",
    );
    const challengeBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    );
    expect(challengeBody).toEqual({
      code: "123456",
      device: {
        installationId: native.identity.keyId,
        model: "Android TV",
        osVersion: navigator.userAgent,
        playerVersion: "0.1.0",
      },
      identity: native.identity,
    });
    const firstFinalBody = String(
      (fetchMock.mock.calls[1]?.[1] as RequestInit).body,
    );
    expect(firstFinalBody).toBe(
      String((fetchMock.mock.calls[2]?.[1] as RequestInit).body),
    );
    expect(JSON.parse(firstFinalBody).pairingProof).toEqual({
      challengeId: issued.id,
      challenge: issued.challenge,
      keyId: native.identity.keyId,
      signature: "der_signature",
      signatureFormat: "ES256-DER",
    });
    expect(native.signDeviceChallenge).toHaveBeenCalledOnce();
    for (const call of fetchMock.mock.calls)
      expect((call[1] as RequestInit).redirect).toBe("error");
  });

  it("rejects an installation ID that differs from the native key before network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new PlayerApi("https://signage.example.test").pair(
        "123456",
        "different-installation",
      ),
    ).rejects.toThrow("does not match its device identity");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed, non-canonical, and expired challenge envelopes", async () => {
    for (const invalid of [
      { ...challenge("manifest-1"), id: "not-a-uuid" },
      { ...challenge("manifest-1"), challenge: "AB" },
      { ...challenge("manifest-1"), expiresAt: "2020-01-01T00:00:00.000Z" },
      { ...challenge("manifest-1"), expiresAt: "not-a-date" },
    ]) {
      const fetchMock = vi.fn().mockResolvedValue(Response.json(invalid));
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        new PlayerApi(proofCredentials.apiBaseUrl, proofCredentials).manifest(),
      ).rejects.toMatchObject({ kind: "protocol", retryable: false });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(native.signDeviceChallenge).not.toHaveBeenCalled();
      native.signDeviceChallenge.mockClear();
    }
  });

  it.each([
    [
      "unsafe API URL",
      { apiBaseUrl: "http://signage.example.test/api/v1/device" },
    ],
    ["punctuated screen ID", { screenId: "screen.1" }],
    ["empty credential ID", { credentialId: "" }],
    ["overlong credential ID", { credentialId: "c".repeat(65) }],
    ["invalid interval", { heartbeatIntervalSeconds: 0 }],
    ["invalid verification key", { manifestVerificationKey: "not-a-key" }],
    ["bearer downgrade", { deviceToken: "secret" }],
  ])("rejects a proof pairing response with %s", async (_name, override) => {
    const issued = challenge("pair");
    const response = {
      authMode: "proof-v1",
      screenId: pairedScreenId,
      credentialId: pairedCredentialId,
      keyId: native.identity.keyId,
      apiBaseUrl: proofCredentials.apiBaseUrl,
      heartbeatIntervalSeconds: 60,
      manifestVerificationKey: verificationKey,
      ...override,
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(issued))
        .mockResolvedValueOnce(Response.json(response)),
    );

    await expect(
      new PlayerApi("https://signage.example.test").pair(
        "123456",
        native.identity.keyId,
      ),
    ).rejects.toThrow("Invalid proof pairing response");
  });

  it("gets and signs a fresh manifest challenge for every retry", async () => {
    const first = challenge("manifest-1");
    const second = challenge("manifest-2");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(first))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json(second))
      .mockResolvedValueOnce(Response.json(manifest()));
    vi.stubGlobal("fetch", fetchMock);

    await new PlayerApi(proofCredentials.apiBaseUrl, proofCredentials, {
      sleep: vi.fn().mockResolvedValue(undefined),
    }).manifest();

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `${proofCredentials.apiBaseUrl}/challenges`,
      `${proofCredentials.apiBaseUrl}/manifest`,
      `${proofCredentials.apiBaseUrl}/challenges`,
      `${proofCredentials.apiBaseUrl}/manifest`,
    ]);
    for (const index of [0, 2]) {
      expect(
        JSON.parse(
          String((fetchMock.mock.calls[index]?.[1] as RequestInit).body),
        ),
      ).toEqual({
        operation: "manifest",
        bodySha256: await sha256Hex(new ArrayBuffer(0)),
      });
    }
    const secondProofHeaders = new Headers(
      (fetchMock.mock.calls[3]?.[1] as RequestInit).headers,
    );
    expect(secondProofHeaders.get("X-Device-Challenge-Id")).toBe(second.id);
    expect(secondProofHeaders.get("X-Device-Challenge")).toBe(second.challenge);
    expect(secondProofHeaders.get("X-Device-Token")).toBeNull();
    expect(native.signDeviceChallenge).toHaveBeenNthCalledWith(
      2,
      second.challenge,
      native.identity.keyId,
    );
  });

  it("binds heartbeat proof to the exact canonical body and never replays it", async () => {
    const issued = challenge("heartbeat");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(issued))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const heartbeat = {
      installationId: "installation-123",
      playerVersion: "0.1.0",
      uptimeSeconds: 60,
      freeStorageBytes: 1024,
      networkType: "ethernet",
      occurredAt: "2026-09-11T00:00:00.000Z",
      state: "playing" as const,
    };

    await expect(
      new PlayerApi(proofCredentials.apiBaseUrl, proofCredentials).heartbeat(
        heartbeat,
      ),
    ).rejects.toMatchObject({ status: 503 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const sentBody = String((fetchMock.mock.calls[1]?.[1] as RequestInit).body);
    expect(sentBody).toBe(
      canonicalJson({
        installationId: heartbeat.installationId,
        playerVersion: heartbeat.playerVersion,
        uptimeSeconds: heartbeat.uptimeSeconds,
        freeStorageBytes: heartbeat.freeStorageBytes,
        networkType: heartbeat.networkType,
        occurredAt: heartbeat.occurredAt,
      }),
    );
    const challengeRequest = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    );
    expect(challengeRequest).toEqual({
      operation: "heartbeat",
      bodySha256: await sha256Hex(utf8(sentBody)),
    });
  });

  it("fails closed before the protected request when the signing key changes", async () => {
    native.signDeviceChallenge.mockRejectedValueOnce(
      new Error("Android device identity key changed while signing"),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(challenge("bad-key")));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new PlayerApi(proofCredentials.apiBaseUrl, proofCredentials).manifest(),
    ).rejects.toThrow("identity key changed");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
