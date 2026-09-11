import { useState } from "react";
import {
  AlertOctagon,
  CheckCircle2,
  LockKeyhole,
  ShieldCheck,
  Siren,
} from "lucide-react";
import { Button, Field, PageHeader, Panel } from "../components";

export function Emergency() {
  const [type, setType] = useState("Shelter in place");
  const [scope, setScope] = useState("High School · All screens (30)");
  const [ack, setAck] = useState(false);
  return (
    <>
      <PageHeader
        eyebrow="Pilot simulation · disabled"
        title="Emergency center"
        description="Preview supplemental signage messages without contacting the screen fleet."
      />
      <div className="emergency-notice">
        <LockKeyhole />
        <div>
          <b>Simulation only — not a life-safety system</b>
          <span>
            Emergency activation is disabled during the pilot. ScreenGoblin
            cannot replace fire alarms, PA systems, mass notification, or
            established emergency procedures.
          </span>
        </div>
      </div>
      <div className="emergency-grid">
        <Panel className="emergency-form">
          <div className="panel-heading">
            <div>
              <h2>Prepare simulation</h2>
              <p>No message is active</p>
            </div>
            <span className="secure-badge">
              <ShieldCheck /> Audit preview
            </span>
          </div>
          <Field label="Message type">
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option>Shelter in place</option>
              <option>Evacuate building</option>
              <option>Weather closure</option>
              <option>All clear</option>
            </select>
          </Field>
          <Field label="Scope">
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option>High School · All screens (30)</option>
              <option>District · All screens (42)</option>
              <option>Administration · All screens (6)</option>
            </select>
          </Field>
          <div className="form-row">
            <Field label="Duration">
              <select>
                <option>15 minutes</option>
                <option>30 minutes</option>
                <option>1 hour</option>
              </select>
            </Field>
            <Field label="Approval">
              <input value="Disabled in pilot" readOnly />
            </Field>
          </div>
          <label className="confirm-check">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            <span>
              <b>I understand this is a simulation</b>
              <small>
                No command will be sent to the{" "}
                {scope.match(/\((.*?)\)/)?.[1] ?? "selected screens"}.
              </small>
            </span>
          </label>
          <Button variant="danger" disabled icon={<Siren size={18} />}>
            Activation disabled during pilot
          </Button>
        </Panel>
        <Panel className="preview-panel">
          <div className="panel-heading">
            <div>
              <h2>Exact screen preview</h2>
              <p>Landscape · 16:9</p>
            </div>
          </div>
          <div className="emergency-preview">
            <AlertOctagon />
            <b>{type.toUpperCase()}</b>
            <span>Remain calm. Follow staff instructions.</span>
            <small>AUTHORIZED DISTRICT MESSAGE</small>
          </div>
          <ul className="validation-list">
            <li>
              <CheckCircle2 /> Locked template
            </li>
            <li>
              <CheckCircle2 /> High-contrast text
            </li>
            <li>
              <CheckCircle2 /> Normal programming will be preserved
            </li>
          </ul>
        </Panel>
      </div>
    </>
  );
}
