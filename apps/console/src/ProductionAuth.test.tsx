import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { api } from "./api";

const user = {
  id: "owner",
  name: "Owner",
  email: "owner@example.test",
  role: "OWNER",
  organizationId: "org-a",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function savedSession() {
  sessionStorage.setItem("sg_access_token", "saved-token");
  sessionStorage.setItem("sg_session_user", JSON.stringify(user));
}
function renderApp(path = "/dashboard") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}
beforeEach(() => {
  sessionStorage.clear();
  vi.stubEnv("DEV", false);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("production console sign-in boundary", () => {
  it.each([
    "/",
    "/dashboard",
    "/media",
    "/playlists",
    "/schedules",
    "/releases",
    "/screens",
    "/settings",
    "/emergency",
  ])(
    "requires sign-in for %s without rendering operational or demo content",
    (path) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      renderApp(path);
      expect(
        screen.getByRole("heading", { name: "Sign in to ScreenGoblin" }),
      ).toBeVisible();
      expect(screen.queryByRole("navigation")).toBeNull();
      expect(
        screen.queryByText(
          /Main Lobby|ScreenGoblin Demo|Screen operations overview|Keep demo mode/,
        ),
      ).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it("does not return demo API results when signed out in production", async () => {
    expect(api.demoAllowed()).toBe(false);
    await expect(api.screens()).rejects.toThrow("Sign in");
    await expect(api.fleet()).rejects.toThrow("Sign in");
  });
  it("keeps rejected credentials on the sign-in screen", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          json({ error: { message: "Email or password is incorrect" } }, 401),
        ),
    );
    renderApp();
    const actor = userEvent.setup();
    await actor.type(screen.getByLabelText("Email"), user.email);
    await actor.type(screen.getByLabelText("Password"), "wrong-password");
    await actor.click(
      screen.getByRole("button", { name: "Sign in", exact: true }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Email or password is incorrect",
    );
    expect(screen.queryByRole("navigation")).toBeNull();
  });
  it("shows bootstrap rotation before allowing any console route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          accessToken: "rotation-token",
          nextAction: "CHANGE_BOOTSTRAP_PASSWORD",
          changeBefore: "2030-01-01T00:00:00.000Z",
        }),
      ),
    );
    renderApp("/screens");
    const actor = userEvent.setup();
    await actor.type(screen.getByLabelText("Email"), user.email);
    await actor.type(screen.getByLabelText("Password"), "temporary-password");
    await actor.click(
      screen.getByRole("button", { name: "Sign in", exact: true }),
    );
    expect(
      await screen.findByRole("heading", { name: "Change bootstrap password" }),
    ).toBeVisible();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(sessionStorage.getItem("sg_access_token")).toBeNull();
  });
  it("opens live data after sign-in and returns to the gate on logout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/auth/login"))
          return json({ accessToken: "live-token", user });
        if (url.endsWith("/auth/logout"))
          return new Response(null, { status: 204 });
        if (url.endsWith("/screens")) return json({ data: [] });
        throw new Error("Unexpected URL");
      }),
    );
    renderApp();
    const actor = userEvent.setup();
    await actor.type(screen.getByLabelText("Email"), user.email);
    await actor.type(screen.getByLabelText("Password"), "owner-password");
    await actor.click(
      screen.getByRole("button", { name: "Sign in", exact: true }),
    );
    expect(await screen.findByRole("navigation")).toBeVisible();
    expect(await screen.findByText(/^Live API data/)).toBeVisible();
    await actor.click(screen.getByRole("button", { name: "Disconnect live" }));
    expect(
      await screen.findByRole("heading", { name: "Sign in to ScreenGoblin" }),
    ).toBeVisible();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(sessionStorage.getItem("sg_access_token")).toBeNull();
  });
  it("checks saved sessions before mounting operational pages", async () => {
    savedSession();
    let release!: (response: Response) => void;
    const validation = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      String(input).endsWith("/auth/me")
        ? validation
        : Promise.resolve(json({ data: [] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderApp();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking your session",
    );
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release(
      json({
        user: {
          sub: user.id,
          email: user.email,
          organizationId: user.organizationId,
          role: user.role,
        },
      }),
    );
    expect(await screen.findByRole("navigation")).toBeVisible();
    expect(await screen.findByText(/^Live API data/)).toBeVisible();
  });
  it.each(["revoked", "offline", "wrong-tenant", "wrong-role", "malformed"])(
    "fails closed for a %s saved session",
    async (scenario) => {
      savedSession();
      const fetchMock = vi.fn(async () => {
        if (scenario === "offline") throw new Error("Offline");
        if (scenario === "revoked")
          return json({ error: { message: "Session revoked" } }, 401);
        return json({
          user:
            scenario === "malformed"
              ? null
              : {
                  sub: user.id,
                  email: user.email,
                  organizationId:
                    scenario === "wrong-tenant" ? "org-b" : user.organizationId,
                  role: scenario === "wrong-role" ? "VIEWER" : user.role,
                },
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      renderApp("/screens");
      expect(screen.queryByRole("navigation")).toBeNull();
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          "saved session could not be verified",
        ),
      );
      expect(screen.queryByRole("navigation")).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
  it("removes the console immediately after an API revokes the session", async () => {
    savedSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/auth/me"))
          return json({
            user: {
              sub: user.id,
              email: user.email,
              organizationId: user.organizationId,
              role: user.role,
            },
          });
        return json({ error: { message: "Session revoked" } }, 401);
      }),
    );
    renderApp();
    await waitFor(() =>
      expect(sessionStorage.getItem("sg_access_token")).toBeNull(),
    );
    expect(
      screen.getByRole("heading", { name: "Sign in to ScreenGoblin" }),
    ).toBeVisible();
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});
