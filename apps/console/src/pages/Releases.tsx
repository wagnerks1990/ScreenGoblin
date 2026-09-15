import { useEffect, useMemo, useState } from "react";
import { BadgeCheck, FileLock2, Plus, RefreshCw } from "lucide-react";
import type {
  ManagementPlaylist,
  ManagementReleaseCandidate,
  ManagementScreen,
  ReleaseCandidateCreateRequest,
} from "@screengoblin/contracts";
import {
  Button,
  Drawer,
  EmptyState,
  Modal,
  PageHeader,
  Status,
} from "../components";
import { AmbiguousMutationError, api, type LiveSession } from "../api";

type Principal = LiveSession["user"] | undefined;

function timestamp(value?: string) {
  return value ? new Date(value).toLocaleString() : "Not recorded";
}

function canTransition(candidate: ManagementReleaseCandidate, user: Principal) {
  if (!user) return undefined;
  if (Date.parse(candidate.expiresAt) <= Date.now()) return undefined;
  if (candidate.state === "DRAFT" && candidate.authorUserId === user.id)
    return "submit" as const;
  if (
    candidate.state === "IN_REVIEW" &&
    candidate.authorUserId !== user.id &&
    ["OWNER", "ADMIN"].includes(user.role)
  )
    return "approve" as const;
  if (
    candidate.state === "APPROVED" &&
    ["OWNER", "ADMIN", "PUBLISHER"].includes(user.role)
  )
    return "publish" as const;
  return undefined;
}

const actionLabels = {
  submit: "Submit exact candidate",
  approve: "Approve exact candidate",
  publish: "Publish exact candidate",
} as const;

const pendingCommandsKey = "sg_pending_release_commands";
const maximumPendingCommandBodyBytes = 128 * 1024;
const maximumPendingLedgerBytes = 128 * 1024;
const canonicalUuidV4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type PendingCommand = { idempotencyKey: string; body: string };

function validStoredCommandBody(body: string) {
  try {
    const parsed: unknown = JSON.parse(body);
    return Boolean(
      parsed && typeof parsed === "object" && !Array.isArray(parsed),
    );
  } catch {
    return false;
  }
}

function pendingCommands(): Record<string, PendingCommand> {
  const raw = window.sessionStorage.getItem(pendingCommandsKey);
  if (!raw) return {};
  if (new Blob([raw]).size > maximumPendingLedgerBytes)
    throw new Error(
      "Unresolved release command storage exceeds its safety bound. Reconcile it before sending another command.",
    );
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("invalid shape");
    const entries = Object.entries(parsed);
    if (entries.length > 100) throw new Error("too many entries");
    if (
      entries.some(
        ([, value]) =>
          !value ||
          typeof value !== "object" ||
          !("idempotencyKey" in value) ||
          typeof value.idempotencyKey !== "string" ||
          !canonicalUuidV4.test(value.idempotencyKey) ||
          !("body" in value) ||
          typeof value.body !== "string" ||
          new Blob([value.body]).size > maximumPendingCommandBodyBytes ||
          !validStoredCommandBody(value.body),
      )
    )
      throw new Error("invalid entry");
    return Object.fromEntries(entries) as Record<string, PendingCommand>;
  } catch {
    throw new Error(
      "Unresolved release command storage is invalid. Reconcile it before sending another command.",
    );
  }
}

function pendingCommand(commandId: string) {
  try {
    return pendingCommands()[commandId];
  } catch {
    return undefined;
  }
}

function rememberCommand(commandId: string, body: string) {
  if (new Blob([body]).size > maximumPendingCommandBodyBytes)
    throw new Error("Release command is too large for safe retry storage.");
  const commands = pendingCommands();
  const existing = commands[commandId];
  if (!existing && Object.keys(commands).length >= 100)
    throw new Error(
      "Too many release commands have unknown outcomes. Reconcile them before sending another command.",
    );
  if (existing && existing.body !== body)
    throw new Error(
      "An earlier command has an unknown outcome. Reconcile or retry its exact request before changing it.",
    );
  const command = existing ?? { idempotencyKey: crypto.randomUUID(), body };
  const serialized = JSON.stringify({ ...commands, [commandId]: command });
  if (new Blob([serialized]).size > maximumPendingLedgerBytes)
    throw new Error(
      "Unresolved release command storage is full. Reconcile it before sending another command.",
    );
  window.sessionStorage.setItem(pendingCommandsKey, serialized);
  return command;
}

