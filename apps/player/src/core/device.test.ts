import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  platform: "web",
  getIdentity: vi.fn(),
  rotateIdentity: vi.fn(),
  finalizeIdentityRotation: vi.fn(),
  signChallenge: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => native.platform },
  registerPlugin: () => ({
    getIdentity: native.getIdentity,
    rotateIdentity: native.rotateIdentity,
    finalizeIdentityRotation: native.finalizeIdentityRotation,
    signChallenge: native.signChallenge,
  }),
}));

import {
  finalizeDeviceIdentityRotation,
  getDeviceIdentity,
  installationId,
  rotateDeviceIdentity,
  signDeviceChallenge,
} from "./device";

const identity = {
  publicKeySpki:
    "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ",
  keyId: "YU6CUGOQpCCNTKa2afJPBLaB1nxkbnAQwG8M-nZKs-A",
  algorithm: "ES256" as const,
  securityLevel: "strongbox" as const,
};

beforeEach(() => {
  localStorage.clear();
  native.platform = "web";
  native.getIdentity.mockReset().mockResolvedValue(identity);
  native.rotateIdentity.mockReset().mockResolvedValue(identity);
  native.finalizeIdentityRotation.mockReset().mockResolvedValue(undefined);
  native.signChallenge.mockReset().mockResolvedValue({
    signature:
      "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg",
    signatureFormat: "ES256-DER",
    keyId: identity.keyId,
  });
});

afterEach(() => vi.restoreAllMocks());

describe("device identity", () => {
  it("replaces a legacy Android installation ID with the current key fingerprint", async () => {
    native.platform = "android";
    localStorage.setItem("sg-installation-id", "legacy-installation-id");

    await expect(installationId()).resolves.toBe(identity.keyId);
    expect(native.getIdentity).toHaveBeenCalledOnce();
  });

  it("uses the hardware key fingerprint for a new Android installation", async () => {
    native.platform = "android";

    await expect(installationId()).resolves.toBe(identity.keyId);
    expect(native.getIdentity).toHaveBeenCalledOnce();
    expect(localStorage.getItem("sg-installation-id")).toBeNull();
  });

  it("creates and persists a random browser installation ID", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "11111111-2222-4333-8444-555555555555",
    );

    await expect(installationId()).resolves.toBe(
      "11111111-2222-4333-8444-555555555555",
    );
    await expect(installationId()).resolves.toBe(
      "11111111-2222-4333-8444-555555555555",
    );
    expect(crypto.randomUUID).toHaveBeenCalledOnce();
  });

  it("preserves a legacy installation ID only in the browser", async () => {
    localStorage.setItem("sg-installation-id", "legacy-installation-id");
    await expect(installationId()).resolves.toBe("legacy-installation-id");
    expect(native.getIdentity).not.toHaveBeenCalled();
  });

  it("returns native identity metadata only on Android", async () => {
    await expect(getDeviceIdentity()).resolves.toBeUndefined();
    native.platform = "android";
    await expect(getDeviceIdentity()).resolves.toEqual(identity);
  });

  it("delegates proof signing only to the Android Keystore plugin", async () => {
    await expect(signDeviceChallenge("valid-challenge")).rejects.toThrow(
      "only available on Android",
    );
    native.platform = "android";
    await expect(signDeviceChallenge("valid-challenge")).resolves.toEqual({
      signature:
        "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg",
      signatureFormat: "ES256-DER",
      keyId: identity.keyId,
    });
    expect(native.signChallenge).toHaveBeenCalledWith({
      challenge: "valid-challenge",
    });
  });

  it("fails closed when Android signs with a different key", async () => {
    native.platform = "android";
    native.signChallenge.mockResolvedValueOnce({
      signature:
        "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg",
      signatureFormat: "ES256-DER",
      keyId: "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ",
    });

    await expect(
      signDeviceChallenge("valid-challenge", identity.keyId),
    ).rejects.toThrow("identity key changed");
  });

  it("rotates only after an explicit native request and finalizes the expected key", async () => {
    await expect(rotateDeviceIdentity()).rejects.toThrow(
      "only available on Android",
    );
    await finalizeDeviceIdentityRotation(identity.keyId);
    expect(native.finalizeIdentityRotation).not.toHaveBeenCalled();

    native.platform = "android";
    await expect(rotateDeviceIdentity()).resolves.toEqual(identity);
    expect(native.rotateIdentity).toHaveBeenCalledOnce();
    await finalizeDeviceIdentityRotation(identity.keyId);
    expect(native.finalizeIdentityRotation).toHaveBeenCalledWith({
      keyId: identity.keyId,
    });
  });

  it("fails closed when Android returns incomplete identity metadata", async () => {
    native.platform = "android";
    native.getIdentity.mockResolvedValueOnce({
      ...identity,
      publicKeySpki: "",
    });
    await expect(getDeviceIdentity()).rejects.toThrow(
      "invalid device identity",
    );
  });

  it("recalculates and verifies the key fingerprint from the exact SPKI", async () => {
    native.platform = "android";
    native.getIdentity.mockResolvedValueOnce({
      ...identity,
      keyId: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM",
    });
    await expect(getDeviceIdentity()).rejects.toThrow(
      "fingerprint does not match",
    );
  });
});
