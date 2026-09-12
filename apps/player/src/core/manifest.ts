import { verifyManifestPayloadSignature } from "./crypto";
import type {
  AssetRepository,
  ManifestTrust,
  PlayerManifest,
  PlayerStore,
  SignedPlayerManifest,
} from "./types";

export class ManifestError extends Error {}

const MAX_ITEMS = 500;
const MAX_CONCURRENT_PREFETCHES = 2;
// The WebView implementation verifies content in memory. Keep the signed
// release contract within the repository's enforceable staging limits until
// native incremental hashing and stream-to-disk activation are available.
const MAX_ASSET_BYTES = 128 * 1024 * 1024;
const MAX_RELEASE_BYTES = 512 * 1024 * 1024;

function isAllowedKindAndMime(
  item: PlayerManifest["items"][number],
  priority: PlayerManifest["priority"],
): boolean {
  if (
    priority === "emergency" &&
    item.kind === "template" &&
    item.mimeType === "application/vnd.screengoblin.emergency+json"
  )
    return true;
  return (
    (item.kind === "image" &&
      ["image/jpeg", "image/png"].includes(item.mimeType)) ||
    (item.kind === "video" && item.mimeType === "video/mp4") ||
    (item.kind === "template" && item.mimeType === "application/json")
  );
}

export function manifestPlaybackEndsAt(
  manifest: PlayerManifest,
): number | undefined {
  const boundaries = [
    manifest.playbackEndsAt,
    ...manifest.items.map((item) => item.expiresAt),
  ]
    .filter((value): value is string => value !== undefined)
    .map(Date.parse)
    .filter(Number.isFinite);
  return boundaries.length > 0 ? Math.min(...boundaries) : undefined;
}

function isStoredManifestPlayable(
  manifest: PlayerManifest | undefined,
): manifest is PlayerManifest {
  if (!manifest || manifest.withdrawn) return false;
  try {
    assertManifest(manifest);
  } catch {
    return false;
  }
  if (
    manifest.priority === "emergency" &&
    Date.parse(manifest.validUntil) <= Date.now()
  )
    return false;
  const boundary = manifestPlaybackEndsAt(manifest);
  return boundary === undefined || boundary > Date.now();
}

function isAllowedAssetUrl(url: string, emergencyTemplate: boolean): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return false;
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
      !isAllowedKindAndMime(item, manifest.priority) ||
      !Number.isInteger(item.durationSeconds) ||
      item.durationSeconds < 1 ||
      item.durationSeconds > 86_400 ||
      !Number.isSafeInteger(item.sizeBytes) ||
      item.sizeBytes < 1 ||
      item.sizeBytes > MAX_ASSET_BYTES
    )
      throw new ManifestError(`Asset ${item.id || "unknown"} is invalid`);
    releaseBytes += item.sizeBytes;
    if (releaseBytes > MAX_RELEASE_BYTES)
      throw new ManifestError("Manifest release exceeds the size limit");
    if (!/^[a-f\d]{64}$/i.test(item.checksumSha256))
      throw new ManifestError(`Asset ${item.id} has no valid SHA-256 checksum`);
    if (
      item.expiresAt !== undefined &&
      (typeof item.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(item.expiresAt)) ||
        Date.parse(item.expiresAt) <= Date.parse(manifest.generatedAt))
    )
      throw new ManifestError(`Asset ${item.id} expiry is invalid`);
  }
}

function normalizeSignedPayload(value: unknown): PlayerManifest {
  if (!value || typeof value !== "object")
    throw new ManifestError("Signed manifest payload is invalid");
  const wire = value as Record<string, unknown>;
  if (!Array.isArray(wire.items))
    throw new ManifestError("Signed manifest items are invalid");
  const manifest = {
    version: wire.version,
    generatedAt: wire.generatedAt,
    validUntil: wire.validUntil,
    ...(wire.playbackEndsAt !== undefined
      ? { playbackEndsAt: wire.playbackEndsAt }
      : {}),
    screenId: wire.screenId,
    ...(wire.requestChallengeId !== undefined
      ? { requestChallengeId: wire.requestChallengeId }
      : {}),
    priority: wire.priority,
    // Pre-0.1 signed envelopes did not carry an explicit withdrawal marker.
    withdrawn: wire.withdrawn ?? false,
    items: wire.items.map((item) => {
      if (!item || typeof item !== "object")
        throw new ManifestError("Signed manifest item is invalid");
      const playlistItem = item as Record<string, unknown>;
      if (!playlistItem.asset || typeof playlistItem.asset !== "object")
        throw new ManifestError("Signed manifest asset is invalid");
      return {
        ...(playlistItem.asset as Record<string, unknown>),
        durationSeconds: playlistItem.durationSeconds,
      };
    }),
  };
  assertManifest(manifest);
  return manifest;
}

