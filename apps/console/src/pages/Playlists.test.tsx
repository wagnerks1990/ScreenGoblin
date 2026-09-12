import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Playlists } from "./Playlists";

beforeEach(() => {
  window.sessionStorage.clear();
  window.sessionStorage.setItem("sg_access_token", "live-token");
});
afterEach(() => vi.unstubAllGlobals());

it("renders authenticated playlist definitions without fixture or assignment claims", async () => {
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
  render(<Playlists />);

  expect(screen.getByText("Loading live playlist data…")).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "Loading playlists" }),
  ).toBeTruthy();
  expect(screen.queryByText("High School Hallways")).toBeNull();

  resolveRequest(
    new Response(
      JSON.stringify({
        data: [
          {
            id: "playlist-live",
            name: "Authenticated rotation",
            description: "API description",
            items: [
              {
                id: "item-1",
                assetId: "asset-exact",
                position: 0,
                durationSeconds: 17,
              },
            ],
            createdAt: "2030-01-01T00:00:00.000Z",
            updatedAt: "2030-01-02T00:00:00.000Z",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );

  expect(await screen.findByText("Authenticated rotation")).toBeTruthy();
  expect(screen.getByText("API description")).toBeTruthy();
  expect(screen.getByText("17s")).toBeTruthy();
  await user.click(
    screen.getByRole("button", { name: "View Authenticated rotation" }),
  );
  const drawer = screen.getByRole("dialog", { name: "Authenticated rotation" });
  expect(within(drawer).getByText("Asset ID: asset-exact")).toBeTruthy();
  expect(within(drawer).getByText("Position 0 · 17s")).toBeTruthy();
  expect(document.body).not.toHaveTextContent("Assigned to");
  expect(screen.queryByText("High School Hallways")).toBeNull();
  expect(screen.queryByRole("button", { name: /new playlist/i })).toBeNull();
  expect(screen.queryByRole("button", { name: /preview/i })).toBeNull();
  expect(screen.queryByRole("button", { name: /edit playlist/i })).toBeNull();
  expect(screen.queryByRole("button", { name: /more options/i })).toBeNull();

  await user.click(
    within(drawer).getByRole("button", { name: "Close details" }),
  );
  await user.type(
    screen.getByRole("textbox", { name: "Search playlists" }),
    "missing",
  );
  expect(
    screen.getByRole("heading", { name: "No playlists match" }),
  ).toBeTruthy();
});

it("distinguishes authenticated playlist errors from successful empty data", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("offline")));
  const { unmount } = render(<Playlists />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "No demo records were substituted",
  );
  expect(
    screen.getByRole("heading", { name: "Playlist data unavailable" }),
  ).toBeTruthy();
  expect(screen.queryByText("High School Hallways")).toBeNull();
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
  render(<Playlists />);
  expect(
    await screen.findByRole("heading", { name: "No playlists" }),
  ).toBeTruthy();
  expect(screen.getByText("Live API data")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});
