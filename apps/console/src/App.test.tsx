import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { App } from "./App";

describe("ScreenGoblin console", () => {
  it("renders an actionable dashboard with an explicit demo state", async () => {
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <App />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("heading", { name: /good evening/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/demo data/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /screen fleet/i }),
    ).toBeInTheDocument();
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
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("Club Fair — September")).toBeInTheDocument();
  });

  it("opens screen details from the fleet table", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/screens"]}>
        <App />
      </MemoryRouter>,
    );
    await user.click(screen.getByText("Main Lobby"));
    expect(
      screen.getByRole("dialog", { name: "Main Lobby" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Device health")).toBeInTheDocument();
  });

  it("keeps emergency activation disabled in pilot mode", () => {
    render(
      <MemoryRouter initialEntries={["/emergency"]}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByText(/not a life-safety system/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /activation disabled/i }),
    ).toBeDisabled();
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
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });
});
