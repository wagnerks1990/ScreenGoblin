import { useEffect, useState } from "react";
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
import type { FleetSummary, ScreenSummary } from "@screengoblin/contracts";
import { api } from "../api";
import { activity, demoFleet, screens as fallbackScreens } from "../data";
import { Button, PageHeader, Panel, Preview, Status } from "../components";
import { Link } from "react-router-dom";

export function Dashboard({ onCreate }: { onCreate: () => void }) {
  const [fleet, setFleet] = useState<FleetSummary>(demoFleet);
  const [screens, setScreens] = useState<ScreenSummary[]>(fallbackScreens);
  const [source, setSource] = useState<"live" | "demo">("demo");
  useEffect(() => {
    void Promise.all([api.fleet(), api.screens()]).then(
      ([fleetResult, screensResult]) => {
        setFleet(fleetResult.data);
        setScreens(screensResult.data);
        setSource(
          fleetResult.source === "live" && screensResult.source === "live"
            ? "live"
            : "demo",
        );
      },
    );
  }, []);
  const alerts = screens.filter((screen) => screen.status !== "online");
  return (
    <>
      <PageHeader
        eyebrow="Friday, September 11"
        title="Good evening, Kyle."
        description="Here’s what’s happening across your screens."
        actions={
          <Button onClick={onCreate} icon={<Plus size={18} />}>
            Create announcement
          </Button>
        }
      />
      <div className="metrics-grid">
        <Metric
          icon={<MonitorCheck />}
          value={fleet.online}
          label="Screens online"
          detail={`${Math.round((fleet.online / fleet.total) * 100)}% of fleet`}
          tone="green"
        />
        <Metric
          icon={<Play />}
          value="8"
          label="Active playlists"
          detail="Across 42 screens"
          tone="blue"
        />
        <Metric
          icon={<CalendarClock />}
          value="3"
          label="Scheduled today"
          detail="Next change at 3:00 PM"
          tone="violet"
        />
        <Metric
          icon={<MonitorX />}
          value={fleet.offline + fleet.fallback}
          label="Needs attention"
          detail="1 offline · 1 fallback"
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
                      ? `Offline since ${screen.lastSeenAt}`
                      : screen.status === "fallback"
                        ? "Playing fallback content"
                        : "Storage is 91% full"}
                  </small>
                </span>
                <Status value={screen.status} />
                <ArrowRight size={16} />
              </Link>
            ))}
          </div>
        </Panel>
        <Panel>
          <div className="panel-heading">
            <div>
              <h2>Fleet pulse</h2>
              <p>
                {source === "live"
                  ? "Live API connection"
                  : "Prototype snapshot"}
              </p>
            </div>
            <Activity size={19} className="muted" />
          </div>
          <div className="donut-row">
            <div
              className="donut"
              style={
                {
                  "--percent": `${Math.round((fleet.online / fleet.total) * 100) * 3.6}deg`,
                } as React.CSSProperties
              }
            >
              <span>
                <b>{fleet.online}</b>
                <small>of {fleet.total}</small>
              </span>
            </div>
            <div className="legend">
              <span>
                <i className="green" />
                Online <b>{fleet.online}</b>
              </span>
              <span>
                <i className="amber" />
                Warning <b>{fleet.warning}</b>
              </span>
              <span>
                <i className="red" />
                Offline <b>{fleet.offline}</b>
              </span>
              <span>
                <i className="slate" />
                Fallback <b>{fleet.fallback}</b>
              </span>
            </div>
          </div>
        </Panel>
        <Panel className="span-two">
          <div className="panel-heading">
            <div>
              <h2>Playing now</h2>
              <p>Latest confirmed screenshots</p>
            </div>
            <button className="text-button">
              <RefreshCw size={14} /> Refresh
            </button>
          </div>
          <div className="now-grid">
            {screens.slice(0, 3).map((screen, index) => (
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
            {activity.map((item) => (
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
          </ol>
        </Panel>
      </div>
    </>
  );
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
