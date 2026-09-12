import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { Fleet } from "./Fleet";

beforeEach(() => window.sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());

function setLiveSession() {
  window.sessionStorage.setItem("sg_access_token", "live-token");
}

it("keeps authenticated fleet loading and detail states operationally truthful", async () => {
  setLiveSession();
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
  render(<Fleet canManage />);

  expect(screen.getByText("Loading live screen data…")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Loading screens" })).toBeTruthy();
  expect(screen.queryByText("Main Lobby")).toBeNull();

  resolveRequest(
    new Response(
      JSON.stringify({
        data: [
          {
            id: "live-screen",
            name: "Authenticated Fleet Screen",
            location: "Live building",
            status: "online",
            orientation: "landscape",
            resolution: "1920x1080",
            lastSeenAt: "2030-01-01T12:00:00.000Z",
            nowPlayingAssetId: "asset-live",
            uptimeSeconds: 42,
            freeStorageBytes: 1024,
            networkType: "wifi",
            playerVersion: "1.0.0",
            tags: ["live"],
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );

  await user.click(await screen.findByText("Authenticated Fleet Screen"));
  const drawer = screen.getByRole("dialog", {
    name: "Authenticated Fleet Screen",
  });
  expect(within(drawer).getByText("Screen preview unavailable")).toBeTruthy();
  expect(within(drawer).getByText("Player reports")).toBeTruthy();
  expect(within(drawer).getByText("asset-live")).toBeTruthy();
  expect(within(drawer).getByText("wifi")).toBeTruthy();
  expect(within(drawer).getByText("42s")).toBeTruthy();
  expect(within(drawer).getByText("1.0 KiB")).toBeTruthy();
  expect(within(drawer).getAllByText("Not reported").length).toBeGreaterThan(0);
  expect(within(drawer).queryByText("Morning announcements")).toBeNull();
  expect(within(drawer).queryByText("LAST KNOWN GOOD")).toBeNull();
  expect(within(drawer).queryByText("Ethernet · 94 Mbps")).toBeNull();
  expect(within(drawer).queryByText("18.2 GB free")).toBeNull();
  expect(within(drawer).queryByText("48°C")).toBeNull();
  expect(within(drawer).queryByText("12 days, 4 hours")).toBeNull();
  for (const command of ["Screenshot", "Refresh", "Restart", "Clear cache"])
    expect(within(drawer).getByText(command).closest("button")).toBeDisabled();

  await user.click(
    within(drawer).getByRole("button", { name: "Close details" }),
  );
  await user.type(
    screen.getByRole("textbox", { name: "Search screens or locations" }),
    "no match",
  );
  expect(
    screen.getByRole("heading", { name: "No screens match" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("heading", { name: "No screens registered" }),
  ).toBeNull();
});

it("distinguishes a failed authenticated fleet read from an empty inventory", async () => {
  setLiveSession();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

  render(<Fleet canManage />);

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "No demo records were substituted",
  );
  expect(
    screen.getByRole("heading", { name: "Screen data unavailable" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("heading", { name: "No screens registered" }),
  ).toBeNull();
  expect(screen.queryByText("Main Lobby")).toBeNull();
});

it("distinguishes a successful empty live inventory from a failed read", async () => {
  setLiveSession();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );

  render(<Fleet canManage />);

  expect(
    await screen.findByRole("heading", { name: "No screens registered" }),
  ).toBeTruthy();
  expect(screen.getByText("Live API data")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen.queryByRole("heading", { name: "Screen data unavailable" }),
  ).toBeNull();
});
