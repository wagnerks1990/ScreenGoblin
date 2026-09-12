import { useMemo, useState } from "react";
import { ListVideo, Sparkles } from "lucide-react";
import { playlists } from "../data";
import { Drawer, EmptyState, PageHeader, SearchBox } from "../components";
import type { Playlist } from "../data";
import { api } from "../api";

export function Playlists() {
  const liveViewRequested = api.hasLiveSession() || !api.demoAllowed();
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
        description="Review reusable content rotations for your screens."
      />
      {liveViewRequested ? (
        <>
          <div className="containment-notice" role="status">
            <ListVideo aria-hidden="true" />
            <span>
              <b>Live playlist view is not connected</b>
              Authenticated playlist records are not displayed in this Console
              yet. No demonstration records have been substituted.
            </span>
          </div>
          <EmptyState
            icon={<ListVideo />}
            title="Live playlists unavailable"
            message="Use the control-plane API for playlist operations until this view is connected."
          />
        </>
      ) : (
        <>
          <p className="data-source-label">
            Clearly labeled demonstration data
          </p>
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
                        <span className={`mini-art ${selected.color}`}>
                          <Sparkles size={15} />
                        </span>
                        <span>
                          <b>{item}</b>
                          <small>{i === 2 ? "0:30" : "0:15"}</small>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </Drawer>
        </>
      )}
    </>
  );
}
