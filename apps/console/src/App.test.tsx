import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { StrictMode } from "react";
import { afterEach, vi } from "vitest";
import { App } from "./App";

beforeEach(() => window.sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());

const replacementTestScreen = {
  id: "screen-replacement-test",
  name: "Replacement Test Screen",
  location: "Test building",
  status: "online",
  orientation: "landscape",
  resolution: "1920 × 1080",
  lastSeenAt: "Just now",
  nowPlayingAssetId: "asset-welcome",
  playerVersion: "1.0.0",
  tags: ["test"],
};

function setAdminSession() {
  window.sessionStorage.setItem("sg_access_token", "admin-token");
  window.sessionStorage.setItem(
    "sg_session_user",
    JSON.stringify({
      id: "admin-user",
      name: "Administrator",
      email: "admin@example.test",
      role: "ADMIN",
      organizationId: "org-a",
    }),
  );
}

async function openReplacementWithStatus(
  status: string,
  candidates: unknown[] = [],
  activationError?: string,
) {
  setAdminSession();
  const json = (value: unknown, responseStatus = 200) =>
    new Response(JSON.stringify(value), {
      status: responseStatus,
      headers: { "Content-Type": "application/json" },
    });
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/screens")) {
        return json({ data: [replacementTestScreen] });
      }
      if (url.endsWith("/device-reenrollment") && init?.method === "POST") {
        return json({
          grantId: "grant-status-test",
          screenId: replacementTestScreen.id,
          code: "112233",
          expiresAt: "2030-01-01T12:00:00.000Z",
          generation: 2,
        });
      }
      if (
        url.endsWith("/device-reenrollment/grant-status-test") &&
        init?.method === "GET"
      ) {
        return json({
          grantId: "grant-status-test",
          screenId: replacementTestScreen.id,
          status,
          expiresAt: "2030-01-01T12:00:00.000Z",
          candidates,
        });
      }
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (url.includes("/candidates/") && init?.method === "POST") {
        return activationError
          ? json({ error: { message: activationError } }, 409)
          : json({ screenId: replacementTestScreen.id });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={["/screens"]}>
      <App />
    </MemoryRouter>,
  );
  await user.click(await screen.findByText(replacementTestScreen.name));
  await user.click(
    screen.getByRole("button", { name: "Replace device identity" }),
  );
  await user.type(
    screen.getByLabelText("Reason for replacement"),
    "Test replacement",
  );
  await user.click(
    screen.getByRole("button", { name: "Create replacement code" }),
  );
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith("/device-reenrollment/grant-status-test") &&
          init?.method === "GET",
      ),
    ).toBe(true),
  );
  return { fetchMock, user };
}

