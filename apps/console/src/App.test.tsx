import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { App } from "./App";

beforeEach(() => window.sessionStorage.clear());

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
});
