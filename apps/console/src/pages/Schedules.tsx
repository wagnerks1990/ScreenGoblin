import { useMemo, useState } from "react";
import { Clock3, CalendarX2 } from "lucide-react";
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
  const [query, setQuery] = useState("");
  const [state, setState] = useState("All statuses");
  const filtered = useMemo(
    () =>
      schedules.filter(
        (s) =>
          s.name.toLowerCase().includes(query.toLowerCase()) &&
          (state === "All statuses" || s.status === state),
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
      {liveViewRequested ? (
        <>
          <div className="containment-notice" role="status">
            <CalendarX2 aria-hidden="true" />
            <span>
              <b>Live schedule view is not connected</b>
              Authenticated schedule records are not displayed in this Console
              yet. No demonstration records have been substituted.
            </span>
          </div>
          <EmptyState
            icon={<CalendarX2 />}
            title="Live schedules unavailable"
            message="Use the control-plane API for schedule publication and withdrawal until this view is connected."
          />
        </>
      ) : (
        <>
          <p className="data-source-label">
            Clearly labeled demonstration data
          </p>
          <div className="schedule-banner">
            <Clock3 />
            <div>
              <b>Demonstration behavior</b>
              <span>
                Another applicable schedule may be selected after a
                higher-priority demonstration schedule ends.
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
                  {filtered.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <b>{s.name}</b>
                      </td>
                      <td>{s.playlist}</td>
                      <td>
                        <span className="table-secondary">{s.scope}</span>
                      </td>
                      <td>
                        <span className="table-secondary">{s.window}</span>
                      </td>
                      <td>
                        <span
                          className={`priority priority-${s.priority.toLowerCase()}`}
                        >
                          {s.priority}
                        </span>
                      </td>
                      <td>
                        <Status value={s.status} />
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
      )}
    </>
  );
}
