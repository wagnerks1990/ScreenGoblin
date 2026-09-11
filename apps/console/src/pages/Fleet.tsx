import { useMemo, useState } from "react";
import {
  MonitorCog,
  MoreHorizontal,
  MonitorOff,
  RotateCw,
  Camera,
  Power,
  Trash2,
  Wifi,
  HardDrive,
  Thermometer,
  Clock3,
  Tag,
} from "lucide-react";
import type { ScreenSummary } from "@screengoblin/contracts";
import { screens } from "../data";
import {
  Button,
  Drawer,
  EmptyState,
  Modal,
  PageHeader,
  Preview,
  SearchBox,
  Select,
  Status,
} from "../components";
import { api } from "../api";

export function Fleet() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("All statuses");
  const [selected, setSelected] = useState<ScreenSummary | null>(null);
  const [pairOpen, setPairOpen] = useState(false);
  const [pairing, setPairing] = useState<{
    code: string;
    expiresAt: string;
  }>();
  const [pairError, setPairError] = useState("");
  const filtered = useMemo(
    () =>
      screens.filter(
        (s) =>
          (s.name + s.location).toLowerCase().includes(query.toLowerCase()) &&
          (status === "All statuses" || s.status === status.toLowerCase()),
      ),
    [query, status],
  );
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Screen fleet"
        description="Monitor, troubleshoot, and manage every player."
        actions={
          <Button
            icon={<MonitorCog size={18} />}
            onClick={async () => {
              setPairOpen(true);
              setPairing(undefined);
              setPairError("");
              if (!api.hasLiveSession()) {
                setPairError(
                  "Connect the console to the live API before pairing a screen.",
                );
                return;
              }
              try {
                setPairing(await api.createPairingCode());
              } catch (error) {
                setPairError(
                  error instanceof Error
                    ? error.message
                    : "A pairing code could not be created.",
                );
              }
            }}
          >
            Pair a screen
          </Button>
        }
      />
      <div className="toolbar">
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder="Search screens or locations"
        />
        <Select label="Status" value={status} onChange={setStatus}>
          <option>All statuses</option>
          <option>Online</option>
          <option>Warning</option>
          <option>Offline</option>
          <option>Fallback</option>
        </Select>
      </div>
      {filtered.length ? (
        <div className="table-wrap fleet-table">
          <table>
            <thead>
              <tr>
                <th>Screen</th>
                <th>Location</th>
                <th>Status</th>
                <th>Now playing</th>
                <th>Last seen</th>
                <th>Player</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id} onClick={() => setSelected(s)}>
                  <td>
                    <span className="screen-name">
                      <span className={`screen-device ${s.status}`}>
                        <span />
                      </span>
                      <b>{s.name}</b>
                    </span>
                  </td>
                  <td className="table-secondary">{s.location}</td>
                  <td>
                    <Status value={s.status} />
                  </td>
                  <td>{s.nowPlaying}</td>
                  <td className="table-secondary">{s.lastSeenAt}</td>
                  <td className="table-secondary">v{s.playerVersion}</td>
                  <td>
                    <button
                      className="icon-button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelected(s);
                      }}
                      aria-label={`View ${s.name}`}
                    >
                      <MoreHorizontal size={18} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          icon={<MonitorOff />}
          title="No screens found"
          message="No screens match your current search and status filter."
        />
      )}
      <Drawer
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.name ?? "Screen"}
        eyebrow={selected?.location ?? "Screen details"}
      >
        {selected && (
          <>
            <Preview
              title={
                selected.status === "offline"
                  ? "LAST KNOWN GOOD"
                  : selected.name.toUpperCase()
              }
              subtitle={selected.nowPlaying ?? "No active content"}
              tone={selected.status === "offline" ? "slate" : "green"}
            />
            <div className="drawer-status">
              <Status value={selected.status} />
              <span>Last heartbeat {selected.lastSeenAt}</span>
            </div>
            <div className="command-grid">
              <button>
                <Camera />
                <span>Screenshot</span>
              </button>
              <button>
                <RotateCw />
                <span>Refresh</span>
              </button>
              <button>
                <Power />
                <span>Restart</span>
              </button>
              <button>
                <Trash2 />
                <span>Clear cache</span>
              </button>
            </div>
            <div className="drawer-section">
              <h3>Device health</h3>
              <dl className="health-list">
                <div>
                  <dt>
                    <Wifi />
                    Network
                  </dt>
                  <dd>Ethernet · 94 Mbps</dd>
                </div>
                <div>
                  <dt>
                    <HardDrive />
                    Storage
                  </dt>
                  <dd>18.2 GB free</dd>
                </div>
                <div>
                  <dt>
                    <Thermometer />
                    Temperature
                  </dt>
                  <dd>48°C</dd>
                </div>
                <div>
                  <dt>
                    <Clock3 />
                    Uptime
                  </dt>
                  <dd>12 days, 4 hours</dd>
                </div>
              </dl>
            </div>
            <div className="drawer-section">
              <h3>Configuration</h3>
              <dl className="detail-list">
                <div>
                  <dt>Resolution</dt>
                  <dd>{selected.resolution}</dd>
                </div>
                <div>
                  <dt>Orientation</dt>
                  <dd>{selected.orientation}</dd>
                </div>
                <div>
                  <dt>Player version</dt>
                  <dd>{selected.playerVersion}</dd>
                </div>
              </dl>
              <div className="tag-row">
                <Tag size={15} />
                {selected.tags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
            </div>
          </>
        )}
      </Drawer>
      <Modal
        open={pairOpen}
        onClose={() => setPairOpen(false)}
        title="Pair a screen"
        footer={
          <Button variant="secondary" onClick={() => setPairOpen(false)}>
            Close
          </Button>
        }
      >
        {pairing ? (
          <div className="pairing-result" aria-live="polite">
            <p>Enter this single-use code on the ScreenGoblin Player:</p>
            <strong>{pairing.code}</strong>
            <small>
              Expires {new Date(pairing.expiresAt).toLocaleTimeString()}
            </small>
          </div>
        ) : pairError ? (
          <p className="error-message">{pairError}</p>
        ) : (
          <p>Creating a secure pairing code…</p>
        )}
      </Modal>
    </>
  );
}
