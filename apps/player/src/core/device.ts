import { Capacitor, registerPlugin } from "@capacitor/core";
import type {
  DeviceIdentityEnrollment,
  DeviceProof,
} from "@screengoblin/contracts";

export type DeviceIdentity = DeviceIdentityEnrollment;

export interface DeviceChallengeSignature {
  signature: string;
  signatureFormat: "ES256-DER";
  keyId: string;
}

interface DeviceIdentityPlugin {
  getIdentity(): Promise<DeviceIdentity>;
  rotateIdentity(): Promise<DeviceIdentity>;
  finalizeIdentityRotation(options: { keyId: string }): Promise<void>;
  signChallenge(options: {
    challenge: string;
  }): Promise<DeviceChallengeSignature>;
}

const nativeDeviceIdentity =
  registerPlugin<DeviceIdentityPlugin>("DeviceIdentity");
const INSTALLATION_ID_KEY = "sg-installation-id";
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function canonicalBase64UrlBytes(
  value: unknown,
  minimumBytes: number,
  maximumBytes: number,
): Uint8Array | undefined {
  if (
    typeof value !== "string" ||
    !BASE64URL.test(value) ||
    value.length % 4 === 1
  )
    return undefined;
  try {
    const padded = `${value.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat(
      (4 - (value.length % 4)) % 4,
    )}`;
    const decoded = atob(padded);
    const canonical =
      decoded.length >= minimumBytes &&
      decoded.length <= maximumBytes &&
      btoa(decoded)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "") === value;
    return canonical
      ? Uint8Array.from(decoded, (character) => character.charCodeAt(0))
      : undefined;
  } catch {
    return undefined;
  }
}

async function validateIdentity(
  identity: DeviceIdentity,
): Promise<DeviceIdentity> {
  const publicKey = canonicalBase64UrlBytes(identity.publicKeySpki, 80, 128);
  if (
    identity.algorithm !== "ES256" ||
    !publicKey ||
    !canonicalBase64UrlBytes(identity.keyId, 32, 32) ||
    ![
      "strongbox",
      "trusted-environment",
      "software",
      "unknown-secure",
      "unknown",
    ].includes(identity.securityLevel)
  )
    throw new Error("Android returned an invalid device identity");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", publicKey.buffer as ArrayBuffer),
  );
  const derivedKeyId = btoa(String.fromCharCode(...digest))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  if (derivedKeyId !== identity.keyId)
    throw new Error(
      "Android device identity fingerprint does not match its public key",
    );
  return identity;
}

export function hasNativeDeviceIdentity(): boolean {
  return Capacitor.getPlatform() === "android";
}

export async function getDeviceIdentity(): Promise<DeviceIdentity | undefined> {
  if (!hasNativeDeviceIdentity()) return undefined;
  return await validateIdentity(await nativeDeviceIdentity.getIdentity());
}

/** Explicitly replaces the active Android Keystore identity. Never call on retry. */
export async function rotateDeviceIdentity(): Promise<DeviceIdentity> {
  if (!hasNativeDeviceIdentity())
    throw new Error("Device identity replacement is only available on Android");
  return await validateIdentity(await nativeDeviceIdentity.rotateIdentity());
}

/** Removes superseded managed keys only after the server activates this key. */
export async function finalizeDeviceIdentityRotation(
  expectedKeyId: string,
): Promise<void> {
  if (!hasNativeDeviceIdentity()) return;
  if (!canonicalBase64UrlBytes(expectedKeyId, 32, 32))
    throw new Error("Cannot finalize an invalid device identity");
  await nativeDeviceIdentity.finalizeIdentityRotation({ keyId: expectedKeyId });
}

export async function signDeviceChallenge(
  challenge: string,
  expectedKeyId?: string,
): Promise<Omit<DeviceProof, "challengeId" | "challenge">> {
  if (!hasNativeDeviceIdentity()) {
    throw new Error(
      "Hardware-backed device identity is only available on Android",
    );
  }
  const proof = await nativeDeviceIdentity.signChallenge({ challenge });
  if (
    proof.signatureFormat !== "ES256-DER" ||
    !canonicalBase64UrlBytes(proof.signature, 64, 80) ||
    !canonicalBase64UrlBytes(proof.keyId, 32, 32) ||
    (expectedKeyId !== undefined && proof.keyId !== expectedKeyId)
  )
    throw new Error("Android device identity key changed while signing");
  return proof;
}

export async function installationId(): Promise<string> {
  if (hasNativeDeviceIdentity()) {
    const identity = await getDeviceIdentity();
    if (!identity) throw new Error("Android device identity is unavailable");
    return identity.keyId;
  }

  // Browser-only development bearer deployments preserve their prior ID.
  const legacyId = localStorage.getItem(INSTALLATION_ID_KEY);
  if (legacyId) return legacyId;

  const browserId = crypto.randomUUID();
  localStorage.setItem(INSTALLATION_ID_KEY, browserId);
  return browserId;
}

export async function freeStorageBytes(): Promise<number> {
  const estimate = await navigator.storage?.estimate?.();
  return Math.max(0, (estimate?.quota ?? 0) - (estimate?.usage ?? 0));
}

export function networkType(): string {
  const connection = (
    navigator as Navigator & { connection?: { effectiveType?: string } }
  ).connection;
  return connection?.effectiveType ?? (navigator.onLine ? "online" : "offline");
}

export function enterFullscreen(): void {
  document.documentElement.requestFullscreen?.().catch(() => undefined);
}