function forgetCommand(commandId: string) {
  const commands = pendingCommands();
  delete commands[commandId];
  if (Object.keys(commands).length)
    window.sessionStorage.setItem(pendingCommandsKey, JSON.stringify(commands));
  else window.sessionStorage.removeItem(pendingCommandsKey);
}

export function Releases({ user }: { user: Principal }) {
  const live = api.hasLiveSession();
  const [candidates, setCandidates] = useState<ManagementReleaseCandidate[]>(
    [],
  );
  const [selected, setSelected] = useState<ManagementReleaseCandidate>();
  const [playlists, setPlaylists] = useState<ManagementPlaylist[]>([]);
  const [screens, setScreens] = useState<ManagementScreen[]>([]);
  const [loading, setLoading] = useState(live);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const commandScope = `${user?.organizationId ?? "unknown"}:${user?.id ?? "unknown"}`;
  const createCommandId = `${commandScope}:create`;
  const [pendingCreate, setPendingCreate] = useState<
    PendingCommand | undefined
  >(() => pendingCommand(createCommandId));
  const [form, setForm] = useState({
    playlistId: "",
    name: "",
    priority: "normal" as "normal" | "campaign" | "priority",
    startsAt: "",
    endsAt: "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    expiresAt: "",
    daysOfWeek: [] as number[],
    dailyStartMinutes: "",
    dailyEndMinutes: "",
    enabled: true,
    screenIds: [] as string[],
  });

  const load = async () => {
    if (!live) return;
    setLoading(true);
    setError("");
    setSelected(undefined);
    try {
      const [nextCandidates, nextPlaylists, nextScreens] = await Promise.all([
        api.releaseCandidates(),
        api.playlists(),
        api.screens(),
      ]);
      if (nextScreens.source !== "live")
        throw new Error("Live screens were not returned");
      setCandidates(nextCandidates);
      setPlaylists(nextPlaylists);
      setScreens(nextScreens.data as ManagementScreen[]);
    } catch (cause) {
      setCandidates([]);
      setError(
        cause instanceof Error
          ? cause.message
          : "Release data could not be loaded",
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // Session mode changes remount this route in App.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ordered = useMemo(
    () =>
      [...candidates].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [candidates],
  );
  const selectedAction = selected ? canTransition(selected, user) : undefined;
  const canCreate = Boolean(
    user && ["OWNER", "ADMIN", "PUBLISHER"].includes(user.role),
  );
  const startsAtMs = Date.parse(form.startsAt);
  const endsAtMs = form.endsAt ? Date.parse(form.endsAt) : undefined;
  const expiresAtMs = Date.parse(form.expiresAt);
  const dailyStart =
    form.dailyStartMinutes === "" ? undefined : Number(form.dailyStartMinutes);
  const dailyEnd =
    form.dailyEndMinutes === "" ? undefined : Number(form.dailyEndMinutes);
  const createInvalid =
    !form.playlistId ||
    !form.name.trim() ||
    !Number.isFinite(startsAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= Date.now() ||
    expiresAtMs > Date.now() + 7 * 24 * 60 * 60 * 1_000 ||
    (endsAtMs !== undefined &&
      (!Number.isFinite(endsAtMs) || endsAtMs <= startsAtMs)) ||
    (dailyStart !== undefined &&
      (!Number.isInteger(dailyStart) || dailyStart < 0 || dailyStart > 1439)) ||
    (dailyEnd !== undefined &&
      (!Number.isInteger(dailyEnd) || dailyEnd < 1 || dailyEnd > 1440)) ||
    (dailyStart !== undefined &&
      dailyEnd !== undefined &&
      dailyEnd <= dailyStart) ||
    !form.screenIds.length;

  const runTransition = async (
    candidate: ManagementReleaseCandidate,
    operation: "submit" | "approve" | "publish",
  ) => {
    setBusy(true);
    setError("");
    setStatus("");
    const commandKey = `${commandScope}:${candidate.id}:${operation}`;
    const commandBody = JSON.stringify({
      digestSha256: candidate.digestSha256,
    });
    let requestStarted = false;
    try {
      const pending = rememberCommand(commandKey, commandBody);
      const command =
        operation === "submit"
          ? api.submitReleaseCandidate
          : operation === "approve"
            ? api.approveReleaseCandidate
            : api.publishReleaseCandidate;
      const requestBody = JSON.parse(pending.body) as { digestSha256: string };
      requestStarted = true;
      const updated = await command(
        candidate.id,
        requestBody,
        pending.idempotencyKey,
      );
      forgetCommand(commandKey);
      setCandidates((records) =>
        records.map((record) => (record.id === updated.id ? updated : record)),
      );
      setSelected(updated);
      setStatus(`Candidate ${operation} completed.`);
    } catch (cause) {
      if (!(cause instanceof AmbiguousMutationError) && requestStarted)
        forgetCommand(commandKey);
      setError(
        cause instanceof Error
          ? cause.message
          : `Candidate ${operation} failed`,
      );
    } finally {
      setBusy(false);
    }
  };

  const create = async (retry?: PendingCommand) => {
    setBusy(true);
    setError("");
    let pending = retry;
    let requestStarted = false;
    try {
      const body: ReleaseCandidateCreateRequest = retry
        ? (JSON.parse(retry.body) as ReleaseCandidateCreateRequest)
        : {
            playlistId: form.playlistId,
            name: form.name.trim(),
            priority: form.priority,
            startsAt: new Date(form.startsAt).toISOString(),
            ...(form.endsAt
              ? { endsAt: new Date(form.endsAt).toISOString() }
              : {}),
            timezone: form.timezone,
            daysOfWeek: [...form.daysOfWeek].sort(
              (left, right) => left - right,
            ),
            ...(dailyStart !== undefined
              ? { dailyStartMinutes: dailyStart }
              : {}),
            ...(dailyEnd !== undefined ? { dailyEndMinutes: dailyEnd } : {}),
            enabled: form.enabled,
            screenIds: form.screenIds,
            expiresAt: new Date(form.expiresAt).toISOString(),
          };
      pending ??= rememberCommand(createCommandId, JSON.stringify(body));
      const requestBody = JSON.parse(
        pending.body,
      ) as ReleaseCandidateCreateRequest;
      requestStarted = true;
      const candidate = await api.createReleaseCandidate(
        requestBody,
        pending.idempotencyKey,
      );
      forgetCommand(createCommandId);
      setPendingCreate(undefined);
      setCandidates((records) => [candidate, ...records]);
      setCreateOpen(false);
      setSelected(candidate);
      setStatus(
        "Draft candidate created. Review its frozen evidence before submission.",
      );
    } catch (cause) {
      if (cause instanceof AmbiguousMutationError) setPendingCreate(pending);
      else {
        if (requestStarted) forgetCommand(createCommandId);
        setPendingCreate(undefined);
      }
      setError(
        cause instanceof Error ? cause.message : "Candidate creation failed",
      );
    } finally {
      setBusy(false);
    }
  };

  if (!live)
    return (
      <>
        <PageHeader
          eyebrow="Publishing"
          title="Release candidates"
          description="Immutable release review is available only with a live authenticated session."
        />
        <EmptyState
          icon={<FileLock2 />}
          title="Connect to review releases"
          message="Demonstration records are never substituted for release approval evidence."
        />
      </>
    );

  return (
    <>
      {error && !selected && (
        <div className="operational-error" role="alert">
          {error}
        </div>
      )}
      {status && !selected && (
        <p className="data-source-label" role="status">
          {status}
        </p>
      )}
      <PageHeader
        eyebrow="Publishing"
        title="Release candidates"
        description="Create, review, approve, and publish immutable release evidence. Server authorization remains authoritative."
        actions={
          <>
            <Button
              variant="secondary"
              icon={<RefreshCw size={16} />}
              onClick={() => void load()}
              disabled={loading || busy}
            >
              Refresh
            </Button>
            {pendingCreate && (
              <Button
                variant="secondary"
                onClick={() => void create(pendingCreate)}
                disabled={busy || loading}
              >
                Retry unresolved creation
              </Button>
            )}
            {canCreate && (
              <Button
                icon={<Plus size={16} />}
                onClick={() => {
                  setError("");
                  setCreateOpen(true);
                }}
                disabled={busy || Boolean(pendingCreate)}
              >
                New candidate
              </Button>
            )}
          </>
        }
      />
      <p className="data-source-label">
        {loading
          ? "Loading live release data…"
          : error
            ? "Live API data unavailable"
            : "Live API data"}
      </p>
      {loading ? (
        <EmptyState
          icon={<FileLock2 />}
          title="Loading release candidates"
          message="Requesting immutable evidence from the live API."
        />
      ) : ordered.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Candidate</th>
                <th>State</th>
                <th>Schedule</th>
                <th>Targets</th>
                <th>Expires</th>
                <th>
                  <span className="sr-only">Review</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((candidate) => (
                <tr key={candidate.id}>
                  <td>
                    <b>{candidate.id}</b>
                    <br />
                    <code className="digest">{candidate.digestSha256}</code>
                  </td>
                  <td>
                    <Status value={candidate.state.replace("_", " ")} />
                  </td>
                  <td>{candidate.schedule.name}</td>
                  <td>{candidate.screenIds.length}</td>
                  <td>
                    <time dateTime={candidate.expiresAt}>
                      {timestamp(candidate.expiresAt)}
                    </time>
                  </td>
                  <td>
                    <Button
                      variant="ghost"
                      onClick={() => setSelected(candidate)}
                    >
                      Review exact evidence
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          icon={<FileLock2 />}
          title="No release candidates"
          message="The live API returned no release candidates."
        />
      )}

      <Drawer
        open={!!selected}
        onClose={() => setSelected(undefined)}
        title={selected?.schedule.name ?? "Release candidate"}
        eyebrow="Immutable evidence"
      >
        {error && (
          <div className="operational-error" role="alert">
            {error}
          </div>
        )}
        {status && (
          <p className="data-source-label" role="status">
            {status}
          </p>
        )}
        {selected && (
          <CandidateEvidence candidate={selected} screens={screens} />
        )}
        {selected && selectedAction && (
          <div className="candidate-actions">
            <p>
              The server will revalidate the full digest, authority, targets,
              assets, and expiry.
            </p>
            <Button
              disabled={busy}
              icon={<BadgeCheck size={16} />}
              onClick={() => void runTransition(selected, selectedAction)}
            >
              {busy ? "Submitting command…" : actionLabels[selectedAction]}
            </Button>
          </div>
        )}
        {selected && !selectedAction && selected.state !== "PUBLISHED" && (
          <p className="candidate-note">
            No action is available to this principal in the candidate's current
            state. Changed proposals require a new candidate.
          </p>
        )}
      </Drawer>

      <Modal
        open={createOpen}
        onClose={() => !busy && setCreateOpen(false)}
        title="Create immutable candidate"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setCreateOpen(false)}
            >
              Cancel
            </Button>
            {pendingCreate && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void create(pendingCreate)}
              >
                Retry exact unresolved creation
              </Button>
            )}
            <Button
              type="submit"
              disabled={busy || createInvalid || Boolean(pendingCreate)}
            >
              {busy ? "Creating…" : "Freeze candidate"}
            </Button>
          </>
        }
      >
        <div className="candidate-form">
          {error && (
            <div className="operational-error" role="alert">
              {error}
            </div>
          )}
          <label>
            Playlist
            <select
              required
              value={form.playlistId}
              onChange={(event) =>
                setForm({ ...form, playlistId: event.target.value })
              }
            >
              <option value="">Choose a playlist</option>
              {playlists.map((playlist) => (
                <option key={playlist.id} value={playlist.id}>
                  {playlist.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Schedule name
            <input
              required
              value={form.name}
              maxLength={140}
              onChange={(event) =>
                setForm({ ...form, name: event.target.value })
              }
            />
          </label>
          <label>
            Priority
            <select
              value={form.priority}
              onChange={(event) =>
                setForm({
                  ...form,
                  priority: event.target.value as typeof form.priority,
                })
              }
            >
              <option value="normal">Normal</option>
              <option value="campaign">Campaign</option>
              <option value="priority">Priority</option>
            </select>
          </label>
          <label>
            Starts (browser local time)
            <input
              required
              type="datetime-local"
              value={form.startsAt}
              onChange={(event) =>
                setForm({ ...form, startsAt: event.target.value })
              }
            />
          </label>
          <label>
            Ends (optional, browser local time)
            <input
              type="datetime-local"
              value={form.endsAt}
              onChange={(event) =>
                setForm({ ...form, endsAt: event.target.value })
              }
            />
          </label>
          <label>
            Candidate expires (browser local time, within seven days)
            <input
              required
              type="datetime-local"
              value={form.expiresAt}
              onChange={(event) =>
                setForm({ ...form, expiresAt: event.target.value })
              }
            />
          </label>
          <label>
            IANA time zone
            <input
              required
              value={form.timezone}
              onChange={(event) =>
                setForm({ ...form, timezone: event.target.value })
              }
            />
          </label>
          <fieldset>
            <legend>Weekly recurrence days (optional)</legend>
            {[
              "Sunday",
              "Monday",
              "Tuesday",
              "Wednesday",
              "Thursday",
              "Friday",
              "Saturday",
            ].map((label, day) => (
              <label key={label}>
                <input
                  type="checkbox"
                  checked={form.daysOfWeek.includes(day)}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      daysOfWeek: event.target.checked
                        ? [...form.daysOfWeek, day]
                        : form.daysOfWeek.filter((value) => value !== day),
                    })
                  }
                />{" "}
                {label}
              </label>
            ))}
          </fieldset>
          <label>
            Daily start minute (0–1439, optional)
            <input
              type="number"
              min="0"
              max="1439"
              value={form.dailyStartMinutes}
              onChange={(event) =>
                setForm({ ...form, dailyStartMinutes: event.target.value })
              }
            />
          </label>
          <label>
            Daily end minute (1–1440, optional)
            <input
              type="number"
              min="1"
              max="1440"
              value={form.dailyEndMinutes}
              onChange={(event) =>
                setForm({ ...form, dailyEndMinutes: event.target.value })
              }
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) =>
                setForm({ ...form, enabled: event.target.checked })
              }
            />{" "}
            Schedule enabled in the frozen proposal
          </label>
          <fieldset>
            <legend>Exact target screens</legend>
            {screens.map((screen) => (
              <label key={screen.id}>
                <input
                  type="checkbox"
                  checked={form.screenIds.includes(screen.id)}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      screenIds: event.target.checked
                        ? [...form.screenIds, screen.id]
                        : form.screenIds.filter((id) => id !== screen.id),
                    })
                  }
                />{" "}
                {screen.name} <code>{screen.id}</code>
              </label>
            ))}
          </fieldset>
          <p>
            Times are converted to canonical UTC instants. The IANA time zone
            controls recurring schedule interpretation.
          </p>
        </div>
      </Modal>
    </>
  );
}

