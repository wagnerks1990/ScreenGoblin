import type { AssetRepository, PlayerManifest, PlayerStore } from "./types";

export class ManifestError extends Error {}

const MAX_ITEMS = 500;
// The WebView implementation verifies content in memory. Keep the signed
// release contract within the repository's enforceable staging limits until
// native incremental hashing and stream-to-disk activation are available.
const MAX_ASSET_BYTES = 128 * 1024 * 1024;
const MAX_RELEASE_BYTES = 512 * 1024 * 1024;

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
    manifest.playbackEndsAt !== undefined &&
    (typeof manifest.playbackEndsAt !== "string" ||
      Number.isNaN(Date.parse(manifest.playbackEndsAt)))
  )
    throw new ManifestError("Manifest playback boundary is invalid");
  if (
    !manifest.priority ||
    !["normal", "campaign", "priority", "emergency"].includes(manifest.priority)
  )
    throw new ManifestError("Manifest priority is invalid");
  if (typeof manifest.withdrawn !== "boolean")
    throw new ManifestError("Manifest withdrawal state is missing");
  if (
    manifest.withdrawn &&
    (manifest.priority !== "normal" || manifest.items.length !== 0)
  )
    throw new ManifestError(
      "Withdrawn manifests must be empty normal releases",
    );
  if (!manifest.withdrawn && !manifest.items.length)
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
  private stagingTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: PlayerStore,
    private readonly assets: AssetRepository,
  ) {}

  async stageAndActivate(
    candidate: unknown,
  ): Promise<PlayerManifest | undefined> {
    const operation = this.stagingTail.then(() =>
      this.stageAndActivateExclusive(candidate),
    );
    this.stagingTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async stageAndActivateExclusive(
    candidate: unknown,
  ): Promise<PlayerManifest | undefined> {
    assertManifest(candidate);
    if (Date.parse(candidate.validUntil) <= Date.now())
      throw new ManifestError("Manifest has already expired");
    const active = await this.store.getActiveManifest();
    const playbackEnded =
      candidate.playbackEndsAt !== undefined &&
      Date.parse(candidate.playbackEndsAt) <= Date.now();
    if (active?.version !== candidate.version && !playbackEnded)
      await Promise.all(
        candidate.items
          .filter((item) => item.kind !== "web")
          .map((item) => this.assets.prefetch(item)),
      );
    await this.store.activateManifest(candidate);
    if (this.assets.prune) {
      try {
        const activeAfterActivation = await this.store.getActiveManifest();
        const previousAfterActivation = await this.store.getPreviousManifest();
        const retainedAssets = [activeAfterActivation, previousAfterActivation]
          .filter((manifest): manifest is PlayerManifest => Boolean(manifest))
          .flatMap((manifest) => manifest.items);
        await this.assets.prune(retainedAssets);
      } catch {
        // Cache collection is best-effort and must not make a successful,
        // durable activation appear to have failed.
      }
    }
    return candidate.withdrawn || playbackEnded ? undefined : candidate;
  }

  async recover(): Promise<PlayerManifest | undefined> {
    const active = await this.store.getActiveManifest();
    if (active?.withdrawn) return undefined;
    // `validUntil` is only the signed-envelope refresh lease for normal
    // last-known-good playback. `playbackEndsAt` is the signed hard schedule
    // boundary and blanks locally without reviving an older release.
    if (
      active?.playbackEndsAt !== undefined &&
      Date.parse(active.playbackEndsAt) <= Date.now()
    )
      return undefined;
    if (
      active?.priority === "emergency" &&
      Date.parse(active.validUntil) <= Date.now()
    ) {
      const rollbackCandidate = await this.store.getPreviousManifest();
      if (
        rollbackCandidate?.priority === "emergency" &&
        Date.parse(rollbackCandidate.validUntil) <= Date.now()
      )
        return undefined;
      const previous = await this.store.rollback(active.version);
      return previous?.withdrawn ? undefined : previous;
    }
    if (active) return active;
    const previous = await this.store.rollback();
    return previous?.withdrawn ? undefined : previous;
  }

  async rollback(
    expectedActiveVersion?: string,
  ): Promise<PlayerManifest | undefined> {
    const resultingActive = await this.store.rollback(expectedActiveVersion);
    if (
      resultingActive?.withdrawn ||
      (resultingActive?.playbackEndsAt !== undefined &&
        Date.parse(resultingActive.playbackEndsAt) <= Date.now())
    )
      return undefined;
    return resultingActive;
  }
}
