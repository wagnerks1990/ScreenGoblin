import { useEffect, useMemo, useState } from "react";
import {
  MonitorCog,
  MoreHorizontal,
  MonitorOff,
  RotateCw,
  Camera,
  Power,
  Trash2,
  Tag,
  KeyRound,
  AlertTriangle,
} from "lucide-react";
import type { ManagementScreen } from "@screengoblin/contracts";
import { screens, type DemoScreen } from "../data";
import {
  Button,
  Drawer,
  EmptyState,
  Modal,
  PageHeader,
  SearchBox,
  Select,
  Status,
} from "../components";
import {
  api,
  type DeviceReenrollmentActivation,
  type DeviceReenrollmentCandidate,
  type DeviceReenrollmentGrant,
  type DeviceReenrollmentStatus,
} from "../api";

const terminalReenrollmentStatuses = new Set([
  "activated",
  "claimed",
  "cancelled",
  "canceled",
  "revoked",
  "expired",
]);

type FleetScreen = ManagementScreen | DemoScreen;

function deviceDescription(device: DeviceReenrollmentCandidate["device"]) {
  const values = [
    device.model,
    device.osVersion,
    device.playerVersion,
    device.installationId,
    device.manufacturer,
    device.platform,
    device.appVersion,
  ].filter((value): value is string => typeof value === "string");
  return values.length ? values.join(" · ") : "No device metadata";
}

