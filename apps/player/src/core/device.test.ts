import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  platform: "web",
  getIdentity: vi.fn(),
  signChallenge: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => native.platform },
  registerPlugin: () => ({
    getIdentity: native.getIdentity,
    signChallenge: native.signChallenge,
  }),
}));

import {
  getDeviceIdentity,
  installationId,
  signDeviceChallenge,
} from "./device";

const identity = {
  publicKeySpki: "public-spki",
  keyId: "hardware-key-fingerprint",
  algorithm: "ES256" as const,
  securityLevel: "strongbox" as const,
};

beforeEach(() => {
  localStorage.clear();
  native.platform = "web";
  native.getIdentity.mockReset().mockResolvedValue(identity);
  native.signChallenge.mockReset().mockResolvedValue({
    signature: "der-signature",
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
      signature: "der-signature",
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
      signature: "der-signature",
      signatureFormat: "ES256-DER",
      keyId: "replacement-key",
    });

    await expect(
      signDeviceChallenge("valid-challenge", identity.keyId),
    ).rejects.toThrow("identity key changed");
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
});