export function createSignedPlayerManifest(
  unsigned: unknown,
  signatureAlgorithm: "Ed25519",
  signature: string,
): SignedPlayerManifest {
  const payloadJson = JSON.stringify(unsigned);
  return {
    formatVersion: 1,
    payloadJson,
    signatureAlgorithm,
    signature,
    manifest: normalizeSignedPayload(unsigned),
  };
}

export async function verifySignedPlayerManifest(
  value: unknown,
  trust: ManifestTrust,
): Promise<PlayerManifest | undefined> {
  if (!value || typeof value !== "object") return undefined;
  const stored = value as Partial<SignedPlayerManifest>;
  if (
    stored.formatVersion !== 1 ||
    typeof stored.payloadJson !== "string" ||
    stored.signatureAlgorithm !== "Ed25519" ||
    typeof stored.signature !== "string" ||
    !stored.manifest
  )
    return undefined;
  try {
    if (
      !(await verifyManifestPayloadSignature(
        stored.payloadJson,
        stored.signature,
        trust.manifestVerificationKey,
      ))
    )
      return undefined;
    const manifest = normalizeSignedPayload(JSON.parse(stored.payloadJson));
    if (
      manifest.screenId !== trust.screenId ||
      JSON.stringify(manifest) !== JSON.stringify(stored.manifest)
    )
      return undefined;
    return manifest;
  } catch {
    return undefined;
  }
}

export class ManifestManager {
  private stateTail: Promise<void> = Promise.resolve();
  private stagingTail: Promise<void> = Promise.resolve();
  private stagingGeneration = 0;

  constructor(
    private readonly store: PlayerStore,
    private readonly assets: AssetRepository,
  ) {}

  async stageAndActivate(
    signedCandidate: SignedPlayerManifest,
    trust: ManifestTrust,
  ): Promise<PlayerManifest | undefined> {
    const candidate = await verifySignedPlayerManifest(signedCandidate, trust);
    if (!candidate)
      throw new ManifestError(
        "Manifest signature or screen binding is invalid",
      );
    if (Date.parse(candidate.validUntil) <= Date.now())
      throw new ManifestError("Manifest has already expired");

    const stagingGeneration = this.stagingGeneration;
    return this.enqueueStaging(() =>
      this.stageAndActivateExclusive(signedCandidate, trust, stagingGeneration),
    );
  }

  cancelPendingStages(): void {
    this.stagingGeneration += 1;
  }

  private async stageAndActivateExclusive(
    signedCandidate: SignedPlayerManifest,
    trust: ManifestTrust,
    stagingGeneration: number,
  ): Promise<PlayerManifest | undefined> {
    this.assertStagingGeneration(stagingGeneration);
    const candidate = await verifySignedPlayerManifest(signedCandidate, trust);
    this.assertStagingGeneration(stagingGeneration);
    if (!candidate)
      throw new ManifestError(
        "Manifest signature or screen binding is invalid",
      );
    if (Date.parse(candidate.validUntil) <= Date.now())
      throw new ManifestError("Manifest has already expired");

    const signedActiveAtStage = await this.store.getActiveManifest();
    const activeAtStage = await verifySignedPlayerManifest(
      signedActiveAtStage,
      trust,
    );
    this.assertStagingGeneration(stagingGeneration);
    this.assertNotOlderThanActive(candidate, activeAtStage);

    // Remove crash leftovers before reserving space for another release. The
    // complete staging operation is serialized so a later collection cannot
    // delete files an earlier release has downloaded but not activated yet.
    await this.pruneRetainedAssets();
    this.assertStagingGeneration(stagingGeneration);
    const playbackBoundary = manifestPlaybackEndsAt(candidate);
    const playbackEnded =
      playbackBoundary !== undefined && playbackBoundary <= Date.now();
    // Re-run repository verification for every playable envelope refresh,
    // including the same semantic release. Cache hits are cheap, while this
    // repairs evicted or corrupted future playlist items before playback.
    if (!playbackEnded)
      await this.prefetchAssets(candidate.items, stagingGeneration);

    // Downloads deliberately stay off the state queue: a blackholed release
    // must not delay emergency expiry recovery or playback rollback.
    this.assertStagingGeneration(stagingGeneration);
    const result = await this.enqueueState(() =>
      this.activateExclusive(signedCandidate, trust, stagingGeneration),
    );
    await this.pruneRetainedAssets();
    return result;
  }

