import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pairing } from "./components/Pairing";
import { Playback } from "./components/Playback";
import { PlayerApi } from "./core/api";
import { CacheAssetRepository } from "./core/assets";
import {
  freeStorageBytes,
  installationId as getInstallationId,
  networkType,
} from "./core/device";
import { ManifestManager } from "./core/manifest";
import { IndexedDbPlayerStore } from "./core/storage";
import type { Credentials, Heartbeat, PlayerManifest } from "./core/types";

const store = new IndexedDbPlayerStore();
const assetRepository = new CacheAssetRepository();
const manager = new ManifestManager(store, assetRepository);
const startedAt = Date.now();

export default function App() {
  const [installationId, setInstallationId] = useState("");
  const [credentials, setCredentials] = useState<Credentials>();
  const [manifest, setManifest] = useState<PlayerManifest>();
  const [ready, setReady] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [fallback, setFallback] = useState(false);
  const [fatal, setFatal] = useState<string>();
  const playingRef = useRef<string | undefined>(undefined);
  const api = useMemo(
    () =>
      credentials
        ? new PlayerApi(
            credentials.apiBaseUrl,
            credentials.deviceToken,
            credentials.screenId,
            credentials.manifestVerificationKey,
          )
        : undefined,
    [credentials],
  );

  useEffect(() => {
    Promise.all([
      getInstallationId(),
      store.getCredentials(),
      manager.recover(),
    ])
      .then(([id, savedCredentials, savedManifest]) => {
        setInstallationId(id);
        if (savedCredentials && !savedCredentials.manifestVerificationKey) {
          void store.clear();
          setCredentials(undefined);
          setManifest(undefined);
          setFallback(false);
        } else {
          setCredentials(savedCredentials);
          setManifest(savedManifest);
          setFallback(Boolean(savedManifest));
        }
        setReady(true);
      })
      .catch(() => {
        setFatal("Player storage could not be opened");
        setReady(true);
      });
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
    try {
      const next = await manager.stageAndActivate(await api.manifest());
      setManifest(next);
      setFallback(false);
      setFatal(undefined);
    } catch (reason) {
      const saved = await manager.recover();
      if (saved) {
        setManifest(saved);
        setFallback(true);
      } else if (
        reason instanceof Error &&
        reason.message === "Manifest contains no playable items"
      ) {
        setManifest(undefined);
        setFatal(undefined);
      } else
        setFatal(
          reason instanceof Error
            ? reason.message
            : "No playable schedule is available",
        );
    }
  }, [api, online]);

  useEffect(() => {
    if (!credentials) return;
    void syncManifest();
    const timer = window.setInterval(syncManifest, 60_000);
    return () => clearInterval(timer);
  }, [credentials, syncManifest]);

  useEffect(() => {
    if (!manifest || manifest.priority !== "emergency") return;
    const remaining = Date.parse(manifest.validUntil) - Date.now();
    const restore = async () => {
      const prior = await manager.rollback();
      if (
        prior?.priority === "emergency" &&
        Date.parse(prior.validUntil) <= Date.now()
      ) {
        setManifest(undefined);
        setFallback(false);
      } else {
        setManifest(prior);
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
      await api.heartbeat(heartbeat).catch(() => undefined);
    };
    void send();
    const timer = window.setInterval(
      send,
      credentials.heartbeatIntervalSeconds * 1_000,
    );
    return () => clearInterval(timer);
  }, [api, credentials, fallback, manifest]);

  const paired = useCallback(async (value: Credentials) => {
    await store.putCredentials(value);
    setCredentials(value);
  }, []);
  const playbackError = useCallback(async () => {
    const prior = await manager.rollback();
    if (prior) {
      setManifest(prior);
      setFallback(true);
    } else {
      setManifest(undefined);
      setFatal("Cached playback content is unavailable");
    }
  }, []);
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
