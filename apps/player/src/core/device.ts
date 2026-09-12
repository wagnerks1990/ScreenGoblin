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
  signChallenge(options: {
    challenge: string;
  }): Promise<DeviceChallengeSignature>;
}

const nativeDeviceIdentity =
  registerPlugin<DeviceIdentityPlugin>("DeviceIdentity");
const INSTALLATION_ID_KEY = "sg-installation-id";

export function hasNativeDeviceIdentity(): boolean {
  return Capacitor.getPlatform() === "android";
}

export async function getDeviceIdentity(): Promise<DeviceIdentity | undefined> {
  if (!hasNativeDeviceIdentity()) return undefined;
  const identity = await nativeDeviceIdentity.getIdentity();
  if (
    identity.algorithm !== "ES256" ||
    !identity.publicKeySpki ||
    !identity.keyId
  )
    throw new Error("Android returned an invalid device identity");
  return identity;
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
    !proof.signature ||
    !proof.keyId ||
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
