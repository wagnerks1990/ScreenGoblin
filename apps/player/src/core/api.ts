import type { Credentials, Heartbeat, PlayerManifest } from "./types";
import { verifyManifestSignature } from "./crypto";

const trim = (url: string) => url.replace(/\/+$/, "");

export class PlayerApi {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly token?: string,
    private readonly screenId?: string,
    private readonly manifestVerificationKey?: string,
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${trim(this.apiBaseUrl)}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(this.token ? { "X-Device-Token": this.token } : {}),
        ...(this.screenId ? { "X-Screen-Id": this.screenId } : {}),
        ...init?.headers,
      },
    });
    if (!response.ok)
      throw new Error(`Player API returned HTTP ${response.status}`);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  async pair(code: string, installationId: string): Promise<Credentials> {
    const result = await this.request<Omit<Credentials, "installationId">>(
      "/api/v1/device/pair",
      {
        method: "POST",
        body: JSON.stringify({
          code,
          device: {
            installationId,
            model: "Android TV",
            osVersion: navigator.userAgent,
            playerVersion: __APP_VERSION__,
          },
        }),
      },
    );
    return { ...result, installationId };
  }

  async manifest(): Promise<PlayerManifest> {
    const response = await this.request<{
      version: string;
      generatedAt: string;
      validUntil: string;
      screenId: string;
      priority: PlayerManifest["priority"];
      items: Array<{
        asset: Omit<PlayerManifest["items"][number], "durationSeconds">;
        durationSeconds: number;
      }>;
      signatureAlgorithm: "Ed25519";
      signature: string;
    }>("/manifest", { cache: "no-store" });
    const { signature, signatureAlgorithm, ...unsigned } = response;
    if (
      !this.screenId ||
      response.screenId !== this.screenId ||
      signatureAlgorithm !== "Ed25519" ||
      !this.manifestVerificationKey ||
      !(await verifyManifestSignature(
        unsigned,
        signature,
        this.manifestVerificationKey,
      ))
    )
      throw new Error("Manifest signature or screen binding is invalid");
    return {
      ...unsigned,
      items: response.items.map(({ asset, durationSeconds }) => ({
        ...asset,
        durationSeconds,
      })),
    };
  }

  heartbeat(value: Heartbeat): Promise<void> {
    const wireValue = {
      installationId: value.installationId,
      playerVersion: value.playerVersion,
      uptimeSeconds: value.uptimeSeconds,
      freeStorageBytes: value.freeStorageBytes,
      networkType: value.networkType,
      occurredAt: value.occurredAt,
      ...(value.manifestVersion
        ? { manifestVersion: value.manifestVersion }
        : {}),
      ...(value.nowPlayingAssetId
        ? { nowPlayingAssetId: value.nowPlayingAssetId }
        : {}),
    };
    return this.request("/heartbeat", {
      method: "POST",
      body: JSON.stringify(wireValue),
    });
  }
}

declare const __APP_VERSION__: string;
