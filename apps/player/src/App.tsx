import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pairing } from "./components/Pairing";
import { Playback } from "./components/Playback";
import {
  developmentBearerAllowed,
  PlayerApi,
  PlayerApiFailure,
} from "./core/api";
import { CacheAssetRepository } from "./core/assets";
import {
  freeStorageBytes,
  finalizeDeviceIdentityRotation,
  hasNativeDeviceIdentity,
  installationId as getInstallationId,
  networkType,
} from "./core/device";
import { ManifestManager } from "./core/manifest";
import { SingleFlight } from "./core/single-flight";
import { IndexedDbPlayerStore } from "./core/storage";
import type {
  Credentials,
  Heartbeat,
  PendingProofPairing,
  PlayerManifest,
} from "./core/types";

const store = new IndexedDbPlayerStore();
const assetRepository = new CacheAssetRepository();
const manager = new ManifestManager(store, assetRepository);
const startedAt = Date.now();

export default function App() {
  const [installationId, setInstallationId] = useState("");
  const [credentials, setCredentials] = useState<Credentials>();
  const [pendingPairing, setPendingPairing] = useState<PendingProofPairing>();
  const [manifest, setManifest] = useState<PlayerManifest>();
  const [ready, setReady] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [fallback, setFallback] = useState(false);
  const [fatal, setFatal] = useState<string>();
  const playingRef = useRef<string | undefined>(undefined);
  const activeManifestVersionRef = useRef<string | undefined>(undefined);
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

  useEffect(() => {
    Promise.all([
      getInstallationId(),
      store.getCredentials(),
      manager.recover(),
      store.getPendingPairing(),
    ])
      .then(async ([id, savedCredentials, savedManifest, savedPending]) => {
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
        if (
          (savedCredentials && !validCredentials) ||
          (!savedCredentials && savedManifest)
        ) {
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
      })
      .catch(() => {
        setFatal("Player storage could not be opened or securely cleared");
        setReady(true);
      });
  }, []);

  const deprovision = useCallback(async () => {
    if (!deprovisionRef.current) {
      credentialEpochRef.current += 1;
      deprovisionRef.current = (async () => {
        playingRef.current = undefined;
        setCredentials(undefined);
        setManifest(undefined);
        setFallback(false);
        setFatal(undefined);
        try {
          await Promise.all([store.clear(), assetRepository.removeAll()]);
        } catch {
          setFatal("Revoked device data could not be securely cleared");
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
    if (!api || !online) return;
    await manifestSyncRef.current.run(async () => {
      const credentialEpoch = credentialEpochRef.current;
      try {
        const next = await manager.stageAndActivate(await api.manifest());
        if (credentialEpoch !== credentialEpochRef.current) {
          try {
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
        const saved = await manager.recover();
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
  }, [api, deprovision, online]);

  useEffect(() => {
    if (!credentials) return;
    void syncManifest();
    const timer = window.setInterval(syncManifest, 60_000);
    return () => clearInterval(timer);
  }, [credentials, syncManifest]);

  useEffect(() => {
    if (!manifest?.playbackEndsAt) return;
    const expectedVersion = manifest.version;
    const remaining = Date.parse(manifest.playbackEndsAt) - Date.now();
    const stop = () => {
      if (activeManifestVersionRef.current !== expectedVersion) return;
      playingRef.current = undefined;
      setManifest(undefined);
      setFallback(false);
    };
    if (remaining <= 0) {
      stop();
      return;
    }
    const timer = window.setTimeout(stop, remaining);
    return () => clearTimeout(timer);
  }, [manifest]);

  useEffect(() => {
    if (!manifest || manifest.priority !== "emergency") return;
    const expectedVersion = manifest.version;
    const remaining = Date.parse(manifest.validUntil) - Date.now();
    const restore = async () => {
      const prior = await manager.rollback(expectedVersion);
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
    if (remaining <= 0) {
      void restore();
      return;
    }
    const timer = window.setTimeout(() => void restore(), remaining);
    return () => clearTimeout(timer);
  }, [manifest]);

  useEffect(() => {
    if (!api || !credentials) return;
    const send = async () => {
      if (!navigator.onLine) return;
      const heartbeat: Heartbeat = {
        installationId: credentials.installationId,
        playerVersion: __APP_VERSION__,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1_000),
        freeStorageBytes: await freeStorageBytes(),
        networkType: networkType(),
        occurredAt: new Date().toISOString(),
        state: manifest ? (fallback ? "fallback" : "playing") : "pairing",
        ...(manifest ? { manifestVersion: manifest.version } : {}),
        ...(playingRef.current
          ? { nowPlayingAssetId: playingRef.current }
          : {}),
      };
      try {
        await api.heartbeat(heartbeat);
      } catch (reason) {
        if (reason instanceof PlayerApiFailure && reason.status === 401)
          await deprovision();
      }
    };
    void send();
    const timer = window.setInterval(
      send,
      credentials.heartbeatIntervalSeconds * 1_000,
    );
    return () => clearInterval(timer);
  }, [api, credentials, deprovision, fallback, manifest]);

  const paired = useCallback(async (value: Credentials) => {
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
      const prior = await manager.rollback(manifest?.version);
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
  }, [manifest]);
  const nowPlaying = useCallback((id: string) => {
    playingRef.current = id;
  }, []);

  if (!ready)
    return (
      <div className="boot">
        <img src="/brand/mascot.png" alt="" />
        <p>Starting player…</p>
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
