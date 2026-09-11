import { useEffect, useState } from "react";
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
  onPlaybackError: () => void;
}

export function Playback({
  manifest,
  assets,
  offline,
  fallback,
  identify,
  onPlaying,
  onPlaybackError,
}: Props) {
  const [index, setIndex] = useState(0);
  const [source, setSource] = useState<string>();
  const [template, setTemplate] = useState<{
    title: string;
    message: string;
    backgroundColor?: string;
  }>();
  const item = manifest.items[index % manifest.items.length] as PlayerAsset;

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    assets
      .resolve(item)
      .then((url) => {
        if (cancelled) {
          if (url.startsWith("blob:")) URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        setSource(url);
        if (item.kind === "template") {
          return fetch(url)
            .then((response) => response.json())
            .then((value: unknown) => {
              if (!value || typeof value !== "object")
                throw new Error("Template content is invalid");
              const record = value as Record<string, unknown>;
              if (
                typeof record.title !== "string" ||
                typeof record.message !== "string"
              )
                throw new Error("Template content is incomplete");
              setTemplate({
                title: record.title,
                message: record.message,
                ...(typeof record.backgroundColor === "string"
                  ? { backgroundColor: record.backgroundColor }
                  : {}),
              });
              onPlaying(item.id);
            });
        }
        onPlaying(item.id);
      })
      .catch(onPlaybackError);
    const timer = window.setTimeout(() => {
      setSource(undefined);
      setTemplate(undefined);
      setIndex((current) => (current + 1) % manifest.items.length);
    }, item.durationSeconds * 1_000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (objectUrl?.startsWith("blob:")) URL.revokeObjectURL(objectUrl);
    };
  }, [assets, item, manifest.items.length, onPlaybackError, onPlaying]);

  return (
    <main className="playback">
      {source && item.kind === "image" && <img src={source} alt="" />}
      {source && item.kind === "video" && (
        <video
          key={source}
          src={source}
          autoPlay
          muted
          playsInline
          onEnded={() =>
            setIndex((current) => (current + 1) % manifest.items.length)
          }
          onError={onPlaybackError}
        />
      )}
      {source && item.kind === "web" && (
        <iframe
          src={source}
          title="Signage web content"
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      )}
      {source && item.kind === "template" && template && (
        <section
          className="emergency-template"
          style={{ backgroundColor: template.backgroundColor }}
        >
          <p>Emergency message</p>
          <h1>{template.title}</h1>
          <div>{template.message}</div>
        </section>
      )}
      {manifest.priority === "emergency" && (
        <div className="emergency-label">Emergency message</div>
      )}
      {(offline || fallback) && (
        <div className="status-pill">
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
