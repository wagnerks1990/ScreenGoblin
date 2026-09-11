import { useMemo, useState } from "react";
import { CalendarPlus, Clock3, MoreHorizontal, CalendarX2 } from "lucide-react";
import { schedules } from "../data";
import {
  Button,
  EmptyState,
  PageHeader,
  SearchBox,
  Select,
  Status,
} from "../components";

export function Schedules() {
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
        description="Decide what plays, where it plays, and when."
        actions={
          <Button icon={<CalendarPlus size={18} />}>New schedule</Button>
        }
      />
      <div className="schedule-banner">
        <Clock3 />
        <div>
          <b>One clear rule</b>
          <span>
            Normal programming always resumes when a campaign or priority
            message ends.
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
                <th>
                  <span className="sr-only">Actions</span>
                </th>
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
                  <td>
                    <button
                      className="icon-button"
                      aria-label={`More options for ${s.name}`}
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
          icon={<CalendarX2 />}
          title="No schedules found"
          message="No schedules match your current filters."
        />
      )}
    </>
  );
}
