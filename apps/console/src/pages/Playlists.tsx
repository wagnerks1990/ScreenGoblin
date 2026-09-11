import { useMemo, useState } from "react";
import {
  GripVertical,
  ListVideo,
  MoreHorizontal,
  Plus,
  Sparkles,
} from "lucide-react";
import { playlists } from "../data";
import {
  Button,
  Drawer,
  EmptyState,
  PageHeader,
  SearchBox,
} from "../components";
import type { Playlist } from "../data";

export function Playlists() {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Playlist | null>(null);
  const filtered = useMemo(
    () =>
      playlists.filter((p) =>
        p.name.toLowerCase().includes(query.toLowerCase()),
      ),
    [query],
  );
  return (
    <>
      <PageHeader
        eyebrow="Programming"
        title="Playlists"
        description="Arrange content into reusable rotations for your screens."
        actions={<Button icon={<Plus size={18} />}>New playlist</Button>}
      />
      <div className="toolbar">
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder="Search playlists"
        />
      </div>
      {filtered.length ? (
        <div className="playlist-grid">
          {filtered.map((playlist) => (
            <button
              key={playlist.id}
              className="playlist-card"
              onClick={() => setSelected(playlist)}
            >
              <div className={`playlist-art ${playlist.color}`}>
                <div>
                  <span />
                  <span />
                  <span />
                </div>
                <em>{playlist.itemCount} items</em>
              </div>
              <div className="playlist-info">
                <span>
                  <b>{playlist.name}</b>
                  <small>{playlist.duration} total runtime</small>
                </span>
                <MoreHorizontal size={18} />
              </div>
              <div className="playlist-foot">
                <span>Assigned to {playlist.assigned} screens</span>
                <small>Updated {playlist.updated}</small>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<ListVideo />}
          title="No playlists found"
          message="Try another search term."
        />
      )}
      <Drawer
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.name ?? "Playlist"}
        eyebrow="Playlist details"
      >
        {selected && (
          <>
            <div className="drawer-stat-row">
              <span>
                <b>{selected.itemCount}</b>
                <small>items</small>
              </span>
              <span>
                <b>{selected.duration}</b>
                <small>runtime</small>
              </span>
              <span>
                <b>{selected.assigned}</b>
                <small>screens</small>
              </span>
            </div>
            <div className="drawer-section">
              <h3>Content order</h3>
              <div className="sortable-list">
                {selected.items.map((item, i) => (
                  <div key={item}>
                    <GripVertical size={16} />
                    <span className={`mini-art ${selected.color}`}>
                      <Sparkles size={15} />
                    </span>
                    <span>
                      <b>{item}</b>
                      <small>{i === 2 ? "0:30" : "0:15"}</small>
                    </span>
                    <MoreHorizontal size={17} />
                  </div>
                ))}
              </div>
            </div>
            <div className="drawer-actions">
              <Button variant="secondary">Preview</Button>
              <Button>Edit playlist</Button>
            </div>
          </>
        )}
      </Drawer>
    </>
  );
}
