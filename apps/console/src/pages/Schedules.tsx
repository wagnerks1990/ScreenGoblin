import { useEffect, useMemo, useState } from "react";
import { Clock3, CalendarX2 } from "lucide-react";
import type { ManagementSchedule } from "@screengoblin/contracts";
import { schedules } from "../data";
import {
  EmptyState,
  PageHeader,
  SearchBox,
  Select,
  Status,
} from "../components";
import { api } from "../api";

export function Schedules() {
  const liveViewRequested = api.hasLiveSession() || !api.demoAllowed();
  return liveViewRequested ? <LiveSchedules /> : <DemoSchedules />;
}

function LiveSchedules() {
  const [query, setQuery] = useState("");
  const [configuration, setConfiguration] = useState("All configurations");
  const [schedules, setSchedules] = useState<ManagementSchedule[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "live" | "error">(
    "loading",
  );
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let active = true;
    void api
      .schedules()
      .then((records) => {
        if (!active) return;
        setSchedules(records);
        setLoadState("live");
        setLoadError("");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setSchedules([]);
        setLoadState("error");
        setLoadError(
          error instanceof Error
            ? error.message
            : "Live schedules could not be loaded",
        );
      });
    return () => {
      active = false;
    };
  }, []);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return schedules.filter(
      (schedule) =>
        (!normalized ||
          `${schedule.name} ${schedule.playlistId}`
            .toLowerCase()
            .includes(normalized)) &&
        (configuration === "All configurations" ||
          schedule.enabled === (configuration === "Enabled")),
    );
  }, [configuration, query, schedules]);

  return (
    <>
      {loadError && (
        <div className="operational-error" role="alert">
          Live schedule data is unavailable: {loadError}. No demo records were
          substituted.
        </div>
      )}
      <PageHeader
        eyebrow="Programming"
        title="Schedules"
        description="Review schedule configuration returned by the live API."
      />
      <p className="data-source-label">
        {loadState === "loading"
          ? "Loading live schedule data…"
          : loadState === "live"
            ? "Live API data"
            : "Live API data unavailable"}
      </p>
      {loadState === "loading" ? (
        <EmptyState
          icon={<Clock3 />}
          title="Loading schedules"
          message="Requesting current schedule records from the live API."
        />
      ) : loadState === "error" ? (
        <EmptyState
          icon={<CalendarX2 />}
          title="Schedule data unavailable"
          message="No current schedule records are available. Reconnect after live API access is restored."
        />
      ) : (
        <>
          <div className="toolbar">
            <SearchBox
              value={query}
              onChange={setQuery}
              placeholder="Search schedules or playlist IDs"
            />
            <Select
              label="Configuration"
              value={configuration}
              onChange={setConfiguration}
            >
              <option>All configurations</option>
              <option>Enabled</option>
              <option>Disabled</option>
            </Select>
          </div>
          {filtered.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Schedule</th>
                    <th>Playlist ID</th>
                    <th>Target screen IDs</th>
                    <th>Configured window</th>
                    <th>Priority</th>
                    <th>Configuration</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((schedule) => (
                    <tr key={schedule.id}>
                      <td>
                        <b>{schedule.name}</b>
                      </td>
                      <td>
                        <code>{schedule.playlistId}</code>
                      </td>
                      <td>{new Set(schedule.screenIds).size}</td>
                      <td className="table-secondary">
                        <ScheduleWindow schedule={schedule} />
                      </td>
                      <td>
                        <span
                          className={`priority priority-${schedule.priority}`}
                        >
                          {schedule.priority}
                        </span>
                      </td>
                      <td>
                        <Status
                          value={schedule.enabled ? "Enabled" : "Disabled"}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              icon={<CalendarX2 />}
              title={schedules.length ? "No schedules match" : "No schedules"}
              message={
                schedules.length
                  ? "No schedules match your current search and configuration filter."
                  : "The live API returned an empty schedule collection."
              }
            />
          )}
        </>
      )}
    </>
  );
}

function ScheduleWindow({ schedule }: { schedule: ManagementSchedule }) {
  return (
    <span>
      Starts <time dateTime={schedule.startsAt}>{schedule.startsAt}</time>
      {schedule.endsAt ? (
        <>
          {" "}
          · Ends <time dateTime={schedule.endsAt}>{schedule.endsAt}</time>
        </>
      ) : (
        " · No configured end"
      )}
      {` · Time zone ${schedule.timezone}`}
      {schedule.daysOfWeek.length
        ? ` · Days ${schedule.daysOfWeek.join(", ")}`
        : " · No weekly recurrence"}
      {schedule.dailyStartMinutes !== undefined
        ? ` · Daily start minute ${schedule.dailyStartMinutes}`
        : ""}
      {schedule.dailyEndMinutes !== undefined
        ? ` · Daily end minute ${schedule.dailyEndMinutes}`
        : ""}
    </span>
  );
}

function DemoSchedules() {
  const [query, setQuery] = useState("");
  const [state, setState] = useState("All statuses");
  const filtered = useMemo(
    () =>
      schedules.filter(
        (schedule) =>
          schedule.name.toLowerCase().includes(query.toLowerCase()) &&
          (state === "All statuses" || schedule.status === state),
      ),
    [query, state],
  );
  return (
    <>
      <PageHeader
        eyebrow="Programming"
        title="Schedules"
        description="Review when and where programming is scheduled."
      />
      <p className="data-source-label">Clearly labeled demonstration data</p>
      <div className="schedule-banner">
        <Clock3 />
        <div>
          <b>Demonstration behavior</b>
          <span>
            Another applicable schedule may be selected after a higher-priority
            demonstration schedule ends.
          </span>
        </div>
      </div>
      <div className="toolbar">
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder="Search schedules"
        />
        <Select label="Status" value={state} onChange={setState}>
          <option>All statuses</option>
          <option>Active</option>
          <option>Upcoming</option>
          <option>Draft</option>
        </Select>
      </div>
      {filtered.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Schedule</th>
                <th>What plays</th>
                <th>Where</th>
                <th>When</th>
                <th>Priority</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((schedule) => (
                <tr key={schedule.id}>
                  <td>
                    <b>{schedule.name}</b>
                  </td>
                  <td>{schedule.playlist}</td>
                  <td>
                    <span className="table-secondary">{schedule.scope}</span>
                  </td>
                  <td>
                    <span className="table-secondary">{schedule.window}</span>
                  </td>
                  <td>
                    <span
                      className={`priority priority-${schedule.priority.toLowerCase()}`}
                    >
                      {schedule.priority}
                    </span>
                  </td>
                  <td>
                    <Status value={schedule.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          icon={<CalendarX2 />}
          title="No schedules found"
          message="No schedules match your current filters."
        />
      )}
    </>
  );
}
