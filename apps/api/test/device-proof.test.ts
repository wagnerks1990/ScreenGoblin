import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalHeartbeatDigest,
  canonicalPairingDigest,
  EMPTY_BODY_SHA256,
} from "../src/device-proof/canonical.js";
import {
  decodeCanonicalBase64Url,
  DeviceProofFormatError,
  sha256Base64Url,
  validateP256Identity,
  verifyDeviceSignature,
} from "../src/device-proof/crypto.js";

const signingDomain = Buffer.from("ScreenGoblin device proof v1\0", "utf8");

function identity(curve = "prime256v1") {
  const keys = generateKeyPairSync("ec", { namedCurve: curve });
  const spki = keys.publicKey.export({ format: "der", type: "spki" });
  return {
    privateKey: keys.privateKey,
    enrollment: {
      algorithm: "ES256" as const,
      publicKeySpki: spki.toString("base64url"),
      keyId: sha256Base64Url(spki),
      securityLevel: "trusted-environment" as const,
    },
  };
}

const signChallenge = (privateKey: KeyObject, challenge: string) =>
  sign(
    "sha256",
    Buffer.concat([signingDomain, Buffer.from(challenge, "base64url")]),
    privateKey,
  ).toString("base64url");

describe("device proof cryptography", () => {
  it("strictly validates P-256 SPKI and its derived key identifier", () => {
    const valid = identity();
    expect(validateP256Identity(valid.enrollment).enrollment).toEqual(
      valid.enrollment,
    );
    expect(() =>
      validateP256Identity({ ...valid.enrollment, keyId: "x".repeat(43) }),
    ).toThrow(DeviceProofFormatError);
    expect(() =>
      validateP256Identity(identity("secp384r1").enrollment),
    ).toThrow(/P-256/);
  });

  it("verifies only strict DER signatures over the Android signing domain", () => {
    const value = identity();
    const challenge = Buffer.alloc(32, 7).toString("base64url");
    const signature = signChallenge(value.privateKey, challenge);
    expect(verifyDeviceSignature(value.enrollment, challenge, signature)).toBe(
      true,
    );
    expect(
      verifyDeviceSignature(
        value.enrollment,
        Buffer.alloc(32, 8).toString("base64url"),
        signature,
      ),
    ).toBe(false);
    expect(
      verifyDeviceSignature(value.enrollment, challenge, `${signature}AA`),
    ).toBe(false);
  });

  it("rejects padded, noncanonical, and out-of-bounds base64url", () => {
    expect(() => decodeCanonicalBase64Url("AA==", 1, 10)).toThrow();
    expect(() => decodeCanonicalBase64Url("+w", 1, 10)).toThrow();
    expect(() => decodeCanonicalBase64Url("AA", 2, 10)).toThrow();
  });
});

describe("device request canonicalization", () => {
  it("binds every pairing transcript field", () => {
    const value = identity().enrollment;
    const request = {
      code: "123456",
      device: {
        installationId: value.keyId,
        model: "Android TV",
        osVersion: "14",
        playerVersion: "0.1.0",
      },
      identity: value,
    };
    const pepper = "pairing-test-pepper";
    const digest = canonicalPairingDigest(request, pepper);
    expect(canonicalPairingDigest({ ...request }, pepper)).toBe(digest);
    expect(
      canonicalPairingDigest(
        {
          ...request,
          device: { ...request.device, playerVersion: "0.1.1" },
        },
        pepper,
      ),
    ).not.toBe(digest);
    expect(canonicalPairingDigest(request, `${pepper}-other`)).not.toBe(digest);
  });

  it("binds heartbeat fields and defines the empty manifest body digest", () => {
    const heartbeat = {
      installationId: "installation-a",
      playerVersion: "0.1.0",
      uptimeSeconds: 1,
      freeStorageBytes: 2,
      networkType: "ethernet",
      occurredAt: "2026-09-12T12:00:00.000Z",
    };
    expect(canonicalHeartbeatDigest({ ...heartbeat })).toBe(
      canonicalHeartbeatDigest(heartbeat),
    );
    expect(
      canonicalHeartbeatDigest({ ...heartbeat, uptimeSeconds: 2 }),
    ).not.toBe(canonicalHeartbeatDigest(heartbeat));
    expect(EMPTY_BODY_SHA256).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