describe("ScreenGoblin console", () => {
  it("renders an actionable dashboard with an explicit demo state", async () => {
    render(
      <StrictMode>
        <MemoryRouter initialEntries={["/dashboard"]}>
          <App />
        </MemoryRouter>
      </StrictMode>,
    );
    expect(
      screen.getByRole("heading", { name: /screen operations overview/i }),
    ).toBeTruthy();
    expect(screen.getByText(/demo data/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /screen fleet/i })).toBeTruthy();
  });

  it("derives live dashboard health from one screen read and refreshes once", async () => {
    setAdminSession();
    const firstScreens = [
      {
        ...replacementTestScreen,
        id: "online",
        name: "Online",
        status: "online",
      },
      {
        ...replacementTestScreen,
        id: "warning",
        name: "Delayed",
        status: "warning",
        lastSeenAt: "2030-01-01T11:57:00.000Z",
      },
      {
        ...replacementTestScreen,
        id: "offline",
        name: "Silent",
        status: "offline",
        lastSeenAt: "2030-01-01T11:50:00.000Z",
      },
      {
        ...replacementTestScreen,
        id: "fallback",
        name: "Fallback",
        status: "fallback",
      },
    ];
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data:
              fetchMock.mock.calls.length === 1
                ? firstScreens
                : firstScreens.slice(0, 1),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Live API data")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const metrics = within(document.querySelector(".metrics-grid")!);
    const onlineMetric = metrics
      .getByText("Screens online")
      .closest<HTMLElement>(".metric")!;
    const attentionMetric = metrics
      .getByText("Needs attention")
      .closest<HTMLElement>(".metric")!;
    expect(within(onlineMetric).getByText("1")).toBeTruthy();
    expect(within(attentionMetric).getByText("3")).toBeTruthy();
    expect(attentionMetric).toHaveTextContent(
      "1 warning · 1 offline · 1 fallback",
    );
    expect(screen.getByText(/Heartbeat delayed · Last heartbeat/)).toBeTruthy();
    expect(screen.getByText("Player reports fallback playback")).toBeTruthy();
    expect(document.body).not.toHaveTextContent("Storage is 91% full");
    expect(
      screen.getByText(
        new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(
          new Date(),
        ),
      ),
    ).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Refresh screen data" }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(attentionMetric).toHaveTextContent("No reported screen issues"),
    );
  });

  it("distinguishes an unavailable dashboard from a successful empty fleet", async () => {
    setAdminSession();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Fleet counts are unknown until a successful retry",
    );
    const metrics = within(document.querySelector(".metrics-grid")!);
    const onlineMetric = metrics
      .getByText("Screens online")
      .closest<HTMLElement>(".metric")!;
    expect(within(onlineMetric).getByText("—")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      (await screen.findAllByText(/No screens are registered/)).length,
    ).toBeGreaterThan(0);
    expect(within(onlineMetric).getByText("0")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("contains unsupported shell and Content Studio affordances", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <App />
      </MemoryRouter>,
    );

    const globalSearch = screen.getByRole("textbox", {
      name: "Global search unavailable",
    });
    const workspaceOptions = screen.getByRole("button", {
      name: "Workspace options unavailable",
    });
    const profileMenu = screen.getByRole("button", {
      name: "Profile menu unavailable",
    });
    const createAnnouncement = screen.getByRole("button", {
      name: "Create announcement unavailable",
    });

    expect(globalSearch).toHaveProperty("disabled", true);
    expect(workspaceOptions).toHaveProperty("disabled", true);
    expect(profileMenu).toHaveProperty("disabled", true);
    expect(createAnnouncement).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: /notifications/i })).toBeNull();

    await user.click(createAnnouncement);
    expect(
      screen.queryByRole("dialog", { name: "Create announcement" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Open studio" })).toBeNull();
    expect(screen.queryByLabelText("Quick start")).toBeNull();
    expect(
      screen.queryByText(/changes saved|announcement created/i),
    ).toBeNull();
  });

  it.each(["loading", "error", "empty"] as const)(
    "does not show a static fleet count while authenticated screen data is %s",
    async (state) => {
      setAdminSession();
      const response =
        state === "loading"
          ? new Promise<Response>(() => undefined)
          : state === "error"
            ? Promise.reject(new Error("offline"))
            : Promise.resolve(
                new Response(JSON.stringify({ data: [] }), {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                }),
              );
      vi.stubGlobal(
        "fetch",
        vi.fn(() => response),
      );

      render(
        <MemoryRouter initialEntries={["/screens"]}>
          <App />
        </MemoryRouter>,
      );

      if (state === "error") await screen.findByRole("alert");
      if (state === "empty")
        await screen.findByRole("heading", { name: "No screens registered" });

      const fleetLink = screen.getByRole("link", { name: "Screen fleet" });
      expect(within(fleetLink).queryByText("2")).toBeNull();
    },
  );

  it("keeps demo pairing visibly unavailable without opening a failing dialog", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/screens"]}>
        <App />
      </MemoryRouter>,
    );

    const pairing = screen.getByRole("button", {
      name: "Pair a screen unavailable",
    });
    expect(pairing).toBeDisabled();
    await user.click(pairing);
    expect(screen.queryByRole("dialog", { name: "Pair a screen" })).toBeNull();
  });

  it("filters the media vault and clears an empty state", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/media"]}>
        <App />
      </MemoryRouter>,
    );
    await user.type(
      screen.getByRole("textbox", { name: "Search media" }),
      "not-a-real-asset",
    );
    expect(
      screen.getByRole("heading", { name: "No media found" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("Club Fair — September")).toBeTruthy();
    expect(
      screen.getByText(/pre-provisioned sample inventory · read only/i),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /upload media/i })).toBeNull();
  });

  it("renders only live media records for an authenticated session", async () => {
    setAdminSession();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "media-live-1",
                name: "Approved safety notice",
                kind: "image",
                mimeType: "image/png",
                url: "https://media.example.test/notice.png",
                checksumSha256: "a".repeat(64),
                sizeBytes: 2048,
                createdAt: "2030-01-02T00:00:00.000Z",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    render(
      <MemoryRouter initialEntries={["/media"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Approved safety notice")).toBeTruthy();
    expect(screen.queryByText("Club Fair — September")).toBeNull();
    expect(screen.getByText(/live inventory · read only/i)).toBeTruthy();
  });

  it("shows an explicit live media error without sample substitution", async () => {
    setAdminSession();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    render(
      <MemoryRouter initialEntries={["/media"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no sample records have been substituted/i,
    );
    expect(screen.queryByText("Club Fair — September")).toBeNull();
  });

  it("opens screen details from the fleet table", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/screens"]}>
        <App />
      </MemoryRouter>,
    );
    await user.click(screen.getByText("Main Lobby"));
    expect(screen.getByRole("dialog", { name: "Main Lobby" })).toBeTruthy();
    expect(screen.getByText("Player reports")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Replace device identity" }),
    ).toBeNull();
  });

  it("requires exact candidate confirmation before device replacement", async () => {
    window.sessionStorage.setItem("sg_access_token", "admin-token");
    window.sessionStorage.setItem(
      "sg_session_user",
      JSON.stringify({
        id: "admin-user",
        name: "Administrator",
        email: "admin@example.test",
        role: "ADMIN",
        organizationId: "org-a",
      }),
    );
    const liveScreen = {
      id: "screen-live-1",
      name: "Live Lobby",
      location: "Main building",
      status: "online",
      orientation: "landscape",
      resolution: "1920 × 1080",
      lastSeenAt: "Just now",
      nowPlayingAssetId: "asset-welcome",
      playerVersion: "1.0.0",
      tags: ["lobby"],
    };
    let resolveActivation!: (response: Response) => void;
    const activationResponse = new Promise<Response>((resolve) => {
      resolveActivation = resolve;
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const json = (value: unknown) =>
          new Response(JSON.stringify(value), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        if (
          url.endsWith("/screens") &&
          (!init?.method || init.method === "GET")
        ) {
          return json({ data: [liveScreen] });
        }
        if (
          url.endsWith("/screens/screen-live-1/device-reenrollment") &&
          init?.method === "POST"
        ) {
          return json({
            grantId: "grant-1",
            screenId: "screen-live-1",
            code: "654321",
            expiresAt: "2030-01-01T12:00:00.000Z",
            generation: 2,
          });
        }
        if (
          url.endsWith("/device-reenrollment/grant-1") &&
          init?.method === "GET"
        ) {
          return json({
            grantId: "grant-1",
            screenId: "screen-live-1",
            status: "PENDING_APPROVAL",
            expiresAt: "2030-01-01T12:00:00.000Z",
            candidates: [
              {
                id: "candidate-1",
                keyId: "key-1",
                fingerprint: "SHA256:ABCD-EFGH-1234",
                securityLevel: "HARDWARE_BACKED",
                device: {
                  manufacturer: "Acme",
                  model: "Player One",
                  osVersion: "Android 15",
                  playerVersion: "1.2.3",
                  installationId: "install-123",
                  appVersion: "1.2.3",
                },
                provedAt: "2029-12-31T12:00:00.000Z",
              },
            ],
          });
        }
        if (url.endsWith("/candidates/candidate-1/activate")) {
          return activationResponse;
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/screens"]}>
        <App />
      </MemoryRouter>,
    );

    await user.click(await screen.findByText("Live Lobby"));
    await user.click(
      screen.getByRole("button", { name: "Replace device identity" }),
    );
    expect(
      screen.getByText(/immediately revokes the current credential/i),
    ).toBeTruthy();
    const createCode = screen.getByRole("button", {
      name: "Create replacement code",
    });
    expect(createCode).toBeDisabled();
    await user.type(
      screen.getByLabelText("Reason for replacement"),
      "Player hardware replacement",
    );
    expect(createCode).toBeEnabled();
    await user.click(createCode);
    expect(await screen.findByText("654321")).toBeTruthy();
    const candidate = await screen.findByRole("radio", {
      name: /SHA256:ABCD-EFGH-1234/i,
    });
    expect(candidate).toHaveAccessibleName(/Player One/i);
    expect(candidate).toHaveAccessibleName(/Android 15/i);
    expect(candidate).toHaveAccessibleName(/install-123/i);
    await user.click(candidate);
    const activate = screen.getByRole("button", {
      name: "Activate exact candidate",
    });
    expect(activate).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", {
        name: /I verified this exact fingerprint/i,
      }),
    );
    expect(activate).toBeEnabled();
    await user.click(activate);
    expect(screen.getByRole("button", { name: "Activating…" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(
      screen.getByRole("dialog", { name: /Replace device identity/i }),
    ).toBeTruthy();
    resolveActivation(
      new Response(
        JSON.stringify({
          screenId: "screen-live-1",
          credentialId: "credential-2",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    expect(await screen.findByText("Replacement activated")).toBeTruthy();
    expect(screen.getByText("screen-live-1")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/screens/screen-live-1/device-reenrollment/grant-1/candidates/candidate-1/activate",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it.each([
    ["CLAIMED", /activated by another administrator/i],
    ["REVOKED", /Replacement request revoked/i],
    ["EXPIRED", /Replacement request expired/i],
  ])("renders %s as a terminal replacement state", async (status, heading) => {
    await openReplacementWithStatus(status);

    expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Cancel replacement" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
  });

  it("passively dismisses and resumes a live grant without cancelling it", async () => {
    const { fetchMock, user } = await openReplacementWithStatus("PENDING");

    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(
      screen.queryByRole("dialog", { name: /Replace device identity/i }),
    ).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Replace device identity" }),
    );
    expect(screen.getByText("112233")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: /Replace device identity/i }),
    ).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Replace device identity" }),
    );
    const backdrop = document.querySelector<HTMLElement>(".modal-overlay");
    expect(backdrop).not.toBeNull();
    await user.click(backdrop!);
    expect(
      screen.queryByRole("dialog", { name: /Replace device identity/i }),
    ).toBeNull();

    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE"),
    ).toHaveLength(0);
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).endsWith("/device-reenrollment") &&
          init?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("blocks dismissal while replacement creation is in flight", async () => {
    setAdminSession();
    let resolveCreation!: (response: Response) => void;
    const creationResponse = new Promise<Response>((resolve) => {
      resolveCreation = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/screens")) {
          return new Response(
            JSON.stringify({ data: [replacementTestScreen] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (init?.method === "POST") return creationResponse;
        if (init?.method === "GET") {
          return new Response(
            JSON.stringify({
              grantId: "grant-busy",
              screenId: replacementTestScreen.id,
              status: "PENDING",
              expiresAt: "2030-01-01T12:00:00.000Z",
              candidates: [],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/screens"]}>
        <App />
      </MemoryRouter>,
    );
    await user.click(await screen.findByText(replacementTestScreen.name));
    await user.click(
      screen.getByRole("button", { name: "Replace device identity" }),
    );
    await user.type(
      screen.getByLabelText("Reason for replacement"),
      "Busy request test",
    );
    await user.click(
      screen.getByRole("button", { name: "Create replacement code" }),
    );

    expect(
      screen.getByRole("button", { name: "Creating code…" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    await user.keyboard("{Escape}");
    expect(
      screen.getByRole("dialog", { name: /Replace device identity/i }),
    ).toBeTruthy();
    resolveCreation(
      new Response(
        JSON.stringify({
          grantId: "grant-busy",
          screenId: replacementTestScreen.id,
          code: "445566",
          expiresAt: "2030-01-01T12:00:00.000Z",
          generation: 2,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    expect(await screen.findByText("445566")).toBeTruthy();
  });

  it("requires acknowledgement before explicitly cancelling a grant", async () => {
    const { fetchMock, user } = await openReplacementWithStatus("PENDING");

    await user.click(
      screen.getByRole("button", { name: "Cancel replacement" }),
    );
    expect(
      screen.getByRole("button", { name: "Confirm cancel replacement" }),
    ).toBeTruthy();
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE"),
    ).toHaveLength(0);
    await user.click(
      screen.getByRole("button", { name: "Confirm cancel replacement" }),
    );

    expect(
      await screen.findByRole("heading", {
        name: /Replacement request revoked/i,
      }),
    ).toBeTruthy();
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE"),
    ).toHaveLength(1);
  });

  it("keeps exact metadata visible when stale activation is rejected", async () => {
    const candidate = {
      id: "candidate-stale",
      keyId: "key-stale",
      fingerprint: "SHA256:STALE-EXACT-FINGERPRINT",
      securityLevel: "HARDWARE_BACKED",
      device: {
        model: "Exact Model",
        osVersion: "Android 16",
        playerVersion: "2.0.0",
        installationId: "install-exact-789",
      },
      provedAt: "2029-12-31T12:00:00.000Z",
    };
    const { user } = await openReplacementWithStatus(
      "PENDING_APPROVAL",
      [candidate],
      "Replacement request is stale",
    );
    await user.click(
      await screen.findByRole("radio", {
        name: /SHA256:STALE-EXACT-FINGERPRINT/i,
      }),
    );
    await user.click(
      screen.getByRole("checkbox", {
        name: /I verified this exact fingerprint/i,
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Activate exact candidate" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Replacement request is stale",
    );
    expect(screen.getByText("SHA256:STALE-EXACT-FINGERPRINT")).toBeTruthy();
    expect(screen.getByText(/Exact Model/)).toHaveTextContent("Android 16");
    expect(screen.getByText(/Exact Model/)).toHaveTextContent("2.0.0");
    expect(screen.getByText(/Exact Model/)).toHaveTextContent(
      "install-exact-789",
    );
  });

  it("keeps emergency activation disabled in pilot mode", () => {
    render(
      <MemoryRouter initialEntries={["/emergency"]}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByText(/not a life-safety system/i)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /activation disabled/i }),
    ).toHaveProperty("disabled", true);
  });

  it("offers an explicit live API login without hiding demo mode", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <App />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("button", { name: /connect live/i }));
    expect(
      screen.getByRole("dialog", { name: /connect to screengoblin/i }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
  });

  it("submits live login from the keyboard and exposes failures as alerts", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: "Credentials were rejected" } }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <App />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: /connect live/i }));
    await user.type(screen.getByLabelText("Email"), "admin@example.test");
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    screen.getByRole("button", { name: "Connect live" }).focus();
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Credentials were rejected",
    );
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("warns precisely and clears local state when logout revocation is unconfirmed", async () => {
    setAdminSession();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/auth/logout") && init?.method === "POST")
          throw new Error("offline");
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <App />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "Disconnect live" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Server revocation was not confirmed. Local credentials were cleared; the session may remain usable until its one-hour expiry.",
    );
    expect(screen.getByRole("button", { name: /connect live/i })).toBeTruthy();
    expect(window.sessionStorage.getItem("sg_access_token")).toBeNull();
    expect(document.body).not.toHaveTextContent("admin-token");
  });

  it("focuses dialogs, closes them with Escape, and restores the opener", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <App />
      </MemoryRouter>,
    );
    const opener = screen.getByRole("button", { name: /connect live/i });

    await user.click(opener);
    const dialog = screen.getByRole("dialog", {
      name: /connect to screengoblin/i,
    });
    expect(dialog).toHaveFocus();
    expect(container).toHaveAttribute("aria-hidden", "true");
    expect(container).toHaveProperty("inert", true);

    const close = screen.getByRole("button", { name: "Close dialog" });
    const keepDemo = screen.getByRole("button", { name: "Keep demo mode" });
    expect(close).toHaveAttribute("type", "button");
    close.focus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(keepDemo).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();

    opener.focus();
    expect(close).toHaveFocus();
    await user.keyboard("{Escape}");

    expect(
      screen.queryByRole("dialog", { name: /connect to screengoblin/i }),
    ).toBeNull();
    expect(container).not.toHaveAttribute("aria-hidden");
    expect(container.inert).not.toBe(true);
    expect(opener).toHaveFocus();
  });

  it("applies dialog focus and Escape restoration to fleet drawers", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/screens"]}>
        <App />
      </MemoryRouter>,
    );
    const opener = screen.getByRole("button", { name: "View Main Lobby" });

    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Main Lobby" });
    expect(dialog).toHaveFocus();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "Main Lobby" })).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("keeps prototype settings read-only while reporting enforced approval accurately", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <App />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", {
        name: "Workspace settings are unavailable",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Immutable ordinary-release approval is enforced by the API/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Proof-of-play collection is not configured or independently verified.",
      ),
    ).toBeTruthy();

    const settingsPanel =
      document.querySelector<HTMLElement>(".settings-panel");
    expect(settingsPanel).not.toBeNull();
    const controls = within(settingsPanel!);
    expect(controls.queryByRole("textbox")).toBeNull();
    expect(controls.queryByRole("spinbutton")).toBeNull();
    expect(controls.queryByRole("combobox")).toBeNull();
    expect(controls.queryByRole("checkbox")).toBeNull();
    expect(controls.queryByRole("button", { name: /save/i })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Security" }));
    expect(
      screen.getByRole("heading", {
        name: "Security settings are unavailable",
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/changes saved/i)).toBeNull();
    expect(screen.queryByText(/stored for this session/i)).toBeNull();
  });

  it("does not expose administrative routes to a live viewer session", () => {
    window.sessionStorage.setItem("sg_access_token", "viewer-token");
    window.sessionStorage.setItem(
      "sg_session_user",
      JSON.stringify({
        id: "viewer-user",
        name: "Viewer",
        email: "viewer@example.test",
        role: "VIEWER",
        organizationId: "org-a",
      }),
    );
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <App />
      </MemoryRouter>,
    );
    expect(
      screen.queryByRole("link", { name: /emergency center/i }),
    ).toBeNull();
    expect(screen.queryByRole("link", { name: /settings/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: /create announcement/i }),
    ).toHaveProperty("disabled", true);
  });

  it("redirects a live viewer who enters an administrative route directly", async () => {
    window.sessionStorage.setItem("sg_access_token", "viewer-token");
    window.sessionStorage.setItem(
      "sg_session_user",
      JSON.stringify({
        id: "viewer-user",
        name: "Viewer",
        email: "viewer@example.test",
        role: "VIEWER",
        organizationId: "org-a",
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    render(
      <MemoryRouter initialEntries={["/emergency"]}>
        <App />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("heading", {
        name: /screen operations overview/i,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/not a life-safety system/i)).toBeNull();
    await waitFor(() =>
      expect(screen.getByText("Live API connection")).toBeTruthy(),
    );
  });
});
