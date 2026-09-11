import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, vi } from "vitest";
import { App } from "./App";

beforeEach(() => window.sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("ScreenGoblin console", () => {
  it("renders an actionable dashboard with an explicit demo state", async () => {
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <App />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("heading", { name: /screen operations overview/i }),
    ).toBeTruthy();
    expect(screen.getByText(/demo data/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /screen fleet/i })).toBeTruthy();
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
    expect(screen.getByText("Device health")).toBeTruthy();
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

  it("focuses dialogs, closes them with Escape, and restores the opener", async () => {
    const user = userEvent.setup();
    render(
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
    await user.keyboard("{Escape}");

    expect(
      screen.queryByRole("dialog", { name: /connect to screengoblin/i }),
    ).toBeNull();
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

  it("does not expose administrative routes to a live viewer session", () => {
    window.sessionStorage.setItem("sg_access_token", "viewer-token");
    window.sessionStorage.setItem(
      "sg_session_user",
      JSON.stringify({
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
