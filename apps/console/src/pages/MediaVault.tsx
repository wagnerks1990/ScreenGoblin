import { useMemo, useState } from "react";
import {
  Grid3X3,
  List,
  Upload,
  Image as ImageIcon,
  Video,
  Globe2,
  LayoutTemplate,
  MoreHorizontal,
  FileQuestion,
} from "lucide-react";
import { assets } from "../data";
import {
  Button,
  EmptyState,
  Modal,
  PageHeader,
  SearchBox,
  Select,
  Field,
} from "../components";

export function MediaVault() {
  const [query, setQuery] = useState("");
  const [type, setType] = useState("All types");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [upload, setUpload] = useState(false);
  const filtered = useMemo(
    () =>
      assets.filter(
        (asset) =>
          asset.name.toLowerCase().includes(query.toLowerCase()) &&
          (type === "All types" || asset.type === type),
      ),
    [query, type],
  );
  return (
    <>
      <PageHeader
        eyebrow="Content"
        title="Media vault"
        description="Upload, organize, and review every asset in one place."
        actions={
          <Button icon={<Upload size={18} />} onClick={() => setUpload(true)}>
            Upload media
          </Button>
        }
      />
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
      {filtered.length ? (
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
                <button
                  className="icon-button"
                  aria-label={`More options for ${asset.name}`}
                >
                  <MoreHorizontal size={18} />
                </button>
              </div>
              <div className="asset-meta">Updated {asset.updated}</div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<FileQuestion />}
          title="No media found"
          message="Try a broader search or remove a filter."
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setQuery("");
                setType("All types");
              }}
            >
              Clear filters
            </Button>
          }
        />
      )}
      <Modal
        open={upload}
        onClose={() => setUpload(false)}
        title="Upload media"
        footer={
          <>
            <Button variant="secondary" onClick={() => setUpload(false)}>
              Cancel
            </Button>
            <Button onClick={() => setUpload(false)}>Add to vault</Button>
          </>
        }
      >
        <div className="dropzone">
          <Upload />
          <b>Drop files here, or choose files</b>
          <span>Images and videos up to 500 MB</span>
          <Button variant="secondary">Choose files</Button>
        </div>
        <div className="form-row">
          <Field label="Folder">
            <select>
              <option>All media</option>
              <option>Announcements</option>
              <option>Events</option>
            </select>
          </Field>
          <Field label="Expires">
            <input type="date" />
          </Field>
        </div>
      </Modal>
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