function CandidateEvidence({
  candidate,
  screens,
}: {
  candidate: ManagementReleaseCandidate;
  screens: ManagementScreen[];
}) {
  const names = new Map(screens.map((screen) => [screen.id, screen.name]));
  return (
    <div className="candidate-evidence">
      <dl>
        <div>
          <dt>State</dt>
          <dd>{candidate.state}</dd>
        </div>
        <div>
          <dt>Candidate digest</dt>
          <dd>
            <code className="digest">{candidate.digestSha256}</code>
          </dd>
        </div>
        <div>
          <dt>Release ID</dt>
          <dd>
            <code>{candidate.releaseId}</code>
          </dd>
        </div>
        <div>
          <dt>Release digest</dt>
          <dd>
            <code className="digest">{candidate.releaseDigestSha256}</code>
          </dd>
        </div>
        <div>
          <dt>Source playlist</dt>
          <dd>
            <code>{candidate.sourcePlaylistId}</code>
          </dd>
        </div>
        <div>
          <dt>Author</dt>
          <dd>
            <code>{candidate.authorUserId}</code>
          </dd>
        </div>
        <div>
          <dt>Policy version</dt>
          <dd>{candidate.policyVersion}</dd>
        </div>
        <div>
          <dt>Created / expires</dt>
          <dd>
            {timestamp(candidate.createdAt)} / {timestamp(candidate.expiresAt)}
          </dd>
        </div>
        <div>
          <dt>Submitted / approved / published</dt>
          <dd>
            {timestamp(candidate.submittedAt)} /{" "}
            {timestamp(candidate.approvedAt)} /{" "}
            {timestamp(candidate.publishedAt)}
          </dd>
        </div>
        {candidate.approval && (
          <div>
            <dt>Approval evidence</dt>
            <dd>
              Approver <code>{candidate.approval.approverUserId}</code>
              <br />
              Digest{" "}
              <code className="digest">
                {candidate.approval.candidateDigestSha256}
              </code>
              <br />
              At {timestamp(candidate.approval.approvedAt)}
            </dd>
          </div>
        )}
      </dl>
      <section>
        <h3>Schedule snapshot</h3>
        <p>
          {candidate.schedule.name} · {candidate.schedule.priority} ·{" "}
          {candidate.schedule.timezone}
          <br />
          {candidate.schedule.startsAt} to{" "}
          {candidate.schedule.endsAt ?? "no configured end"}
          <br />
          Days{" "}
          {candidate.schedule.daysOfWeek.length
            ? candidate.schedule.daysOfWeek.join(", ")
            : "none"}
          ; daily minutes {candidate.schedule.dailyStartMinutes ?? "none"}–
          {candidate.schedule.dailyEndMinutes ?? "none"};{" "}
          {candidate.schedule.enabled ? "enabled" : "disabled"}
        </p>
      </section>
      <section>
        <h3>Exact targets</h3>
        <ul>
          {candidate.screenIds.map((id) => (
            <li key={id}>
              {names.get(id) ?? "Unknown screen"} · <code>{id}</code>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3>Ordered frozen assets</h3>
        {candidate.items.map((item) => (
          <article className="candidate-asset" key={item.id}>
            <b>
              {item.position + 1}. {item.asset.name}
            </b>
            <dl>
              <div>
                <dt>Asset</dt>
                <dd>
                  <code>{item.asset.id}</code>
                </dd>
              </div>
              <div>
                <dt>Kind / MIME</dt>
                <dd>
                  {item.asset.kind} / {item.asset.mimeType}
                </dd>
              </div>
              <div>
                <dt>Configured source URL (inert)</dt>
                <dd>
                  <code className="digest">{item.asset.url}</code>
                </dd>
              </div>
              <div>
                <dt>Checksum</dt>
                <dd>
                  <code className="digest">{item.asset.checksumSha256}</code>
                </dd>
              </div>
              <div>
                <dt>Bytes / duration</dt>
                <dd>
                  {item.asset.sizeBytes} / {item.durationSeconds}s
                </dd>
              </div>
              <div>
                <dt>Asset created</dt>
                <dd>{timestamp(item.asset.createdAt)}</dd>
              </div>
              <div>
                <dt>Asset expiry</dt>
                <dd>{timestamp(item.asset.expiresAt)}</dd>
              </div>
            </dl>
          </article>
        ))}
      </section>
      {candidate.state === "PUBLISHED" && (
        <p className="candidate-note">
          Published evidence is immutable. If its assignment is still active,
          Schedules exposes a server-verified withdrawal action. This candidate
          does not itself assert current assignment disposition; rollback to a
          prior assignment is not implemented by the server.
        </p>
      )}
    </div>
  );
}
