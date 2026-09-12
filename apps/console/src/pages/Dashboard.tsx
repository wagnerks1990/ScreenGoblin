import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Clock,
  MonitorCheck,
  MonitorX,
  TriangleAlert,
  Play,
  Plus,
  RefreshCw,
  CalendarClock,
  Activity,
} from "lucide-react";
import type { FleetSummary, ManagementScreen } from "@screengoblin/contracts";
import type { DemoScreen } from "../data";
import { api } from "../api";
import { activity } from "../data";
import { Button, PageHeader, Panel, Preview, Status } from "../components";
import { Link } from "react-router-dom";

export function Dashboard() {
  const [screens, setScreens] = useState<Array<ManagementScreen | DemoScreen>>(
    [],
  );
  const [loadState, setLoadState] = useState<
    "loading" | "live" | "demo" | "error"
  >("loading");
  const [loadError, setLoadError] = useState("");
  const initialLoadStarted = useRef(false);
  const loadDashboard = useCallback(async () => {
    setLoadState("loading");
    setLoadError("");
    try {
      const result = await api.screens();
      setScreens(result.data);
      setLoadState(result.source);
    } catch (error: unknown) {
      setScreens([]);
      setLoadState("error");
      setLoadError(
        error instanceof Error
          ? error.message
          : "Live fleet data could not be loaded",
      );
    }
  }, []);

  useEffect(() => {
    if (initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    void loadDashboard();
  }, [loadDashboard]);

  const hasCurrentData = loadState === "live" || loadState === "demo";
  const fleet = summarizeFleet(screens);
  const fleetOnlinePercent = fleet.total
    ? Math.round((fleet.online / fleet.total) * 100)
    : 0;
  const alerts = screens.filter((screen) => screen.status !== "online");
  const attentionDetail = summarizeAttention(fleet, hasCurrentData);
  const sourceLabel =
    loadState === "loading"
      ? "Loading screen data…"
      : loadState === "live"
        ? "Live API data"
        : loadState === "demo"
          ? "Clearly labeled demonstration data"
          : "Live API data unavailable";
  return (
    <>
      {loadState === "error" && (
        <div className="operational-error" role="alert">
          <TriangleAlert size={18} />
          <span>
            <b>Live data unavailable.</b> {loadError}. Fleet counts are unknown
            until a successful retry.
          </span>
          <button className="text-button" onClick={() => void loadDashboard()}>
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      )}
      <PageHeader
        eyebrow={new Intl.DateTimeFormat(undefined, {
          dateStyle: "full",
        }).format(new Date())}
        title="Screen operations overview"
        description="Here’s what’s happening across your screens."
        actions={
          <Button disabled icon={<Plus size={18} />}>
            Create announcement unavailable
          </Button>
        }
      />
      <p className="data-source-label" aria-live="polite">
        {sourceLabel}
        {hasCurrentData && screens.length === 0
          ? " · No screens are registered."
          : ""}
      </p>
      <div className="metrics-grid">
        <Metric
          icon={<MonitorCheck />}
          value={hasCurrentData ? fleet.online : "—"}
          label="Screens online"
          detail={
            !hasCurrentData
              ? "Current fleet data unavailable"
              : fleet.total
                ? `${Math.round((fleet.online / fleet.total) * 100)}% of fleet`
                : "No screens are registered"
          }
          tone="green"
        />
        <Metric
          icon={<Play />}
          value={loadState === "demo" ? "8" : "—"}
          label="Active playlists"
          detail={
            loadState === "demo"
              ? "Demonstration data"
              : "Not available from API"
          }
          tone="blue"
        />
        <Metric
          icon={<CalendarClock />}
          value={loadState === "demo" ? "3" : "—"}
          label="Scheduled today"
          detail={
            loadState === "demo"
              ? "Demonstration data"
              : "Not available from API"
          }
          tone="violet"
        />
        <Metric
          icon={<MonitorX />}
          value={
            hasCurrentData
              ? fleet.warning + fleet.offline + fleet.fallback
              : "—"
          }
          label="Needs attention"
          detail={attentionDetail}
          tone="red"
        />
      </div>
      <div className="dashboard-grid">
        <Panel className="span-two">
          <div className="panel-heading">
            <div>
              <h2>Needs attention</h2>
              <p>Issues affecting playback or fleet health</p>
            </div>
            <Link to="/screens">
              View fleet <ArrowRight size={15} />
            </Link>
          </div>
          <div className="attention-list">
            {alerts.map((screen) => (
              <Link to="/screens" key={screen.id} className="attention-row">
                <span className={`attention-icon ${screen.status}`}>
                  {screen.status === "offline" ? (
                    <MonitorX />
                  ) : (
                    <TriangleAlert />
                  )}
                </span>
                <span className="attention-copy">
                  <b>{screen.name}</b>
                  <small>
                    {screen.status === "offline"
                      ? heartbeatDescription(screen.lastSeenAt)
                      : screen.status === "fallback"
                        ? "Player reports fallback playback"
                        : `Heartbeat delayed · ${heartbeatDescription(screen.lastSeenAt)}`}
                  </small>
                </span>
                <Status value={screen.status} />
                <ArrowRight size={16} />
              </Link>
            ))}
            {hasCurrentData && alerts.length === 0 && (
              <p className="data-source-label">No reported screen issues.</p>
            )}
            {!hasCurrentData && (
              <p className="data-source-label">
                Attention status is unavailable until screen data loads.
              </p>
            )}
          </div>
        </Panel>
        <Panel>
          <div className="panel-heading">
            <div>
              <h2>Fleet pulse</h2>
              <p>
                {loadState === "live"
                  ? "Live API connection"
                  : loadState === "demo"
                    ? "Demonstration snapshot"
                    : "Current status unavailable"}
              </p>
            </div>
            <Activity size={19} className="muted" />
          </div>
          <div className="donut-row">
            <div className="donut">
              <svg viewBox="0 0 36 36" aria-hidden="true">
                <circle className="donut-track" cx="18" cy="18" r="15.915" />
                <circle
                  className="donut-value"
                  cx="18"
                  cy="18"
                  r="15.915"
                  strokeDasharray={`${fleetOnlinePercent} 100`}
                  transform="rotate(-90 18 18)"
                />
              </svg>
              <span>
                <b>{hasCurrentData ? fleet.online : "—"}</b>
                <small>of {hasCurrentData ? fleet.total : "—"}</small>
              </span>
            </div>
            <div className="legend">
              <span>
                <i className="green" />
                Online <b>{hasCurrentData ? fleet.online : "—"}</b>
              </span>
              <span>
                <i className="amber" />
                Warning <b>{hasCurrentData ? fleet.warning : "—"}</b>
              </span>
              <span>
                <i className="red" />
                Offline <b>{hasCurrentData ? fleet.offline : "—"}</b>
              </span>
              <span>
                <i className="slate" />
                Fallback <b>{hasCurrentData ? fleet.fallback : "—"}</b>
              </span>
            </div>
          </div>
        </Panel>
        <Panel className="span-two">
          <div className="panel-heading">
            <div>
              <h2>Playing now</h2>
              <p>
                {loadState === "demo"
                  ? "Illustrative demonstration previews"
                  : "Current screen screenshots are unavailable in this pilot"}
              </p>
            </div>
            <button
              className="text-button"
              onClick={() => void loadDashboard()}
              disabled={loadState === "loading"}
            >
              <RefreshCw size={14} /> Refresh screen data
            </button>
          </div>
          <div className="now-grid">
            {screens
              .slice(0, loadState === "demo" ? 3 : 0)
              .map((screen, index) => (
                <article key={screen.id} className="now-card">
                  <Preview
                    title={
                      index === 0
                        ? "GOOD MORNING"
                        : index === 1
                          ? "CLUB FAIR"
                          : "TODAY'S MENU"
                    }
                    subtitle={
                      index === 0
                        ? "Here’s what’s happening today"
                        : index === 1
                          ? "Find your people · Sept 18"
                          : "Fresh choices, every day"
                    }
                    tone={
                      index === 0 ? "green" : index === 1 ? "violet" : "amber"
                    }
                  />
                  <div>
                    <span>
                      <b>{screen.name}</b>
                      <small>{screen.location}</small>
                    </span>
                    <Status value={screen.status} />
                  </div>
                </article>
              ))}
          </div>
        </Panel>
        <Panel>
          <div className="panel-heading">
            <div>
              <h2>Recent activity</h2>
              <p>Across your workspace</p>
            </div>
          </div>
          <ol className="activity-list">
            {(loadState === "demo" ? activity : []).map((item) => (
              <li key={item.title}>
                <span className="activity-dot" />
                <div>
                  <b>{item.title}</b>
                  <small>{item.meta}</small>
                </div>
                <time>
                  <Clock size={13} />
                  {item.time}
                </time>
              </li>
            ))}
            {loadState !== "demo" && (
              <li>Live activity reporting is unavailable in this pilot.</li>
            )}
          </ol>
        </Panel>
      </div>
    </>
  );
}

function summarizeFleet(
  screens: Array<ManagementScreen | DemoScreen>,
): FleetSummary {
  return screens.reduce<FleetSummary>(
    (summary, screen) => {
      summary.total += 1;
      summary[screen.status] += 1;
      return summary;
    },
    { total: 0, online: 0, warning: 0, offline: 0, fallback: 0 },
  );
}

function summarizeAttention(fleet: FleetSummary, hasCurrentData: boolean) {
  if (!hasCurrentData) return "Current fleet data unavailable";
  const parts = (["warning", "offline", "fallback"] as const)
    .filter((status) => fleet[status] > 0)
    .map((status) => `${fleet[status]} ${status}`);
  return parts.length ? parts.join(" · ") : "No reported screen issues";
}

function heartbeatDescription(lastSeenAt?: string) {
  if (!lastSeenAt) return "Player has not reported a heartbeat";
  const timestamp = new Date(lastSeenAt);
  if (Number.isNaN(timestamp.getTime())) return `Last heartbeat ${lastSeenAt}`;
  return `Last heartbeat ${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp)}`;
}

function Metric({
  icon,
  value,
  label,
  detail,
  tone,
}: {
  icon: React.ReactNode;
  value: string | number;
  label: string;
  detail: string;
  tone: string;
}) {
  return (
    <Panel className="metric">
      <span className={`metric-icon ${tone}`}>{icon}</span>
      <div>
        <b>{value}</b>
        <span>{label}</span>
        <small>{detail}</small>
      </div>
    </Panel>
  );
}
