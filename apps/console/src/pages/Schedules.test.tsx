import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Schedules } from "./Schedules";

beforeEach(() => {
  window.sessionStorage.clear();
  window.sessionStorage.setItem("sg_access_token", "live-token");
});
afterEach(() => vi.unstubAllGlobals());

it("renders configured schedules without inferred operational or assignment state", async () => {
  let resolveRequest!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveRequest = resolve;
        }),
    ),
  );
  const user = userEvent.setup();
  render(<Schedules />);

  expect(screen.getByText("Loading live schedule data…")).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "Loading schedules" }),
  ).toBeTruthy();
  expect(screen.queryByText("School Day Baseline")).toBeNull();

  resolveRequest(
    new Response(
      JSON.stringify({
        data: [
          {
            id: "schedule-live",
            playlistId: "playlist-exact",
            name: "Configured API schedule",
            priority: "campaign",
            startsAt: "2030-01-01T08:00:00.000Z",
            endsAt: "2030-02-01T08:00:00.000Z",
            timezone: "America/Chicago",
            daysOfWeek: [1, 3, 5],
            dailyStartMinutes: 480,
            dailyEndMinutes: 1020,
            enabled: false,
            screenIds: ["screen-a", "screen-a", "screen-b"],
            releaseId: "release-do-not-interpret",
            assignmentId: "assignment-do-not-interpret",
            createdAt: "2030-01-01T00:00:00.000Z",
            updatedAt: "2030-01-02T00:00:00.000Z",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );

  expect(await screen.findByText("Configured API schedule")).toBeTruthy();
  expect(screen.getByText("playlist-exact")).toBeTruthy();
  expect(screen.getByRole("cell", { name: "2" })).toBeTruthy();
  expect(screen.getByRole("cell", { name: "Disabled" })).toBeTruthy();
  expect(document.body).toHaveTextContent("2030-01-01T08:00:00.000Z");
  expect(document.body).toHaveTextContent("Time zone America/Chicago");
  expect(document.body).toHaveTextContent("Days 1, 3, 5");
  expect(document.body).not.toHaveTextContent("release-do-not-interpret");
  expect(document.body).not.toHaveTextContent("assignment-do-not-interpret");
  for (const claim of [
    "Active",
    "Upcoming",
    "Draft",
    "Published",
    "Assigned to",
  ])
    expect(document.body).not.toHaveTextContent(claim);
  expect(screen.queryByRole("button", { name: /new schedule/i })).toBeNull();
  expect(screen.queryByRole("button", { name: /more options/i })).toBeNull();
  expect(
    screen.queryByRole("button", { name: /withdraw|publish/i }),
  ).toBeNull();
  expect(screen.queryByText("School Day Baseline")).toBeNull();

  await user.selectOptions(
    screen.getByRole("combobox", { name: "Configuration" }),
    "Enabled",
  );
  expect(
    screen.getByRole("heading", { name: "No schedules match" }),
  ).toBeTruthy();
});

it("distinguishes authenticated schedule errors from successful empty data", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("offline")));
  const { unmount } = render(<Schedules />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "No demo records were substituted",
  );
  expect(
    screen.getByRole("heading", { name: "Schedule data unavailable" }),
  ).toBeTruthy();
  expect(screen.queryByText("School Day Baseline")).toBeNull();
  unmount();

  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  render(<Schedules />);
  expect(
    await screen.findByRole("heading", { name: "No schedules" }),
  ).toBeTruthy();
  expect(screen.getByText("Live API data")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});
