import { useEffect, useMemo, useState } from "react";
import { ListVideo, Sparkles } from "lucide-react";
import type { ManagementPlaylist } from "@screengoblin/contracts";
import { playlists, type Playlist } from "../data";
import { Drawer, EmptyState, PageHeader, SearchBox } from "../components";
import { api } from "../api";

export function Playlists() {
  const liveViewRequested = api.hasLiveSession() || !api.demoAllowed();
  return liveViewRequested ? <LivePlaylists /> : <DemoPlaylists />;
}

function LivePlaylists() {
  const [query, setQuery] = useState("");
  const [playlists, setPlaylists] = useState<ManagementPlaylist[]>([]);
  const [selected, setSelected] = useState<ManagementPlaylist | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "live" | "error">(
    "loading",
  );
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let active = true;
    void api
      .playlists()
      .then((records) => {
        if (!active) return;
        setPlaylists(records);
        setLoadState("live");
        setLoadError("");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setPlaylists([]);
        setLoadState("error");
        setLoadError(
          error instanceof Error
            ? error.message
            : "Live playlists could not be loaded",
        );
      });
    return () => {
      active = false;
    };
  }, []);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return playlists;
    return playlists.filter((playlist) =>
      `${playlist.name} ${playlist.description}`
        .toLowerCase()
        .includes(normalized),
    );
  }, [playlists, query]);

  return (
    <>
      {loadError && (
        <div className="operational-error" role="alert">
          Live playlist data is unavailable: {loadError}. No demo records were
          substituted.
        </div>
      )}
      <PageHeader
        eyebrow="Programming"
        title="Playlists"
        description="Review playlist definitions reported by the live API."
      />
      <p className="data-source-label">
        {loadState === "loading"
          ? "Loading live playlist data…"
          : loadState === "live"
            ? "Live API data"
            : "Live API data unavailable"}
      </p>
      {loadState === "loading" ? (
        <EmptyState
          icon={<ListVideo />}
          title="Loading playlists"
          message="Requesting current playlist records from the live API."
        />
      ) : loadState === "error" ? (
        <EmptyState
          icon={<ListVideo />}
          title="Playlist data unavailable"
          message="No current playlist records are available. Reconnect after live API access is restored."
        />
      ) : (
        <>
          <div className="toolbar">
            <SearchBox
              value={query}
              onChange={setQuery}
              placeholder="Search playlists"
            />
          </div>
          {filtered.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Playlist</th>
                    <th>Description</th>
                    <th>Items</th>
                    <th>Declared runtime</th>
                    <th>Updated</th>
                    <th>
                      <span className="sr-only">Details</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((playlist) => (
                    <tr key={playlist.id}>
                      <td>
                        <b>{playlist.name}</b>
                      </td>
                      <td className="table-secondary">
                        {playlist.description || "No description"}
                      </td>
                      <td>{playlist.items.length}</td>
                      <td>{playlistRuntime(playlist)}</td>
                      <td className="table-secondary">
                        {formatTimestamp(playlist.updatedAt)}
                      </td>
                      <td>
                        <button
                          className="icon-button"
                          aria-label={`View ${playlist.name}`}
                          onClick={() => setSelected(playlist)}
                        >
                          <ListVideo size={18} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              icon={<ListVideo />}
              title={playlists.length ? "No playlists match" : "No playlists"}
              message={
                playlists.length
                  ? "No playlists match your current search."
                  : "The live API returned an empty playlist collection."
              }
            />
          )}
        </>
      )}
      <Drawer
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.name ?? "Playlist"}
        eyebrow="Live playlist details"
      >
        {selected && (
          <>
            <div className="drawer-stat-row">
              <span>
                <b>{selected.items.length}</b>
                <small>items</small>
              </span>
              <span>
                <b>{playlistRuntime(selected)}</b>
                <small>declared runtime</small>
              </span>
            </div>
            <div className="drawer-section">
              <h3>Declared content order</h3>
              {selected.items.length ? (
                <div className="sortable-list">
                  {selected.items.map((item) => (
                    <div key={item.id}>
                      <span>
                        <b>Asset ID: {item.assetId}</b>
                        <small>
                          Position {item.position} · {item.durationSeconds}s
                        </small>
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p>No playlist items are defined.</p>
              )}
            </div>
          </>
        )}
      </Drawer>
    </>
  );
}

function DemoPlaylists() {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Playlist | null>(null);
  const filtered = useMemo(
    () =>
      playlists.filter((playlist) =>
        playlist.name.toLowerCase().includes(query.toLowerCase()),
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
      <p className="data-source-label">Clearly labeled demonstration data</p>
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
        eyebrow="Demonstration playlist details"
      >
        {selected && (
          <div className="drawer-section">
            <h3>Demonstration content order</h3>
            <div className="sortable-list">
              {selected.items.map((item, index) => (
                <div key={item}>
                  <span className={`mini-art ${selected.color}`}>
                    <Sparkles size={15} />
                  </span>
                  <span>
                    <b>{item}</b>
                    <small>{index === 2 ? "0:30" : "0:15"}</small>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Drawer>
    </>
  );
}

function playlistRuntime(playlist: ManagementPlaylist) {
  const seconds = playlist.items.reduce(
    (total, item) => total + item.durationSeconds,
    0,
  );
  return `${seconds}s`;
}

function formatTimestamp(value: string) {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}