  private async prefetchAssets(
    items: PlayerManifest["items"],
    stagingGeneration: number,
  ): Promise<void> {
    let nextIndex = 0;
    let stopped = false;
    let failure: unknown;
    const worker = async (): Promise<void> => {
      while (!stopped) {
        try {
          this.assertStagingGeneration(stagingGeneration);
        } catch (error) {
          if (!stopped) {
            stopped = true;
            failure = error;
          }
          return;
        }
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        try {
          await this.assets.prefetch(items[index]!);
          this.assertStagingGeneration(stagingGeneration);
        } catch (error) {
          if (!stopped) {
            stopped = true;
            failure = error;
          }
          return;
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(MAX_CONCURRENT_PREFETCHES, items.length) },
        () => worker(),
      ),
    );
    if (stopped) throw failure;
  }

  private assertStagingGeneration(expected: number): void {
    if (expected !== this.stagingGeneration)
      throw new ManifestError("Manifest staging was cancelled");
  }

  private assertNotOlderThanActive(
    candidate: PlayerManifest,
    active: PlayerManifest | undefined,
  ): void {
    if (!active) return;
    const candidateGeneratedAt = Date.parse(candidate.generatedAt);
    const activeGeneratedAt = Date.parse(active.generatedAt);
    if (candidateGeneratedAt < activeGeneratedAt)
      throw new ManifestError(
        "Manifest generation time is older than the active release",
      );
    if (
      candidateGeneratedAt === activeGeneratedAt &&
      candidate.version !== active.version &&
      (candidate.requestChallengeId !== undefined ||
        active.requestChallengeId !== undefined)
    )
      throw new ManifestError(
        "Manifest generation time is ambiguous with the active release",
      );
  }

  private enqueueState<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.stateTail.then(operation);
    this.stateTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private enqueueStaging<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.stagingTail.then(operation);
    this.stagingTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async activateExclusive(
    signedCandidate: SignedPlayerManifest,
    trust: ManifestTrust,
    stagingGeneration: number,
  ): Promise<PlayerManifest | undefined> {
    this.assertStagingGeneration(stagingGeneration);
    const candidate = await verifySignedPlayerManifest(signedCandidate, trust);
    this.assertStagingGeneration(stagingGeneration);
    if (!candidate)
      throw new ManifestError(
        "Manifest signature or screen binding is invalid",
      );
    if (Date.parse(candidate.validUntil) <= Date.now())
      throw new ManifestError("Manifest has already expired");
    const playbackBoundary = manifestPlaybackEndsAt(candidate);
    const playbackEnded =
      playbackBoundary !== undefined && playbackBoundary <= Date.now();
    const signedActive = await this.store.getActiveManifest();
    const active = await verifySignedPlayerManifest(signedActive, trust);
    this.assertStagingGeneration(stagingGeneration);
    if (signedActive && !active) await this.store.clearManifests();
    this.assertNotOlderThanActive(candidate, active);
    this.assertStagingGeneration(stagingGeneration);
    await this.store.activateManifest(signedCandidate);
    return candidate.withdrawn || playbackEnded ? undefined : candidate;
  }

