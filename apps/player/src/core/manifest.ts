import type { AssetRepository, PlayerManifest, PlayerStore } from "./types";

export class ManifestError extends Error {}

const MAX_ITEMS = 500;
const MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_RELEASE_BYTES = 4 * 1024 * 1024 * 1024;

function isAllowedAssetUrl(url: string, emergencyTemplate: boolean): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    if (
      parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)
    )
      return true;
    return emergencyTemplate && parsed.protocol === "data:";
  } catch {
    return false;
  }
}

export function assertManifest(
  value: unknown,
): asserts value is PlayerManifest {
  if (!value || typeof value !== "object")
    throw new ManifestError("Manifest is not an object");
  const manifest = value as Partial<PlayerManifest>;
  if (!manifest.version || !manifest.screenId || !Array.isArray(manifest.items))
    throw new ManifestError("Manifest metadata is incomplete");
  if (
    !manifest.generatedAt ||
    !manifest.validUntil ||
    Number.isNaN(Date.parse(manifest.generatedAt)) ||
    Number.isNaN(Date.parse(manifest.validUntil))
  )
    throw new ManifestError("Manifest validity window is invalid");
  if (Date.parse(manifest.validUntil) <= Date.parse(manifest.generatedAt))
    throw new ManifestError("Manifest validity window is empty");
  if (Date.parse(manifest.generatedAt) > Date.now() + 5 * 60_000)
    throw new ManifestError(
      "Manifest generation time is too far in the future",
    );
  if (
    !manifest.priority ||
    !["normal", "campaign", "priority", "emergency"].includes(manifest.priority)
  )
    throw new ManifestError("Manifest priority is invalid");
  if (!manifest.items.length)
    throw new ManifestError("Manifest contains no playable items");
  if (manifest.items.length > MAX_ITEMS)
    throw new ManifestError("Manifest contains too many items");
  const ids = new Set<string>();
  let releaseBytes = 0;
  for (const item of manifest.items) {
    if (!item || typeof item !== "object")
      throw new ManifestError("Manifest item is invalid");
    if (!item.id || ids.has(item.id))
      throw new ManifestError("Asset identifiers must be unique");
    ids.add(item.id);
    if (
      typeof item.url !== "string" ||
      !isAllowedAssetUrl(
        item.url,
        manifest.priority === "emergency" &&
          item.kind === "template" &&
          item.mimeType === "application/vnd.screengoblin.emergency+json",
      ) ||
      !["image", "video", "web", "template"].includes(item.kind) ||
      !Number.isInteger(item.durationSeconds) ||
      item.durationSeconds < 1 ||
      item.durationSeconds > 86_400 ||
      !Number.isSafeInteger(item.sizeBytes) ||
      item.sizeBytes < 0 ||
      item.sizeBytes > MAX_ASSET_BYTES
    )
      throw new ManifestError(`Asset ${item.id || "unknown"} is invalid`);
    releaseBytes += item.sizeBytes;
    if (releaseBytes > MAX_RELEASE_BYTES)
      throw new ManifestError("Manifest release exceeds the size limit");
    if (item.kind !== "web" && !/^[a-f\d]{64}$/i.test(item.checksumSha256))
      throw new ManifestError(`Asset ${item.id} has no valid SHA-256 checksum`);
  }
}

export class ManifestManager {
  constructor(
    private readonly store: PlayerStore,
    private readonly assets: AssetRepository,
  ) {}

  async stageAndActivate(candidate: unknown): Promise<PlayerManifest> {
    assertManifest(candidate);
    if (Date.parse(candidate.validUntil) <= Date.now())
      throw new ManifestError("Manifest has already expired");
    const active = await this.store.getActiveManifest();
    if (active?.version === candidate.version) return active;
    await Promise.all(
      candidate.items
        .filter((item) => item.kind !== "web")
        .map((item) => this.assets.prefetch(item)),
    );
    await this.store.activateManifest(candidate);
    return candidate;
  }

  async recover(): Promise<PlayerManifest | undefined> {
    const active = await this.store.getActiveManifest();
    if (
      active?.priority === "emergency" &&
      Date.parse(active.validUntil) <= Date.now()
    ) {
      const previous = await this.store.getPreviousManifest();
      if (
        previous?.priority === "emergency" &&
        Date.parse(previous.validUntil) <= Date.now()
      )
        return undefined;
      return this.store.rollback();
    }
    return active ?? this.store.rollback();
  }

  async rollback(): Promise<PlayerManifest | undefined> {
    return this.store.rollback();
  }
}
