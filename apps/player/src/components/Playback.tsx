import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AssetRepository,
  PlayerAsset,
  PlayerManifest,
} from "../core/types";

interface Props {
  manifest: PlayerManifest;
  assets: AssetRepository;
  offline: boolean;
  fallback: boolean;
  identify: boolean;
  onPlaying: (id: string) => void;
  onPlaybackError: () => void | Promise<void>;
}

const READINESS_TIMEOUT_MS = 30_000;

export function Playback(props: Props) {
  return props.manifest.items.length ? (
    <PlaybackContent key={props.manifest.version} {...props} />
  ) : (
    <UnavailablePlayback key={props.manifest.version} {...props} />
  );
}

function UnavailablePlayback({ onPlaybackError }: Props) {
  useEffect(() => {
    void Promise.resolve(onPlaybackError()).catch(() => undefined);
  }, [onPlaybackError]);
  return <main className="playback" />;
}

function PlaybackContent({
  manifest,
  assets,
  offline,
  fallback,
  identify,
  onPlaying,
  onPlaybackError,
}: Props) {
  const [position, setPosition] = useState(0);
  const [source, setSource] = useState<{
    generation: string;
    url: string;
  }>();
  const [template, setTemplate] = useState<{
    generation: string;
    title: string;
    message: string;
    backgroundColor?: string;
  }>();
  const [readyGeneration, setReadyGeneration] = useState<string>();
  const item = manifest.items[position % manifest.items.length] as PlayerAsset;
  const {
    id: itemId,
    kind: itemKind,
    url: itemUrl,
    mimeType: itemMimeType,
    checksumSha256: itemChecksum,
    sizeBytes: itemSize,
    durationSeconds: itemDuration,
  } = item;
  const generation = JSON.stringify([
    manifest.version,
    position,
    itemId,
    itemKind,
    itemUrl,
    itemMimeType,
    itemChecksum,
    itemSize,
    itemDuration,
  ]);
  const activeGeneration = useRef(generation);
  const ready = useRef<string | undefined>(undefined);
  const settled = useRef<string | undefined>(undefined);
  const activeBlob = useRef<{ generation: string; url: string } | undefined>(
    undefined,
  );
  const activeTemplateRequest = useRef<
    { generation: string; controller: AbortController } | undefined
  >(undefined);
  const onPlayingRef = useRef(onPlaying);
  const onPlaybackErrorRef = useRef(onPlaybackError);
  activeGeneration.current = generation;
  onPlayingRef.current = onPlaying;
  onPlaybackErrorRef.current = onPlaybackError;

  const revokeBlob = useCallback((candidateGeneration: string) => {
    if (activeBlob.current?.generation !== candidateGeneration) return;
    URL.revokeObjectURL(activeBlob.current.url);
    activeBlob.current = undefined;
  }, []);

  const markReady = useCallback(
    (candidateGeneration: string, assetId: string) => {
      if (
        activeGeneration.current !== candidateGeneration ||
        ready.current === candidateGeneration ||
        settled.current === candidateGeneration
      )
        return;
      ready.current = candidateGeneration;
      setReadyGeneration(candidateGeneration);
      onPlayingRef.current(assetId);
    },
    [],
  );

  const fail = useCallback(
    (candidateGeneration: string) => {
      if (
        activeGeneration.current !== candidateGeneration ||
        settled.current === candidateGeneration
      )
        return;
      settled.current = candidateGeneration;
      setReadyGeneration(undefined);
      if (activeTemplateRequest.current?.generation === candidateGeneration) {
        activeTemplateRequest.current.controller.abort();
        activeTemplateRequest.current = undefined;
      }
      revokeBlob(candidateGeneration);
      setSource(undefined);
      setTemplate(undefined);
      void Promise.resolve(onPlaybackErrorRef.current()).catch(() => undefined);
    },
    [revokeBlob],
  );

  const advance = useCallback(
    (candidateGeneration: string) => {
      if (
        activeGeneration.current !== candidateGeneration ||
        settled.current === candidateGeneration
      )
        return;
      settled.current = candidateGeneration;
      setReadyGeneration(undefined);
      revokeBlob(candidateGeneration);
      setPosition((current) => current + 1);
    },
    [revokeBlob],
  );

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    const templateRequest = new AbortController();
    activeTemplateRequest.current = { generation, controller: templateRequest };
    setSource(undefined);
    setTemplate(undefined);
    setReadyGeneration(undefined);

    void (async () => {
      try {
        if (itemKind === "web")
          throw new Error("Web content playback is disabled");
        const url = await assets.resolve({
          id: itemId,
          kind: itemKind,
          url: itemUrl,
          mimeType: itemMimeType,
          checksumSha256: itemChecksum,
          sizeBytes: itemSize,
          durationSeconds: itemDuration,
        });
        if (
          cancelled ||
          activeGeneration.current !== generation ||
          settled.current === generation
        ) {
          if (url.startsWith("blob:")) URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        if (url.startsWith("blob:")) activeBlob.current = { generation, url };
        if (itemKind === "template") {
          const response = await fetch(url, { signal: templateRequest.signal });
          if (!response.ok) throw new Error("Template content is unavailable");
          const contentType = response.headers
            .get("Content-Type")
            ?.split(";", 1)[0]
            ?.trim()
            .toLowerCase();
          if (
            contentType !== "application/json" &&
            contentType !== "application/vnd.screengoblin.emergency+json"
          )
            throw new Error("Template content type is invalid");
          const value: unknown = await response.json();
          if (!value || typeof value !== "object")
            throw new Error("Template content is invalid");
          const record = value as Record<string, unknown>;
          if (
            typeof record.title !== "string" ||
            record.title.length < 1 ||
            record.title.length > 120 ||
            typeof record.message !== "string" ||
            record.message.length < 1 ||
            record.message.length > 2_000 ||
            (record.backgroundColor !== undefined &&
              (typeof record.backgroundColor !== "string" ||
                !/^#[0-9a-f]{6}$/i.test(record.backgroundColor)))
          )
            throw new Error("Template content is incomplete");
          if (
            cancelled ||
            activeGeneration.current !== generation ||
            settled.current === generation
          )
            return;
          setSource({ generation, url });
          setTemplate({
            generation,
            title: record.title,
            message: record.message,
            ...(typeof record.backgroundColor === "string"
              ? { backgroundColor: record.backgroundColor }
              : {}),
          });
          return;
        }
        setSource({ generation, url });
      } catch {
        if (!cancelled) fail(generation);
      }
    })();

    return () => {
      cancelled = true;
      templateRequest.abort();
      if (activeTemplateRequest.current?.generation === generation)
        activeTemplateRequest.current = undefined;
      if (objectUrl?.startsWith("blob:")) revokeBlob(generation);
    };
  }, [
    assets,
    fail,
    generation,
    itemChecksum,
    itemDuration,
    itemId,
    itemKind,
    itemMimeType,
    itemSize,
    itemUrl,
    revokeBlob,
  ]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (ready.current !== generation) fail(generation);
    }, READINESS_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [fail, generation]);

  useEffect(() => {
    if (template?.generation === generation) markReady(generation, item.id);
  }, [generation, item.id, markReady, template]);

  useEffect(() => {
    if (readyGeneration !== generation) return;
    const timer = window.setTimeout(
      () => advance(generation),
      item.durationSeconds * 1_000,
    );
    return () => clearTimeout(timer);
  }, [advance, generation, item.durationSeconds, readyGeneration]);

  const currentSource =
    source?.generation === generation ? source.url : undefined;
  const currentTemplate =
    template?.generation === generation ? template : undefined;

  return (
    <main className="playback">
      {currentSource && item.kind === "image" && (
        <img
          src={currentSource}
          alt=""
          onLoad={() => markReady(generation, item.id)}
          onError={() => fail(generation)}
        />
      )}
      {currentSource && item.kind === "video" && (
        <video
          key={currentSource}
          src={currentSource}
          autoPlay
          muted
          playsInline
          onPlaying={() => markReady(generation, item.id)}
          onEnded={() => advance(generation)}
          onError={() => fail(generation)}
        />
      )}
      {currentSource && item.kind === "template" && currentTemplate && (
        <section
          className="emergency-template"
          style={{ backgroundColor: currentTemplate.backgroundColor }}
        >
          <p>Emergency message</p>
          <h1>{currentTemplate.title}</h1>
          <div>{currentTemplate.message}</div>
        </section>
      )}
      {manifest.priority === "emergency" && (
        <div className="emergency-label" role="alert">
          Emergency message
        </div>
      )}
      {(offline || fallback) && (
        <div className="status-pill" role="status">
          {fallback ? "Playing saved schedule" : "Offline"}
        </div>
      )}
      {identify && (
        <div className="identify">
          <img src="/brand/mascot.png" alt="" />
          <div>
            <span>This screen is</span>
            <strong>{manifest.screenId}</strong>
          </div>
        </div>
      )}
    </main>
  );
}