  private async pruneRetainedAssets(): Promise<void> {
    if (this.assets.prune) {
      try {
        const activeAfterActivation = await this.store.getActiveManifest();
        const previousAfterActivation = await this.store.getPreviousManifest();
        const retainedAssets = [activeAfterActivation, previousAfterActivation]
          .filter((manifest): manifest is SignedPlayerManifest =>
            Boolean(manifest),
          )
          .flatMap((manifest) => manifest.manifest.items);
        await this.assets.prune(retainedAssets);
      } catch {
        // Cache collection is best-effort and must not make a successful,
        // durable activation appear to have failed.
      }
    }
  }

  async recover(trust: ManifestTrust): Promise<PlayerManifest | undefined> {
    const recovered = await this.enqueueState(() =>
      this.recoverExclusive(trust),
    );
    // Recovery must return even if a download is stalled. Queue collection
    // behind staging without awaiting it so it cannot delete uncommitted files
    // or delay restoration of last-known-good playback.
    void this.enqueueStaging(() => this.pruneRetainedAssets()).catch(
      () => undefined,
    );
    return recovered;
  }

  private async recoverExclusive(
    trust: ManifestTrust,
  ): Promise<PlayerManifest | undefined> {
    const signedActive = await this.store.getActiveManifest();
    const active = await verifySignedPlayerManifest(signedActive, trust);
    if (signedActive && !active) {
      await this.store.clearManifests();
      return undefined;
    }
    if (active?.withdrawn) return undefined;
    // `validUntil` is only the signed-envelope refresh lease for normal
    // last-known-good playback. `playbackEndsAt` is the signed hard schedule
    // boundary and blanks locally without reviving an older release.
    if (
      active?.priority === "emergency" &&
      Date.parse(active.validUntil) <= Date.now()
    ) {
      const signedRollbackCandidate = await this.store.getPreviousManifest();
      const rollbackCandidate = await verifySignedPlayerManifest(
        signedRollbackCandidate,
        trust,
      );
      if (signedRollbackCandidate && !rollbackCandidate) {
        await this.store.clearManifests();
        return undefined;
      }
      if (
        rollbackCandidate?.priority === "emergency" &&
        Date.parse(rollbackCandidate.validUntil) <= Date.now()
      )
        return undefined;
      const previous = await this.store.rollback(active.version);
      const verifiedPrevious = await verifySignedPlayerManifest(
        previous,
        trust,
      );
      return isStoredManifestPlayable(verifiedPrevious)
        ? verifiedPrevious
        : undefined;
    }
    if (active && !isStoredManifestPlayable(active)) return undefined;
    if (active) return active;
    const signedPrevious = await this.store.getPreviousManifest();
    if (signedPrevious) {
      await this.store.clearManifests();
    }
    return undefined;
  }

  async rollback(
    trust: ManifestTrust,
    expectedActiveVersion?: string,
  ): Promise<PlayerManifest | undefined> {
    return this.enqueueState(() =>
      this.rollbackExclusive(trust, expectedActiveVersion),
    );
  }

  private async rollbackExclusive(
    trust: ManifestTrust,
    expectedActiveVersion?: string,
  ): Promise<PlayerManifest | undefined> {
    const signedActive = await this.store.getActiveManifest();
    const active = await verifySignedPlayerManifest(signedActive, trust);
    if (!active) {
      if (signedActive || (await this.store.getPreviousManifest()))
        await this.store.clearManifests();
      return undefined;
    }
    if (
      expectedActiveVersion !== undefined &&
      active.version !== expectedActiveVersion
    )
      return isStoredManifestPlayable(active) ? active : undefined;
    const signedPrevious = await this.store.getPreviousManifest();
    const previous = await verifySignedPlayerManifest(signedPrevious, trust);
    if (signedPrevious && !previous) {
      await this.store.clearManifests();
      return undefined;
    }
    const resultingActive = await this.store.rollback(expectedActiveVersion);
    const verifiedActive = await verifySignedPlayerManifest(
      resultingActive,
      trust,
    );
    if (resultingActive && !verifiedActive) {
      await this.store.clearManifests();
      return undefined;
    }
    return isStoredManifestPlayable(verifiedActive)
      ? verifiedActive
      : undefined;
  }
}
