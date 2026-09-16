import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pairing } from "./components/Pairing";
import { Playback } from "./components/Playback";
import {
  developmentBearerAllowed,
  PlayerApi,
  PlayerApiFailure,
} from "./core/api";
import { createAssetRepository } from "./core/assets";
import {
  freeStorageBytes,
  finalizeDeviceIdentityRotation,
  hasNativeDeviceIdentity,
  installationId as getInstallationId,
  networkType,
} from "./core/device";
import { ManifestManager, manifestPlaybackEndsAt } from "./core/manifest";
import { HeartbeatScheduler } from "./core/heartbeat-scheduler";
import { watchSignedDeadline } from "./core/signed-deadline";
import { createMonotonicUptime } from "./core/uptime";
import { SingleFlight } from "./core/single-flight";
import { IndexedDbPlayerStore } from "./core/storage";
import type {
  Credentials,
  Heartbeat,
  PendingProofPairing,
  PlayerManifest,
} from "./core/types";

const store = new IndexedDbPlayerStore();
const assetRepository = createAssetRepository();
const manager = new ManifestManager(store, assetRepository);
const uptimeSeconds = createMonotonicUptime();

export default function App() {
  const [installationId, setInstallationId] = useState("");
  const [credentials, setCredentials] = useState<Credentials>();
  const [pendingPairing, setPendingPairing] = useState<PendingProofPairing>();
  const [manifest, setManifest] = useState<PlayerManifest>();
  const [ready, setReady] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [fallback, setFallback] = useState(false);
  const [fatal, setFatal] = useState<string>();
  const [deprovisioning, setDeprovisioning] = useState(false);
  const playingRef = useRef<
    { manifestVersion: string; assetId: string } | undefined
  >(undefined);
  const activeManifestVersionRef = useRef<string | undefined>(undefined);
  const heartbeatImmediateRef = useRef(false);
  const manifestSyncRef = useRef(new SingleFlight());
  const deprovisionRef = useRef<Promise<void> | undefined>(undefined);
  const credentialEpochRef = useRef(0);
  activeManifestVersionRef.current = manifest?.version;
  const api = useMemo(
    () =>
      credentials
        ? new PlayerApi(credentials.apiBaseUrl, credentials)
        : undefined,
    [credentials],
  );
  const heartbeatContextRef = useRef({
    api,
    credentials,
    manifest,
    fallback,
  });
  heartbeatContextRef.current = { api, credentials, manifest, fallback };

  useEffect(() => {
    Promise.all([
      getInstallationId(),
      store.getCredentials(),
      store.getActiveManifest(),
      store.getPreviousManifest(),
      store.getPendingPairing(),
    ])
      .then(
        async ([
          id,
          savedCredentials,
          savedActive,
          savedPrevious,
          savedPending,
        ]) => {
          setInstallationId(id);
          let resumable = savedPending;
          if (resumable && Date.parse(resumable.expiresAt) <= Date.now()) {
            await store.deletePendingPairing();
            resumable = undefined;
          }
          if (savedCredentials && resumable) {
            await store.deletePendingPairing();
            resumable = undefined;
          }
          if (
            resumable &&
            (!hasNativeDeviceIdentity() ||
              resumable.expectedKeyId !== id ||
              resumable.installationId !== id)
          ) {
            setFatal(
              "Saved pairing recovery does not match this device identity",
            );
            setReady(true);
            return;
          }
          setPendingPairing(resumable);
          // A prior revocation may have removed credentials before native or
          // browser media cleanup failed. Credential absence is therefore a
          // durable cleanup marker: never expose pairing until a clean boot
          // proves no orphaned playback bytes remain.
          if (!savedCredentials && !savedActive && !savedPrevious)
            await assetRepository.removeAll();
          const validCredentials =
            savedCredentials &&
            savedCredentials.manifestVerificationKey &&
            ((savedCredentials.authMode === "proof-v1" &&
              hasNativeDeviceIdentity() &&
              savedCredentials.keyId === id &&
              savedCredentials.installationId === id) ||
              (savedCredentials.authMode === "development-bearer" &&
                !hasNativeDeviceIdentity() &&
                developmentBearerAllowed(savedCredentials.apiBaseUrl)));
          const savedManifest = validCredentials
            ? await manager.recover(savedCredentials)
            : undefined;
          if (
            (savedCredentials && !validCredentials) ||
            (!savedCredentials && (savedActive || savedPrevious))
          ) {
            manager.cancelPendingStages();
            await Promise.all([
              resumable ? store.clearProvisionedState() : store.clear(),
              assetRepository.removeAll(),
            ]);
            setCredentials(undefined);
            setManifest(undefined);
            setFallback(false);
          } else {
            if (savedCredentials?.authMode === "proof-v1") {
              try {
                await finalizeDeviceIdentityRotation(savedCredentials.keyId);
              } catch {
                setFatal(
                  "Activated device credentials require secure key cleanup",
                );
                setReady(true);
                return;
              }
            }
            setCredentials(savedCredentials);
            setManifest(savedManifest);
            setFallback(Boolean(savedManifest));
          }
          setReady(true);
        },
      )
      .catch(() => {
        setFatal("Player storage could not be opened or securely cleared");
        setReady(true);
      });
  }, []);

  const deprovision = useCallback(async () => {
    if (!deprovisionRef.current) {
      credentialEpochRef.current += 1;
      setDeprovisioning(true);
      deprovisionRef.current = (async () => {
        manager.cancelPendingStages();
        playingRef.current = undefined;
        setCredentials(undefined);
        setManifest(undefined);
        setFallback(false);
        setFatal(undefined);
        try {
          await Promise.all([store.clear(), assetRepository.removeAll()]);
          deprovisionRef.current = undefined;
        } catch {
          setFatal("Revoked device data could not be securely cleared");
        } finally {
          setDeprovisioning(false);
        }
      })();
    }
    await deprovisionRef.current;
  }, []);

  useEffect(() => {
    const connected = () => setOnline(true);
    const disconnected = () => setOnline(false);
    window.addEventListener("online", connected);
    window.addEventListener("offline", disconnected);
    return () => {
      window.removeEventListener("online", connected);
      window.removeEventListener("offline", disconnected);
    };
  }, []);

  const syncManifest = useCallback(async () => {
    if (!api || !credentials || !online) return;
    await manifestSyncRef.current.run(async () => {
      const credentialEpoch = credentialEpochRef.current;
      try {
        const next = await manager.stageAndActivate(
          await api.manifest(),
          credentials,
        );
        if (credentialEpoch !== credentialEpochRef.current) {
          try {
            manager.cancelPendingStages();
            await Promise.all([store.clear(), assetRepository.removeAll()]);
          } catch {
            setFatal("Revoked device data could not be securely cleared");
          }
          return;
        }
        if (!next) playingRef.current = undefined;
        setManifest(next);
        setFallback(false);
        setFatal(undefined);
      } catch (reason) {
        if (reason instanceof PlayerApiFailure && reason.status === 401) {
          await deprovision();
          return;
        }
        const saved = await manager.recover(credentials);
        if (credentialEpoch !== credentialEpochRef.current) return;
        if (saved) {
          setManifest(saved);
          setFallback(true);
        } else
          setFatal(
            reason instanceof Error
              ? reason.message
              : "No playable schedule is available",
          );
      }
    });
  }, [api, credentials, deprovision, online]);

  useEffect(() => {
    if (!credentials) return;
    void syncManifest();
    const timer = window.setInterval(syncManifest, 60_000);
    return () => clearInterval(timer);
  }, [credentials, syncManifest]);

  useEffect(() => {
    if (!manifest) return;
    const boundary = manifestPlaybackEndsAt(manifest);
    if (boundary === undefined) return;
    const expectedVersion = manifest.version;
    const stop = () => {
      if (activeManifestVersionRef.current !== expectedVersion) return;
      playingRef.current = undefined;
      setManifest(undefined);
      setFallback(false);
    };
    return watchSignedDeadline(boundary, stop);
  }, [manifest]);

  useEffect(() => {
    if (!manifest || manifest.priority !== "emergency") return;
    const expectedVersion = manifest.version;
    const boundary = Date.parse(manifest.validUntil);
    const restore = async () => {
      if (!credentials) return;
      const credentialEpoch = credentialEpochRef.current;
      // The signed emergency boundary is a display deadline. Blank first so
      // storage verification or rollback work can never extend the alert.
      if (activeManifestVersionRef.current === expectedVersion) {
        playingRef.current = undefined;
        setManifest(undefined);
        setFallback(false);
      }
      const prior = await manager.rollback(credentials, expectedVersion);
      if (credentialEpoch !== credentialEpochRef.current) return;
      if (
        prior?.priority === "emergency" &&
        Date.parse(prior.validUntil) <= Date.now()
      ) {
        setManifest(undefined);
        playingRef.current = undefined;
        setFallback(false);
      } else {
        setManifest(prior);
        if (!prior) playingRef.current = undefined;
        setFallback(Boolean(prior));
      }
    };
    return watchSignedDeadline(boundary, () => void restore());
  }, [credentials, manifest]);

  useEffect(() => {
    if (!api || !credentials) return;
    const scheduler = new HeartbeatScheduler({
      send: async (signal) => {
        const current = heartbeatContextRef.current;
        if (!current.api || !current.credentials)
          throw new DOMException("Heartbeat owner changed", "AbortError");
        const heartbeat: Heartbeat = {
          installationId: current.credentials.installationId,
          playerVersion: __APP_VERSION__,
          uptimeSeconds: uptimeSeconds(),
          freeStorageBytes: await freeStorageBytes(),
          networkType: networkType(),
          occurredAt: new Date().toISOString(),
          state: current.manifest
            ? current.fallback
              ? "fallback"
              : "playing"
            : "pairing",
          ...(current.manifest
            ? { manifestVersion: current.manifest.version }
            : {}),
          ...(playingRef.current &&
          playingRef.current.manifestVersion === current.manifest?.version
            ? { nowPlayingAssetId: playingRef.current.assetId }
            : {}),
        };
        return current.api.heartbeat(heartbeat, { signal });
      },
      onError: async (reason) => {
        if (reason instanceof PlayerApiFailure && reason.status === 401)
          await deprovision();
      },
      initialIntervalSeconds: credentials.heartbeatIntervalSeconds,
    });
    const connected = () => {
      if (!document.hidden) scheduler.resume();
    };
    const disconnected = () => scheduler.suspend();
    const lifecycleChanged = () => {
      if (navigator.onLine && !document.hidden) scheduler.resume();
      else scheduler.suspend();
    };
    window.addEventListener("online", connected);
    window.addEventListener("offline", disconnected);
    window.addEventListener("pageshow", lifecycleChanged);
    document.addEventListener("visibilitychange", lifecycleChanged);
    const immediate = heartbeatImmediateRef.current;
    heartbeatImmediateRef.current = false;
    scheduler.start(navigator.onLine && !document.hidden, immediate);
    return () => {
      scheduler.stop();
      window.removeEventListener("online", connected);
      window.removeEventListener("offline", disconnected);
      window.removeEventListener("pageshow", lifecycleChanged);
      document.removeEventListener("visibilitychange", lifecycleChanged);
    };
  }, [api, credentials, deprovision]);

  const paired = useCallback(async (value: Credentials) => {
    if (deprovisionRef.current)
      throw new Error("Revoked device cleanup is still in progress");
    await store.completePairing(value);
    if (value.authMode === "proof-v1") {
      try {
        await finalizeDeviceIdentityRotation(value.keyId);
      } catch (cause) {
        setFatal("Activated device credentials require secure key cleanup");
        throw new Error(
          "The replacement was activated, but old device keys could not be securely removed. Restart to retry cleanup.",
          { cause },
        );
      }
    }
    credentialEpochRef.current += 1;
    deprovisionRef.current = undefined;
    heartbeatImmediateRef.current = true;
    setPendingPairing(undefined);
    setCredentials(value);
  }, []);

  const persistPendingPairing = useCallback(
    async (value: PendingProofPairing) => {
      await store.putPendingPairing(value);
      setPendingPairing(value);
    },
    [],
  );
  const discardPendingPairing = useCallback(async () => {
    await store.deletePendingPairing();
    setPendingPairing(undefined);
  }, []);
  const playbackError = useCallback(async () => {
    try {
      if (!credentials) return;
      const credentialEpoch = credentialEpochRef.current;
      const prior = await manager.rollback(credentials, manifest?.version);
      if (credentialEpoch !== credentialEpochRef.current) return;
      if (prior) {
        setManifest(prior);
        setFallback(true);
        return;
      }
      setManifest(undefined);
      playingRef.current = undefined;
      setFatal("Cached playback content is unavailable");
    } catch {
      setManifest(undefined);
      playingRef.current = undefined;
      setFallback(false);
      setFatal("Playback recovery failed");
    }
  }, [credentials, manifest]);
  const nowPlaying = useCallback((id: string) => {
    const manifestVersion = activeManifestVersionRef.current;
    if (manifestVersion) playingRef.current = { manifestVersion, assetId: id };
  }, []);

  if (!ready)
    return (
      <div className="boot">
        <img src="/brand/mascot.png" alt="" />
        <p>Starting player…</p>
      </div>
    );
  if (deprovisioning)
    return (
      <div className="boot">
        <img src="/brand/mascot.png" alt="" />
        <p>Clearing revoked device data…</p>
      </div>
    );
  if (fatal && !manifest)
    return (
      <div className="fatal">
        <img src="/brand/mascot.png" alt="" />
        <h1>Player needs attention</h1>
        <p>{fatal}</p>
        <button onClick={() => location.reload()}>Try again</button>
      </div>
    );
  if (!credentials)
    return (
      <Pairing
        installationId={installationId}
        defaultApiUrl={import.meta.env.VITE_API_URL ?? location.origin}
        onPaired={paired}
        onIdentityChanged={setInstallationId}
        pendingPairing={pendingPairing}
        onPendingPairing={persistPendingPairing}
        onDiscardPendingPairing={discardPendingPairing}
      />
    );
  if (!manifest)
    return (
      <div className="boot">
        <img src="/brand/mascot.png" alt="" />
        <p>Waiting for a published schedule…</p>
        <span>{online ? "Connected" : "Offline"}</span>
      </div>
    );
  return (
    <Playback
      key={manifest.version}
      manifest={manifest}
      assets={assetRepository}
      offline={!online}
      fallback={fallback}
      identify={false}
      onPlaying={nowPlaying}
      onPlaybackError={playbackError}
    />
  );
}

declare const __APP_VERSION__: string;
