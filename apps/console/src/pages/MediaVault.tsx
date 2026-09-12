import type { MediaAsset } from "@screengoblin/contracts";
import { useEffect, useMemo, useState } from "react";
import {
  Grid3X3,
  List,
  Image as ImageIcon,
  Video,
  Globe2,
  LayoutTemplate,
  FileQuestion,
  TriangleAlert,
  LockKeyhole,
} from "lucide-react";
import { assets, type Asset } from "../data";
import { api } from "../api";
import {
  Button,
  EmptyState,
  PageHeader,
  SearchBox,
  Select,
} from "../components";

type VaultAsset = Asset & { source: "live" | "provisioned" };

const typeName = (kind: MediaAsset["kind"]): Asset["type"] =>
  (
    ({
      image: "Image",
      video: "Video",
      web: "Web",
      template: "Template",
    }) as const
  )[kind];

const formatBytes = (bytes: number) => {
  if (bytes === 0) return "0 B";
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${["B", "KB", "MB", "GB"][unit]}`;
};

const formatDate = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );

const presentLiveAsset = (asset: MediaAsset): VaultAsset => ({
  id: asset.id,
  name: asset.name,
  type: typeName(asset.kind),
  ratio: asset.mimeType,
  size: formatBytes(asset.sizeBytes),
  updated: formatDate(asset.createdAt),
  ...(asset.expiresAt ? { expires: formatDate(asset.expiresAt) } : {}),
  color: { image: "violet", video: "blue", web: "cyan", template: "green" }[
    asset.kind
  ],
  source: "live",
});

export function MediaVault() {
  const [query, setQuery] = useState("");
  const [type, setType] = useState("All types");
  const [view, setView] = useState<"grid" | "list">("grid");
  const liveViewRequested = api.hasLiveSession() || !api.demoAllowed();
  const [inventory, setInventory] = useState<VaultAsset[]>(
    liveViewRequested
      ? []
      : assets.map((asset) => ({ ...asset, source: "provisioned" })),
  );
  const [loading, setLoading] = useState(liveViewRequested);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    if (!liveViewRequested) return;
    let active = true;
    api
      .media()
      .then((result) => {
        if (!active) return;
        setInventory(result.data.map(presentLiveAsset));
        setLoadError("");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setInventory([]);
        setLoadError(
          error instanceof Error
            ? error.message
            : "Live media inventory could not be loaded",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [liveViewRequested]);
  const filtered = useMemo(
    () =>
      inventory.filter(
        (asset) =>
          asset.name.toLowerCase().includes(query.toLowerCase()) &&
          (type === "All types" || asset.type === type),
      ),
    [inventory, query, type],
  );
  return (
    <>
      <PageHeader
        eyebrow="Content"
        title="Media vault"
        description="Review control-plane media records. This Console does not verify ingestion provenance."
      />
      <div className="vault-boundary" role="status">
        <LockKeyhole size={18} />
        <span>
          <b>
            {!liveViewRequested
              ? "Pre-provisioned sample inventory · read only"
              : loadError
                ? "Live inventory unavailable"
                : loading
                  ? "Loading live inventory"
                  : "Live inventory · read only"}
          </b>
          {liveViewRequested
            ? " These records do not prove that an ingestion, scanning, or approval pipeline ran. Upload and web-content creation are unavailable in this Console."
            : " Connect to the live API to inspect your organization’s inventory; these samples are not live records."}
        </span>
      </div>
      {loadError && (
        <div className="operational-error" role="alert">
          <TriangleAlert size={18} />
          <span>
            <b>Live media unavailable.</b> {loadError}. No sample records have
            been substituted.
          </span>
        </div>
      )}
      <div className="toolbar">
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder="Search media"
        />
        <Select label="Asset type" value={type} onChange={setType}>
          <option>All types</option>
          <option>Image</option>
          <option>Video</option>
          <option>Web</option>
          <option>Template</option>
        </Select>
        <div className="segmented">
          <button
            className={view === "grid" ? "active" : ""}
            onClick={() => setView("grid")}
            aria-label="Grid view"
          >
            <Grid3X3 size={17} />
          </button>
          <button
            className={view === "list" ? "active" : ""}
            onClick={() => setView("list")}
            aria-label="List view"
          >
            <List size={17} />
          </button>
        </div>
      </div>
      {loading ? (
        <EmptyState
          icon={<ImageIcon />}
          title="Loading media inventory"
          message="Requesting current records from the live API."
        />
      ) : filtered.length ? (
        <div className={`asset-${view}`}>
          {filtered.map((asset) => (
            <article key={asset.id} className="asset-card">
              <div className={`asset-thumb ${asset.color}`}>
                <AssetIcon type={asset.type} />
                <span>{asset.ratio}</span>
                {asset.expires && <em>Expires {asset.expires}</em>}
              </div>
              <div className="asset-info">
                <span>
                  <b>{asset.name}</b>
                  <small>
                    {asset.type} · {asset.size}
                  </small>
                </span>
              </div>
              <div className="asset-meta">
                {asset.source === "live" ? "Created" : "Sample updated"}{" "}
                {asset.updated}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<FileQuestion />}
          title="No media found"
          message={
            loadError
              ? "The live API returned no usable inventory. Retry after connectivity is restored."
              : inventory.length
                ? "Try a broader search or remove a filter."
                : "No media has been provisioned for this organization."
          }
          action={
            inventory.length ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setQuery("");
                  setType("All types");
                }}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      )}
    </>
  );
}

function AssetIcon({ type }: { type: string }) {
  return type === "Image" ? (
    <ImageIcon />
  ) : type === "Video" ? (
    <Video />
  ) : type === "Web" ? (
    <Globe2 />
  ) : (
    <LayoutTemplate />
  );
}
