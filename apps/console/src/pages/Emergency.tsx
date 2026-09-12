import { LockKeyhole, Siren } from "lucide-react";
import { Button, PageHeader, Panel } from "../components";

export function Emergency() {
  return (
    <>
      <PageHeader
        eyebrow="Pilot simulation · disabled"
        title="Emergency center"
        description="Emergency publishing is unavailable in this pre-production prototype."
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
      <div className="emergency-grid emergency-contained">
        <Panel className="emergency-form">
          <div className="panel-heading">
            <div>
              <h2>No emergency controls are available</h2>
              <p>This page does not read or represent current fleet state.</p>
            </div>
          </div>
          <p>
            Approval, step-up authentication, target acknowledgement,
            partial-delivery handling, recovery, and tabletop gates are not
            complete. No scope, message, preview, active-state, or audit claim
            is shown here.
          </p>
          <Button variant="danger" disabled icon={<Siren size={18} />}>
            Activation disabled during pilot
          </Button>
        </Panel>
      </div>
    </>
  );
}
