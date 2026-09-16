import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ManagementReleaseCandidate } from "@screengoblin/contracts";
import { Releases } from "./Releases";

const candidate: ManagementReleaseCandidate = {
  id: "candidate-exact",
  state: "DRAFT",
  digestSha256: "a".repeat(64),
  releaseId: "release-exact",
  releaseDigestSha256: "b".repeat(64),
  sourcePlaylistId: "playlist-exact",
  authorUserId: "user-author",
  items: [
    {
      id: "item-exact",
      position: 0,
      durationSeconds: 12,
      asset: {
        id: "asset-exact",
        name: "Exact asset",
        kind: "image",
        mimeType: "image/png",
        url: "https://media.invalid/never-fetch-this.png",
        checksumSha256: "c".repeat(64),
        sizeBytes: 1234,
        createdAt: "2030-01-01T00:00:00.000Z",
      },
    },
  ],
  schedule: {
    name: "Exact campaign",
    priority: "campaign",
    startsAt: "2030-01-02T08:00:00.000Z",
    endsAt: "2030-01-03T08:00:00.000Z",
    timezone: "America/Chicago",
    daysOfWeek: [1, 3],
    dailyStartMinutes: 480,
    dailyEndMinutes: 1020,
    enabled: true,
  },
  screenIds: ["screen-exact"],
  policyVersion: 1,
  expiresAt: "2030-01-07T00:00:00.000Z",
  createdAt: "2030-01-01T00:00:00.000Z",
};

beforeEach(() => {
  window.sessionStorage.clear();
  window.sessionStorage.setItem("sg_access_token", "live-token");
});
afterEach(() => vi.unstubAllGlobals());

function response(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

it("renders exact immutable evidence and lets only the author submit the draft", async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/release-candidates") && init?.method === "POST")
      return Promise.resolve(
        response({
          ...candidate,
          state: "IN_REVIEW",
          submittedAt: "2030-01-01T01:00:00.000Z",
        }),
      );
    if (url.endsWith("/release-candidates"))
      return Promise.resolve(response({ data: [candidate] }));
    if (url.endsWith("/playlists"))
      return Promise.resolve(response({ data: [] }));
    if (url.endsWith("/screens"))
      return Promise.resolve(
        response({ data: [{ id: "screen-exact", name: "Lobby" }] }),
      );
    if (url.endsWith("/candidate-exact/submit"))
      return Promise.resolve(
        response({
          ...candidate,
          state: "IN_REVIEW",
          submittedAt: "2030-01-01T01:00:00.000Z",
        }),
      );
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(
    <Releases
      user={{
        id: "user-author",
        name: "Author",
        email: "a@example.test",
        role: "PUBLISHER",
        organizationId: "org",
      }}
    />,
  );

  await user.click(
    await screen.findByRole("button", { name: "Review exact evidence" }),
  );
  expect(
    screen.getByRole("dialog", { name: "Exact campaign" }),
  ).toHaveTextContent("release-exact");
  expect(document.body).toHaveTextContent("c".repeat(64));
  expect(document.body).toHaveTextContent(
    new Date("2030-01-01T00:00:00.000Z").toLocaleString(),
  );
  expect(document.body).toHaveTextContent(
    "https://media.invalid/never-fetch-this.png",
  );
  expect(screen.queryByRole("link", { name: /media\.invalid/i })).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "Submit exact candidate" }),
  );

  expect(await screen.findByRole("status")).toHaveTextContent(
    "Candidate submit completed",
  );
  const transition = fetchMock.mock.calls.find(([url]) =>
    String(url).endsWith("/candidate-exact/submit"),
  );
  expect(transition?.[1]?.method).toBe("POST");
  expect(new Headers(transition?.[1]?.headers).get("Idempotency-Key")).toMatch(
    /^[0-9a-f-]{36}$/,
  );
  expect(transition?.[1]?.body).toBe(
    JSON.stringify({ digestSha256: "a".repeat(64) }),
  );
});