export function Fleet({ canManage = true }: { canManage?: boolean }) {
  const liveViewRequested = api.hasLiveSession() || !api.demoAllowed();
  const [fleetScreens, setFleetScreens] = useState<FleetScreen[]>(
    liveViewRequested ? [] : screens,
  );
  const [loadError, setLoadError] = useState("");
  const [loadState, setLoadState] = useState<
    "loading" | "live" | "demo" | "error"
  >(liveViewRequested ? "loading" : "demo");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("All statuses");
  const [selected, setSelected] = useState<FleetScreen | null>(null);
  const [pairOpen, setPairOpen] = useState(false);
  const [pairTargetId, setPairTargetId] = useState("");
  const [pairError, setPairError] = useState("");
  const [enrollmentMode, setEnrollmentMode] = useState<"initial" | "replace">(
    "replace",
  );
  const [enrollmentCreateKey, setEnrollmentCreateKey] = useState("");
  const [enrollmentActivationKey, setEnrollmentActivationKey] = useState("");
  const [reenrollOpen, setReenrollOpen] = useState(false);
  const [reenrollScreen, setReenrollScreen] = useState<FleetScreen | null>(
    null,
  );
  const [reenrollGrant, setReenrollGrant] = useState<DeviceReenrollmentGrant>();
  const [reenrollStatus, setReenrollStatus] =
    useState<DeviceReenrollmentStatus>();
  const [reenrollActivation, setReenrollActivation] =
    useState<DeviceReenrollmentActivation>();
  const [reenrollError, setReenrollError] = useState("");
  const [reenrollBusy, setReenrollBusy] = useState(false);
  const [cancelConfirmationRequested, setCancelConfirmationRequested] =
    useState(false);
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [candidateConfirmed, setCandidateConfirmed] = useState(false);
  const [reenrollReason, setReenrollReason] = useState("");
  const reenrollStatusName = reenrollStatus?.status.toLowerCase();
  const reenrollmentIsTerminal = Boolean(
    reenrollStatusName && terminalReenrollmentStatuses.has(reenrollStatusName),
  );
  const reenrollmentWasClaimed = reenrollStatusName === "claimed";
  const filtered = useMemo(
    () =>
      fleetScreens.filter(
        (s) =>
          (s.name + s.location).toLowerCase().includes(query.toLowerCase()) &&
          (status === "All statuses" || s.status === status.toLowerCase()),
      ),
    [fleetScreens, query, status],
  );
  useEffect(() => {
    void api
      .screens()
      .then((result) => {
        setFleetScreens(result.data);
        setLoadState(result.source);
        setLoadError("");
      })
      .catch((error: unknown) => {
        setFleetScreens([]);
        setLoadState("error");
        setLoadError(
          error instanceof Error
            ? error.message
            : "Live screens could not be loaded",
        );
      });
  }, []);
  useEffect(() => {
    if (!reenrollOpen || !reenrollGrant || reenrollActivation) return;
    let active = true;
    let timeout: number | undefined;
    const poll = async () => {
      try {
        const next =
          enrollmentMode === "initial"
            ? await api.screenEnrollmentStatus(
                reenrollGrant.screenId,
                reenrollGrant.grantId,
              )
            : await api.deviceReenrollmentStatus(
                reenrollGrant.screenId,
                reenrollGrant.grantId,
              );
        if (!active) return;
        setReenrollStatus(next);
        setReenrollError("");
        if (!terminalReenrollmentStatuses.has(next.status.toLowerCase())) {
          timeout = window.setTimeout(poll, 2000);
        }
      } catch (error) {
        if (!active) return;
        setReenrollError(
          error instanceof Error
            ? error.message
            : `${enrollmentMode === "initial" ? "Enrollment" : "Replacement"} status could not be refreshed.`,
        );
        timeout = window.setTimeout(poll, 4000);
      }
    };
    void poll();
    return () => {
      active = false;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [enrollmentMode, reenrollActivation, reenrollGrant, reenrollOpen]);
  useEffect(() => {
    if (
      selectedCandidateId &&
      reenrollStatus &&
      !reenrollStatus.candidates.some(
        (candidate) => candidate.id === selectedCandidateId,
      )
    ) {
      setSelectedCandidateId("");
      setCandidateConfirmed(false);
    }
  }, [reenrollStatus, selectedCandidateId]);

  const beginReenrollment = (
    screen: FleetScreen,
    mode: "initial" | "replace" = "replace",
  ) => {
    if (reenrollGrant && !reenrollmentIsTerminal && !reenrollActivation) {
      setReenrollOpen(true);
      return;
    }
    setReenrollScreen(screen);
    setEnrollmentMode(mode);
    setReenrollOpen(true);
    setReenrollGrant(undefined);
    setReenrollStatus(undefined);
    setReenrollActivation(undefined);
    setReenrollError("");
    setSelectedCandidateId("");
    setCandidateConfirmed(false);
    setCancelConfirmationRequested(false);
    setReenrollReason("");
    setEnrollmentCreateKey(crypto.randomUUID());
    setEnrollmentActivationKey(crypto.randomUUID());
  };
  const createReenrollment = async () => {
    if (!reenrollScreen) return;
    setReenrollBusy(true);
    setReenrollError("");
    try {
      const grant =
        enrollmentMode === "initial"
          ? await api.createScreenEnrollment(
              reenrollScreen.id,
              reenrollReason.trim(),
              enrollmentCreateKey,
            )
          : await api.createDeviceReenrollment(
              reenrollScreen.id,
              reenrollReason.trim(),
            );
      setReenrollGrant(grant);
      setFleetScreens((current) =>
        current.map((screen) =>
          screen.id === grant.screenId
            ? { ...screen, status: "offline" }
            : screen,
        ),
      );
      setSelected((current) =>
        current?.id === grant.screenId
          ? { ...current, status: "offline" }
          : current,
      );
    } catch (error) {
      setReenrollError(
        error instanceof Error
          ? error.message
          : `An ${enrollmentMode === "initial" ? "enrollment" : "replacement"} code could not be created.`,
      );
    } finally {
      setReenrollBusy(false);
    }
  };
  const dismissReenrollment = () => {
    if (reenrollBusy) return;
    setReenrollOpen(false);
  };
  const cancelReenrollment = async () => {
    if (!reenrollGrant || reenrollActivation || reenrollmentIsTerminal) {
      setReenrollOpen(false);
      return;
    }
    setReenrollBusy(true);
    setReenrollError("");
    try {
      if (enrollmentMode === "initial")
        await api.cancelScreenEnrollment(
          reenrollGrant.screenId,
          reenrollGrant.grantId,
        );
      else
        await api.cancelDeviceReenrollment(
          reenrollGrant.screenId,
          reenrollGrant.grantId,
        );
      setReenrollStatus({
        grantId: reenrollGrant.grantId,
        screenId: reenrollGrant.screenId,
        status: "revoked",
        expiresAt: reenrollGrant.expiresAt,
        candidates: [],
      });
      setSelectedCandidateId("");
      setCandidateConfirmed(false);
      setCancelConfirmationRequested(false);
    } catch (error) {
      setReenrollError(
        error instanceof Error
          ? error.message
          : `The ${enrollmentMode === "initial" ? "enrollment" : "replacement"} request could not be cancelled.`,
      );
    } finally {
      setReenrollBusy(false);
    }
  };
  const activateCandidate = async () => {
    if (!reenrollGrant || !selectedCandidateId || !candidateConfirmed) return;
    setReenrollBusy(true);
    setReenrollError("");
    try {
      const candidate = reenrollStatus?.candidates.find(
        (value) => value.id === selectedCandidateId,
      );
      if (!candidate) return;
      const activation =
        enrollmentMode === "initial"
          ? await api.activateScreenEnrollmentCandidate(
              reenrollGrant.screenId,
              reenrollGrant.grantId,
              selectedCandidateId,
              candidate.fingerprint,
              enrollmentActivationKey,
            )
          : await api.activateDeviceReenrollmentCandidate(
              reenrollGrant.screenId,
              reenrollGrant.grantId,
              selectedCandidateId,
            );
      setReenrollActivation(activation);
    } catch (error) {
      setReenrollError(
        error instanceof Error
          ? error.message
          : `The selected ${enrollmentMode === "initial" ? "enrollment" : "replacement"} could not be activated.`,
      );
    } finally {
      setReenrollBusy(false);
    }
  };
  return (
    <>
      {loadError && (
        <div className="operational-error" role="alert">
          Live screen data is unavailable: {loadError}. No demo records were
          substituted.
        </div>
      )}
      <PageHeader
        eyebrow="Operations"
        title="Screen fleet"
        description="Review reported player state and manage enrollment."
        actions={
          <Button
            disabled={!canManage || !api.hasLiveSession()}
            icon={<MonitorCog size={18} />}
            onClick={async () => {
              setPairOpen(true);
              setPairTargetId("");
              setPairError("");
              if (!api.hasLiveSession()) {
                setPairError(
                  "Connect the console to the live API before pairing a screen.",
                );
                return;
              }
            }}
          >
            {api.hasLiveSession()
              ? "Pair a screen"
              : "Pair a screen unavailable"}
          </Button>
        }
      />
      <p className="data-source-label">
        {loadState === "loading"
          ? "Loading live screen data…"
          : loadState === "live"
            ? "Live API data"
            : loadState === "demo"
              ? "Clearly labeled demonstration data"
              : "Live API data unavailable"}
      </p>
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
      {loadState === "loading" ? (
        <EmptyState
          icon={<MonitorCog />}
          title="Loading screens"
          message="Requesting current screen records from the live API."
        />
      ) : loadState === "error" ? (
        <EmptyState
          icon={<MonitorOff />}
          title="Screen data unavailable"
          message="No current screen records are available. Reconnect after live API access is restored."
        />
      ) : filtered.length ? (
        <div className="table-wrap fleet-table">
          <table>
            <thead>
              <tr>
                <th>Screen</th>
                <th>Location</th>
                <th>Reported status</th>
                <th>
                  {loadState === "demo"
                    ? "Now playing (demo)"
                    : "Player-reported asset ID"}
                </th>
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
                  <td>
                    {loadState === "demo"
                      ? demoNowPlaying(s)
                      : liveValue(s, "nowPlayingAssetId")}
                  </td>
                  <td className="table-secondary">
                    {formatTimestamp(s.lastSeenAt)}
                  </td>
                  <td className="table-secondary">
                    {s.playerVersion ? `v${s.playerVersion}` : "Not reported"}
                  </td>
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
          title={
            fleetScreens.length ? "No screens match" : "No screens registered"
          }
          message={
            fleetScreens.length
              ? "No screens match your current search and status filter."
              : loadState === "live"
                ? "The live API returned an empty screen inventory."
                : "This demonstration inventory has no screens."
          }
        />
      )}
      <Drawer
        open={!!selected && !reenrollOpen}
        onClose={() => setSelected(null)}
        title={selected?.name ?? "Screen"}
        eyebrow={selected?.location ?? "Screen details"}
      >
        {selected && (
          <>
            <div className="fleet-preview-unavailable" role="status">
              <MonitorOff aria-hidden="true" />
              <span>
                <b>Screen preview unavailable</b>
                This API does not provide screenshots or evidence of locally
                retained playback.
              </span>
            </div>
            <div className="drawer-status">
              <Status value={selected.status} />
              <span>{heartbeatDescription(selected.lastSeenAt)}</span>
            </div>
            <div className="command-grid">
              <button disabled title="Not available in this pilot">
                <Camera />
                <span>Screenshot</span>
              </button>
              <button disabled title="Not available in this pilot">
                <RotateCw />
                <span>Refresh</span>
              </button>
              <button disabled title="Not available in this pilot">
                <Power />
                <span>Restart</span>
              </button>
              <button disabled title="Not available in this pilot">
                <Trash2 />
                <span>Clear cache</span>
              </button>
            </div>
            <div className="drawer-section">
              <h3>Player reports</h3>
              <dl className="detail-list">
                <div>
                  <dt>
                    {loadState === "demo"
                      ? "Now playing (demo)"
                      : "Player-reported asset ID"}
                  </dt>
                  <dd>
                    {loadState === "demo"
                      ? demoNowPlaying(selected)
                      : liveValue(selected, "nowPlayingAssetId")}
                  </dd>
                </div>
                <div>
                  <dt>Last heartbeat</dt>
                  <dd>{formatTimestamp(selected.lastSeenAt)}</dd>
                </div>
                <div>
                  <dt>Network type</dt>
                  <dd>{liveValue(selected, "networkType")}</dd>
                </div>
                <div>
                  <dt>Reported uptime</dt>
                  <dd>
                    {"uptimeSeconds" in selected &&
                    selected.uptimeSeconds !== undefined
                      ? formatDuration(selected.uptimeSeconds)
                      : "Not reported"}
                  </dd>
                </div>
                <div>
                  <dt>Reported free storage</dt>
                  <dd>
                    {"freeStorageBytes" in selected &&
                    selected.freeStorageBytes !== undefined
                      ? formatBytes(selected.freeStorageBytes)
                      : "Not reported"}
                  </dd>
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
                  <dd>{selected.playerVersion ?? "Not reported"}</dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd>{liveValue(selected, "model")}</dd>
                </div>
                <div>
                  <dt>OS version</dt>
                  <dd>{liveValue(selected, "osVersion")}</dd>
                </div>
                <div>
                  <dt>Manifest version</dt>
                  <dd>{liveValue(selected, "manifestVersion")}</dd>
                </div>
              </dl>
              <div className="tag-row">
                <Tag size={15} />
                {selected.tags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
            </div>
            {canManage && loadState === "live" && (
              <div className="drawer-section device-identity-section">
                <h3>Device identity</h3>
                <p>
                  Stage a hardware identity and verify its exact key before it
                  can control this screen.
                </p>
                <Button
                  variant={selected.lastSeenAt ? "danger" : "primary"}
                  icon={<KeyRound size={17} />}
                  onClick={() =>
                    beginReenrollment(
                      selected,
                      selected.lastSeenAt || selected.playerVersion
                        ? "replace"
                        : "initial",
                    )
                  }
                >
                  {selected.lastSeenAt || selected.playerVersion
                    ? "Replace device identity"
                    : "Enroll this screen"}
                </Button>
              </div>
            )}
          </>
        )}
      </Drawer>
      <Modal
        open={pairOpen}
        onClose={() => setPairOpen(false)}
        title="Pair a screen"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPairOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!pairTargetId}
              onClick={() => {
                const target = fleetScreens.find(
                  (screen) => screen.id === pairTargetId,
                );
                if (!target) return;
                setPairOpen(false);
                beginReenrollment(target, "initial");
              }}
            >
              Continue
            </Button>
          </>
        }
      >
        {pairError ? (
          <p className="error-message">{pairError}</p>
        ) : (
          <>
            <p>
              Select a precreated offline screen. Enrollment will remain pending
              until an operator verifies the Player&apos;s exact fingerprint.
            </p>
            <Select
              label="Screen"
              value={pairTargetId}
              onChange={setPairTargetId}
            >
              <option value="">Select a screen</option>
              {fleetScreens
                .filter((screen) => !screen.lastSeenAt && !screen.playerVersion)
                .map((screen) => (
                  <option key={screen.id} value={screen.id}>
                    {screen.name} — {screen.location || "Unassigned"}
                  </option>
                ))}
            </Select>
          </>
        )}
      </Modal>
      <Modal
        open={reenrollOpen}
        onClose={dismissReenrollment}
        title={`${enrollmentMode === "initial" ? "Enroll screen" : "Replace device identity"}${reenrollScreen ? ` — ${reenrollScreen.name}` : ""}`}
        footer={
          reenrollActivation || reenrollmentIsTerminal ? (
            <Button
              variant="secondary"
              disabled={reenrollBusy}
              onClick={dismissReenrollment}
            >
              Close
            </Button>
          ) : (
            <>
              {reenrollGrant && cancelConfirmationRequested ? (
                <>
                  <Button
                    variant="secondary"
                    disabled={reenrollBusy}
                    onClick={() => setCancelConfirmationRequested(false)}
                  >
                    Keep{" "}
                    {enrollmentMode === "initial"
                      ? "enrollment"
                      : "replacement"}
                  </Button>
                  <Button
                    variant="danger"
                    disabled={reenrollBusy}
                    onClick={() => void cancelReenrollment()}
                  >
                    Confirm cancel{" "}
                    {enrollmentMode === "initial"
                      ? "enrollment"
                      : "replacement"}
                  </Button>
                </>
              ) : (
                <Button
                  variant="secondary"
                  disabled={reenrollBusy}
                  onClick={
                    reenrollGrant
                      ? () => setCancelConfirmationRequested(true)
                      : dismissReenrollment
                  }
                >
                  {reenrollGrant
                    ? `Cancel ${enrollmentMode === "initial" ? "enrollment" : "replacement"}`
                    : enrollmentMode === "initial"
                      ? "Cancel"
                      : "Keep current identity"}
                </Button>
              )}
              {!reenrollGrant && (
                <Button
                  variant="danger"
                  disabled={reenrollBusy || !reenrollReason.trim()}
                  onClick={() => void createReenrollment()}
                >
                  {reenrollBusy
                    ? "Creating code…"
                    : `Create ${enrollmentMode === "initial" ? "enrollment" : "replacement"} code`}
                </Button>
              )}
              {reenrollGrant && selectedCandidateId && (
                <Button
                  variant="danger"
                  disabled={
                    !candidateConfirmed ||
                    reenrollBusy ||
                    reenrollmentIsTerminal
                  }
                  onClick={() => void activateCandidate()}
                >
                  {reenrollBusy ? "Activating…" : "Activate exact candidate"}
                </Button>
              )}
            </>
          )
        }
      >
        {reenrollActivation || reenrollmentWasClaimed ? (
          <div className="reenrollment-success" role="status">
            <h3>
              {reenrollActivation
                ? `${enrollmentMode === "initial" ? "Enrollment" : "Replacement"} activated`
                : `${enrollmentMode === "initial" ? "Enrollment" : "Replacement"} activated by another administrator`}
            </h3>
            <p>
              Screen identity{" "}
              <code>
                {reenrollActivation?.screenId ?? reenrollStatus?.screenId}
              </code>{" "}
              {enrollmentMode === "initial" ? "was enrolled" : "was preserved"}.
              The selected device must reconnect with its new credential.
            </p>
          </div>
        ) : reenrollmentIsTerminal ? (
          <div className="reenrollment-terminal" role="status">
            <h3>
              {enrollmentMode === "initial" ? "Enrollment" : "Replacement"}{" "}
              request {reenrollStatusName}
            </h3>
            <p>
              No candidate can be activated from this request. Create a new{" "}
              {enrollmentMode === "initial" ? "enrollment" : "replacement"}{" "}
              request to recover this screen.
            </p>
          </div>
        ) : !reenrollGrant ? (
          <div className="reenrollment-warning">
            <AlertTriangle aria-hidden="true" />
            <div>
              <h3>
                {enrollmentMode === "initial"
                  ? "Create enrollment authority"
                  : "Creating a code causes an immediate interruption"}
              </h3>
              <p>
                {enrollmentMode === "initial"
                  ? "The precreated screen remains offline and no device is attached until you verify and activate an exact fingerprint."
                  : "Creating the replacement code immediately revokes the current credential and takes this screen offline. The screen record, assignments, and history remain unchanged. A new device will not be attached until you verify and activate its exact fingerprint."}
              </p>
            </div>
            <label className="field reenrollment-reason">
              <span>
                Reason for{" "}
                {enrollmentMode === "initial" ? "enrollment" : "replacement"}
              </span>
              <textarea
                aria-label={`Reason for ${enrollmentMode === "initial" ? "enrollment" : "replacement"}`}
                value={reenrollReason}
                maxLength={500}
                rows={3}
                placeholder={
                  enrollmentMode === "initial"
                    ? "For example: install the lobby player"
                    : "For example: player hardware was replaced"
                }
                onChange={(event) => setReenrollReason(event.target.value)}
              />
              <small>
                This reason is recorded for operator accountability.
              </small>
            </label>
          </div>
        ) : (
          <div className="reenrollment-progress">
            <div className="pairing-result" aria-live="polite">
              <p>
                Enter this single-use code on the{" "}
                {enrollmentMode === "initial" ? "new" : "replacement"} Player:
              </p>
              <strong>{reenrollGrant.code}</strong>
              <small>
                Expires {new Date(reenrollGrant.expiresAt).toLocaleTimeString()}
              </small>
            </div>
            <p className="reenrollment-state" role="status">
              Request status: {reenrollStatus?.status ?? "Waiting for Player"}
            </p>
            {reenrollStatus?.candidates.length ? (
              <fieldset className="candidate-list">
                <legend>Select the exact proved device to activate</legend>
                {reenrollStatus.candidates.map(
                  (candidate: DeviceReenrollmentCandidate) => (
                    <label
                      className={
                        selectedCandidateId === candidate.id
                          ? "candidate-card selected"
                          : "candidate-card"
                      }
                      key={candidate.id}
                    >
                      <input
                        type="radio"
                        name="reenrollment-candidate"
                        value={candidate.id}
                        checked={selectedCandidateId === candidate.id}
                        onChange={() => {
                          setSelectedCandidateId(candidate.id);
                          setCandidateConfirmed(false);
                        }}
                      />
                      <span>
                        <b>Key fingerprint</b>
                        <code>{candidate.fingerprint}</code>
                        <small>{deviceDescription(candidate.device)}</small>
                        <small>
                          Security: {candidate.securityLevel} · Proved{" "}
                          {new Date(candidate.provedAt).toLocaleString()}
                        </small>
                      </span>
                    </label>
                  ),
                )}
              </fieldset>
            ) : (
              <p>
                No proved candidates yet. This page refreshes automatically.
              </p>
            )}
            {selectedCandidateId && (
              <label className="candidate-confirmation">
                <input
                  type="checkbox"
                  checked={candidateConfirmed}
                  onChange={(event) =>
                    setCandidateConfirmed(event.target.checked)
                  }
                />
                <span>
                  I verified this exact fingerprint and device metadata.
                  Activating it attaches this new credential to the preserved
                  screen identity.
                </span>
              </label>
            )}
          </div>
        )}
        {reenrollError && (
          <p className="error-message" role="alert">
            {reenrollError}
          </p>
        )}
      </Modal>
    </>
  );
}

function heartbeatDescription(lastSeenAt?: string) {
  if (!lastSeenAt) return "No heartbeat has been reported";
  const timestamp = new Date(lastSeenAt);
  if (Number.isNaN(timestamp.getTime())) return `Last heartbeat ${lastSeenAt}`;
  return `Last heartbeat ${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp)}`;
}

function demoNowPlaying(screen: FleetScreen) {
  return "demoNowPlayingTitle" in screen
    ? (screen.demoNowPlayingTitle ?? "Not reported")
    : "Not reported";
}

function liveValue(
  screen: FleetScreen,
  field:
    | "nowPlayingAssetId"
    | "networkType"
    | "model"
    | "osVersion"
    | "manifestVersion",
) {
  if (!(field in screen)) return "Not reported";
  const value = (screen as Partial<ManagementScreen>)[field];
  return typeof value === "string" && value ? value : "Not reported";
}

function formatTimestamp(value?: string) {
  if (!value) return "Not reported";
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function formatDuration(seconds: number) {
  if (!Number.isSafeInteger(seconds) || seconds < 0) return "Not reported";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;
  return [
    days ? `${days}d` : "",
    hours ? `${hours}h` : "",
    minutes ? `${minutes}m` : "",
    remainingSeconds || !(days || hours || minutes)
      ? `${remainingSeconds}s`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function formatBytes(bytes: number) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return "Not reported";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (const next of units.slice(1)) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}
