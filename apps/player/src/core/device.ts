import { Capacitor, registerPlugin } from "@capacitor/core";

export interface DeviceIdentity {
  publicKeySpki: string;
  keyId: string;
  algorithm: "ES256";
  securityLevel:
    | "strongbox"
    | "trusted-environment"
    | "software"
    | "unknown-secure"
    | "unknown";
}

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
  return nativeDeviceIdentity.getIdentity();
}

export async function signDeviceChallenge(
  challenge: string,
): Promise<DeviceChallengeSignature> {
  if (!hasNativeDeviceIdentity()) {
    throw new Error(
      "Hardware-backed device identity is only available on Android",
    );
  }
  return nativeDeviceIdentity.signChallenge({ challenge });
}

export async function installationId(): Promise<string> {
  // Existing deployments retain their installation identifier so the current
  // bearer-token enrollment is not silently broken during an application update.
  const legacyId = localStorage.getItem(INSTALLATION_ID_KEY);
  if (legacyId) return legacyId;

  if (hasNativeDeviceIdentity()) {
    const identity = await nativeDeviceIdentity.getIdentity();
    return identity.keyId;
  }

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
