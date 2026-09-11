import { useState } from "react";
import {
  Building2,
  BellRing,
  KeyRound,
  Palette,
  RadioTower,
  Save,
  Shield,
  Users,
} from "lucide-react";
import { Button, Field, PageHeader, Panel } from "../components";

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
  const [saved, setSaved] = useState(false);
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Settings"
        description="Manage workspace defaults, access, and integrations."
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
              <p>
                {tab === "Workspace"
                  ? "Default behavior for your ScreenGoblin workspace."
                  : `Configure ${tab.toLowerCase()} for your organization.`}
              </p>
            </div>
          </div>
          {tab === "Workspace" ? (
            <>
              <div className="form-row">
                <Field label="Workspace name">
                  <input defaultValue="CASD Technology Lab" />
                </Field>
                <Field label="Timezone">
                  <select defaultValue="America/New_York">
                    <option>America/New_York</option>
                    <option>America/Chicago</option>
                    <option>America/Denver</option>
                    <option>America/Los_Angeles</option>
                  </select>
                </Field>
              </div>
              <Field
                label="Default content duration"
                hint="Used when an uploaded asset has no duration."
              >
                <div className="input-suffix">
                  <input type="number" defaultValue="15" />
                  <span>seconds</span>
                </div>
              </Field>
              <Field label="Offline behavior">
                <select defaultValue="last">
                  <option value="last">
                    Keep playing last known good schedule
                  </option>
                  <option value="fallback">
                    Switch to workspace fallback playlist
                  </option>
                </select>
              </Field>
              <div className="setting-toggle">
                <div>
                  <b>Require content approval</b>
                  <span>Contributors submit drafts before publishing.</span>
                </div>
                <input
                  type="checkbox"
                  defaultChecked
                  aria-label="Require content approval"
                />
              </div>
              <div className="setting-toggle">
                <div>
                  <b>Collect proof of playback</b>
                  <span>Players report confirmed playback events.</span>
                </div>
                <input
                  type="checkbox"
                  defaultChecked
                  aria-label="Collect proof of playback"
                />
              </div>
            </>
          ) : (
            <div className="placeholder-settings">
              <RadioTower />
              <h3>{tab} configuration</h3>
              <p>
                This prototype reserves a focused workspace for{" "}
                {tab.toLowerCase()} controls.
              </p>
            </div>
          )}
          <div className="settings-save">
            <span>
              {saved
                ? "Changes saved locally."
                : "Prototype settings are stored for this session."}
            </span>
            <Button icon={<Save size={17} />} onClick={() => setSaved(true)}>
              Save changes
            </Button>
          </div>
        </Panel>
      </div>
    </>
  );
}
