import { useState } from "react";
import {
  Building2,
  BellRing,
  KeyRound,
  LockKeyhole,
  Palette,
  Shield,
  Users,
} from "lucide-react";
import { PageHeader, Panel } from "../components";

const tabs = [
  ["Workspace", Building2],
  ["Users & roles", Users],
  ["Appearance", Palette],
  ["Notifications", BellRing],
  ["Security", Shield],
  ["API & webhooks", KeyRound],
] as const;

export function SettingsPage() {
  const [tab, setTab] = useState("Workspace");
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Settings"
        description="Review settings areas reserved for a future managed configuration workflow."
      />
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {tabs.map(([label, Icon]) => (
            <button
              key={label}
              className={tab === label ? "active" : ""}
              onClick={() => setTab(label)}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </nav>
        <Panel className="settings-panel">
          <div className="panel-heading">
            <div>
              <h2>{tab}</h2>
              <p>Read-only prototype status</p>
            </div>
          </div>
          <div className="placeholder-settings" role="status">
            <LockKeyhole aria-hidden="true" />
            <h3>{tab} settings are unavailable</h3>
            <p>
              No {tab.toLowerCase()} settings can be changed or saved from this
              prototype.
            </p>
            {tab === "Workspace" && (
              <>
                <p>
                  <b>Content approval is not configured or enforced here.</b>
                </p>
                <p>
                  <b>
                    Proof-of-play collection is not configured or independently
                    verified.
                  </b>
                </p>
              </>
            )}
          </div>
        </Panel>
      </div>
    </>
  );
}