it.each([
  [
    "different administrator",
    "user-reviewer",
    "ADMIN",
    "IN_REVIEW",
    "Approve exact candidate",
  ],
  ["author administrator", "user-author", "ADMIN", "IN_REVIEW", undefined],
  ["publisher review", "publisher", "PUBLISHER", "IN_REVIEW", undefined],
  [
    "publisher publication",
    "publisher",
    "PUBLISHER",
    "APPROVED",
    "Publish exact candidate",
  ],
] as const)(
  "applies maker/checker hints for %s",
  async (_label, id, role, state, expected) => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/candidate-exact/") && init?.method === "POST")
          return Promise.resolve(
            response({
              ...candidate,
              state: state === "IN_REVIEW" ? "APPROVED" : "PUBLISHED",
            }),
          );
        if (url.endsWith("/release-candidates"))
          return Promise.resolve(response({ data: [{ ...candidate, state }] }));
        if (url.endsWith("/playlists") || url.endsWith("/screens"))
          return Promise.resolve(response({ data: [] }));
        throw new Error(`Unexpected request ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(
      <Releases
        user={{
          id,
          name: "Operator",
          email: "operator@example.test",
          role,
          organizationId: "org",
        }}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Review exact evidence" }),
    );
    if (expected) {
      expect(screen.getByRole("button", { name: expected })).toBeTruthy();
      await user.click(screen.getByRole("button", { name: expected }));
      expect(await screen.findByRole("status")).toHaveTextContent(
        state === "IN_REVIEW"
          ? "Candidate approve completed"
          : "Candidate publish completed",
      );
    } else
      expect(
        screen.queryByRole("button", {
          name: /submit|approve|publish exact candidate/i,
        }),
      ).toBeNull();
  },
);

it("restores and retries an unresolved creation with its exact per-tab key and body", async () => {
  const body = JSON.stringify({
    playlistId: "playlist-exact",
    name: "Unknown outcome",
    priority: "normal",
    startsAt: "2030-01-02T08:00:00.000Z",
    timezone: "UTC",
    daysOfWeek: [],
    enabled: true,
    screenIds: ["screen-exact"],
    expiresAt: "2030-01-07T00:00:00.000Z",
  });
  const idempotencyKey = "00000000-0000-4000-8000-000000000123";
  window.sessionStorage.setItem(
    "sg_pending_release_commands",
    JSON.stringify({
      "org:user-author:create": { idempotencyKey, body },
    }),
  );
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/release-candidates") && init?.method === "POST")
      return Promise.resolve(response(candidate));
    if (
      url.endsWith("/release-candidates") ||
      url.endsWith("/playlists") ||
      url.endsWith("/screens")
    )
      return Promise.resolve(response({ data: [] }));
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(
    <Releases
      user={{
        id: "user-author",
        name: "Author",
        email: "a@example.test",
        role: "PUBLISHER",
        organizationId: "org",
      }}
    />,
  );

  await user.click(
    await screen.findByRole("button", { name: "Retry unresolved creation" }),
  );
  const request = fetchMock.mock.calls.find(
    ([, init]) => init?.method === "POST",
  );
  expect(new Headers(request?.[1]?.headers).get("Idempotency-Key")).toBe(
    idempotencyKey,
  );
  expect(request?.[1]?.body).toBe(body);
  expect(
    window.sessionStorage.getItem("sg_pending_release_commands"),
  ).toBeNull();
});

it("retains a valid large creation key across an ambiguous response and remount", async () => {
  const body = JSON.stringify({
    playlistId: "playlist-exact",
    name: "Large exact target snapshot",
    priority: "normal",
    startsAt: "2030-01-02T08:00:00.000Z",
    timezone: "UTC",
    daysOfWeek: [],
    enabled: true,
    screenIds: Array.from(
      { length: 900 },
      (_, index) => `screen-${String(index).padStart(56, "0")}`,
    ),
    expiresAt: "2030-01-07T00:00:00.000Z",
  });
  expect(new Blob([body]).size).toBeGreaterThan(32 * 1024);
  const idempotencyKey = "00000000-0000-4000-8000-000000000124";
  window.sessionStorage.setItem(
    "sg_pending_release_commands",
    JSON.stringify({
      "org:user-author:create": { idempotencyKey, body },
    }),
  );
  const reads = (input: RequestInfo | URL) => {
    const url = String(input);
    if (
      url.endsWith("/release-candidates") ||
      url.endsWith("/playlists") ||
      url.endsWith("/screens")
    )
      return Promise.resolve(response({ data: [] }));
    throw new Error(`Unexpected request ${url}`);
  };
  const firstFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "POST"
      ? Promise.reject(new Error("offline"))
      : reads(input),
  );
  vi.stubGlobal("fetch", firstFetch);
  const principal = {
    id: "user-author",
    name: "Author",
    email: "a@example.test",
    role: "PUBLISHER" as const,
    organizationId: "org",
  };
  const user = userEvent.setup();
  const first = render(<Releases user={principal} />);
  await screen.findByText("Live API data");
  await user.click(
    screen.getByRole("button", { name: "Retry unresolved creation" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "outcome is unknown",
  );
  expect(
    JSON.parse(
      window.sessionStorage.getItem("sg_pending_release_commands") ?? "{}",
    )["org:user-author:create"],
  ).toEqual({ idempotencyKey, body });
  first.unmount();

  const secondFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "POST"
      ? Promise.resolve(response(candidate))
      : reads(input),
  );
  vi.stubGlobal("fetch", secondFetch);
  render(<Releases user={principal} />);
  await screen.findByText("Live API data");
  await user.click(
    screen.getByRole("button", { name: "Retry unresolved creation" }),
  );
  const retry = secondFetch.mock.calls.find(
    ([, init]) => init?.method === "POST",
  );
  expect(new Headers(retry?.[1]?.headers).get("Idempotency-Key")).toBe(
    idempotencyKey,
  );
  expect(retry?.[1]?.body).toBe(body);
});

it.each([100, 101])(
  "fails closed before sending with %i unresolved commands",
  async (commandCount) => {
    const commands = Object.fromEntries(
      Array.from({ length: commandCount }, (_, index) => [
        `org:user-author:older-${index}`,
        {
          idempotencyKey: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          body: "{}",
        },
      ]),
    );
    window.sessionStorage.setItem(
      "sg_pending_release_commands",
      JSON.stringify(commands),
    );
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") throw new Error("Mutation must not be sent");
      if (url.endsWith("/release-candidates"))
        return Promise.resolve(response({ data: [candidate] }));
      if (url.endsWith("/playlists") || url.endsWith("/screens"))
        return Promise.resolve(response({ data: [] }));
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <Releases
        user={{
          id: "user-author",
          name: "Author",
          email: "a@example.test",
          role: "PUBLISHER",
          organizationId: "org",
        }}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Review exact evidence" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Submit exact candidate" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      commandCount === 100
        ? "Too many release commands have unknown outcomes"
        : "Unresolved release command storage is invalid",
    );
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "POST"),
    ).toBe(false);
    const retained = JSON.parse(
      window.sessionStorage.getItem("sg_pending_release_commands") ?? "{}",
    );
    expect(retained["org:user-author:older-0"]).toEqual(
      commands["org:user-author:older-0"],
    );
    expect(Object.keys(retained)).toHaveLength(commandCount);
  },
);

it("rejects an oversized aggregate ledger before parsing or sending", async () => {
  const commands = Object.fromEntries(
    Array.from({ length: 2 }, (_, index) => [
      `org:user-author:large-${index}`,
      {
        idempotencyKey: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        body: JSON.stringify({ padding: "x".repeat(70_000) }),
      },
    ]),
  );
  const raw = JSON.stringify(commands);
  expect(new Blob([raw]).size).toBeGreaterThan(128 * 1024);
  expect(new Blob([raw]).size).toBeLessThan(1024 * 1024);
  window.sessionStorage.setItem("sg_pending_release_commands", raw);
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") throw new Error("Mutation must not be sent");
    if (url.endsWith("/release-candidates"))
      return Promise.resolve(response({ data: [candidate] }));
    if (url.endsWith("/playlists") || url.endsWith("/screens"))
      return Promise.resolve(response({ data: [] }));
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(
    <Releases
      user={{
        id: "user-author",
        name: "Author",
        email: "a@example.test",
        role: "PUBLISHER",
        organizationId: "org",
      }}
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: "Review exact evidence" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Submit exact candidate" }),
  );

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Unresolved release command storage exceeds its safety bound",
  );
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
    false,
  );
  expect(window.sessionStorage.getItem("sg_pending_release_commands")).toBe(
    raw,
  );
});

it("preserves a valid ledger when the next command would exceed 128 KiB", async () => {
  const ledgerLimit = 128 * 1024;
  const olderKey = "org:user-author:older";
  const baseCommands = {
    [olderKey]: {
      idempotencyKey: "00000000-0000-4000-8000-000000000000",
      body: JSON.stringify({ padding: "" }),
    },
  };
  const baseRaw = JSON.stringify(baseCommands);
  const padding = "x".repeat(ledgerLimit - 1 - new Blob([baseRaw]).size);
  const commands = {
    [olderKey]: {
      ...baseCommands[olderKey],
      body: JSON.stringify({ padding }),
    },
  };
  const raw = JSON.stringify(commands);
  expect(new Blob([raw]).size).toBe(ledgerLimit - 1);
  expect(
    new Blob([
      JSON.stringify({
        ...commands,
        "org:user-author:candidate-exact:submit": {
          idempotencyKey: "00000000-0000-4000-8000-000000000001",
          body: JSON.stringify({ digestSha256: candidate.digestSha256 }),
        },
      }),
    ]).size,
  ).toBeGreaterThan(ledgerLimit);
  window.sessionStorage.setItem("sg_pending_release_commands", raw);
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") throw new Error("Mutation must not be sent");
    if (url.endsWith("/release-candidates"))
      return Promise.resolve(response({ data: [candidate] }));
    if (url.endsWith("/playlists") || url.endsWith("/screens"))
      return Promise.resolve(response({ data: [] }));
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(
    <Releases
      user={{
        id: "user-author",
        name: "Author",
        email: "a@example.test",
        role: "PUBLISHER",
        organizationId: "org",
      }}
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: "Review exact evidence" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Submit exact candidate" }),
  );

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Unresolved release command storage is full",
  );
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
    false,
  );
  expect(window.sessionStorage.getItem("sg_pending_release_commands")).toBe(
    raw,
  );
});

it("preserves malformed stored command JSON without sending", async () => {
  const raw = JSON.stringify({
    "org:user-author:candidate-exact:submit": {
      idempotencyKey: "00000000-0000-4000-8000-000000000000",
      body: "not-json",
    },
  });
  window.sessionStorage.setItem("sg_pending_release_commands", raw);
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") throw new Error("Mutation must not be sent");
    if (url.endsWith("/release-candidates"))
      return Promise.resolve(response({ data: [candidate] }));
    if (url.endsWith("/playlists") || url.endsWith("/screens"))
      return Promise.resolve(response({ data: [] }));
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(
    <Releases
      user={{
        id: "user-author",
        name: "Author",
        email: "a@example.test",
        role: "PUBLISHER",
        organizationId: "org",
      }}
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: "Review exact evidence" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Submit exact candidate" }),
  );

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Unresolved release command storage is invalid",
  );
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
    false,
  );
  expect(window.sessionStorage.getItem("sg_pending_release_commands")).toBe(
    raw,
  );
});

it("does not offer a transition for an expired candidate", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/release-candidates"))
        return Promise.resolve(
          response({
            data: [{ ...candidate, expiresAt: "2020-01-01T00:00:00.000Z" }],
          }),
        );
      if (url.endsWith("/playlists") || url.endsWith("/screens"))
        return Promise.resolve(response({ data: [] }));
      throw new Error(`Unexpected request ${url}`);
    }),
  );
  const user = userEvent.setup();
  render(
    <Releases
      user={{
        id: "user-author",
        name: "Author",
        email: "a@example.test",
        role: "PUBLISHER",
        organizationId: "org",
      }}
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: "Review exact evidence" }),
  );
  expect(
    screen.queryByRole("button", { name: "Submit exact candidate" }),
  ).toBeNull();
  expect(screen.getByText(/No action is available/)).toBeTruthy();
});

it("serializes recurrence, daily window, enabled state, and exact targets", async () => {
  let createAttempts = 0;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/release-candidates") && init?.method === "POST") {
      createAttempts += 1;
      if (createAttempts === 1)
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: "ASSET_NOT_ALLOWED",
                message: "Candidate rejected",
              },
            }),
            { status: 422, headers: { "Content-Type": "application/json" } },
          ),
        );
      return Promise.resolve(response(candidate));
    }
    if (url.endsWith("/release-candidates"))
      return Promise.resolve(response({ data: [] }));
    if (url.endsWith("/playlists"))
      return Promise.resolve(
        response({
          data: [
            {
              id: "playlist-exact",
              name: "Playlist",
              description: "",
              items: [],
              createdAt: "",
              updatedAt: "",
            },
          ],
        }),
      );
    if (url.endsWith("/screens"))
      return Promise.resolve(
        response({ data: [{ id: "screen-exact", name: "Lobby" }] }),
      );
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(
    <Releases
      user={{
        id: "user-author",
        name: "Author",
        email: "a@example.test",
        role: "PUBLISHER",
        organizationId: "org",
      }}
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: "New candidate" }),
  );
  await user.selectOptions(screen.getByLabelText("Playlist"), "playlist-exact");
  await user.type(screen.getByLabelText("Schedule name"), "Recurring campaign");
  const local = (offsetDays: number) => {
    const date = new Date(Date.now() + offsetDays * 86_400_000);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  await user.type(
    screen.getByLabelText("Starts (browser local time)"),
    local(1),
  );
  await user.type(screen.getByLabelText(/Candidate expires/), local(3));
  await user.click(screen.getByLabelText("Monday"));
  await user.click(screen.getByLabelText("Wednesday"));
  await user.type(screen.getByLabelText(/Daily start minute/), "480");
  await user.type(screen.getByLabelText(/Daily end minute/), "1020");
  await user.click(screen.getByLabelText(/Schedule enabled/));
  await user.click(screen.getByLabelText(/Lobby/));
  await user.click(screen.getByRole("button", { name: "Freeze candidate" }));

  const dialog = screen.getByRole("dialog", {
    name: "Create immutable candidate",
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Candidate rejected",
  );
  expect(dialog).toContainElement(screen.getByRole("alert"));
  expect(
    screen.queryByRole("button", { name: /retry.*unresolved/i }),
  ).toBeNull();
  expect(
    window.sessionStorage.getItem("sg_pending_release_commands"),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", { name: "New candidate" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "New candidate" }));
  const name = screen.getByLabelText("Schedule name");
  await user.clear(name);
  await user.type(name, "Corrected recurring campaign");
  await user.click(screen.getByRole("button", { name: "Freeze candidate" }));

  const requests = fetchMock.mock.calls.filter(
    ([, init]) => init?.method === "POST",
  );
  const request = requests[1];
  expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
    daysOfWeek: [1, 3],
    dailyStartMinutes: 480,
    dailyEndMinutes: 1020,
    enabled: false,
    screenIds: ["screen-exact"],
    name: "Corrected recurring campaign",
  });
  expect(
    new Headers(requests[0]?.[1]?.headers).get("Idempotency-Key"),
  ).not.toBe(new Headers(requests[1]?.[1]?.headers).get("Idempotency-Key"));
});

it("keeps viewers read-only and never substitutes candidate demo evidence", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/release-candidates"))
        return Promise.resolve(
          response({ data: [{ ...candidate, state: "IN_REVIEW" }] }),
        );
      if (url.endsWith("/playlists"))
        return Promise.resolve(response({ data: [] }));
      if (url.endsWith("/screens"))
        return Promise.resolve(response({ data: [] }));
      throw new Error(`Unexpected request ${url}`);
    }),
  );
  const user = userEvent.setup();
  render(
    <Releases
      user={{
        id: "viewer",
        name: "Viewer",
        email: "v@example.test",
        role: "VIEWER",
        organizationId: "org",
      }}
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: "Review exact evidence" }),
  );
  expect(screen.getByText(/No action is available/)).toBeTruthy();
  expect(
    screen.queryByRole("button", {
      name: /submit|approve|publish exact candidate/i,
    }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "New candidate" })).toBeNull();
});
