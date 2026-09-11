import type { AssetRepository, PlayerManifest, PlayerStore } from "./types";

export class ManifestError extends Error {}

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
  if (
    !manifest.priority ||
    !["normal", "campaign", "priority", "emergency"].includes(manifest.priority)
  )
    throw new ManifestError("Manifest priority is invalid");
  if (!manifest.items.length)
    throw new ManifestError("Manifest contains no playable items");
  const ids = new Set<string>();
  for (const item of manifest.items) {
    if (!item.id || ids.has(item.id))
      throw new ManifestError("Asset identifiers must be unique");
    ids.add(item.id);
    if (
      !item.url ||
      !["image", "video", "web", "template"].includes(item.kind) ||
      item.durationSeconds <= 0
    )
      throw new ManifestError(`Asset ${item.id || "unknown"} is invalid`);
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
