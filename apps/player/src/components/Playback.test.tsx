import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssetRepository, PlayerManifest } from "../core/types";
import { Playback } from "./Playback";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const manifest: PlayerManifest = {
  version: "manifest-1",
  generatedAt: "2026-09-11T12:00:00.000Z",
  validUntil: "2026-09-11T14:00:00.000Z",
  screenId: "screen-1",
  priority: "normal",
  items: [
    {
      id: "asset-1",
      kind: "image",
      url: "https://media.example.test/asset.png",
      mimeType: "image/png",
      checksumSha256: "abc",
      sizeBytes: 3,
      durationSeconds: 30,
    },
  ],
};

function repository(resolve: () => Promise<string>): AssetRepository {
  return {
    prefetch: vi.fn(),
    resolve: vi.fn(resolve),
    removeAll: vi.fn(),
  };
}

describe("player playback state", () => {
  it("announces offline and saved-schedule states", () => {
    const { rerender } = render(
      <Playback
        manifest={manifest}
        assets={repository(async () => "https://media.example.test/asset.png")}
        offline
        fallback={false}
        identify={false}
        onPlaying={vi.fn()}
        onPlaybackError={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Offline");

    rerender(
      <Playback
        manifest={manifest}
        assets={repository(async () => "https://media.example.test/asset.png")}
        offline={false}
        fallback
        identify={false}
        onPlaying={vi.fn()}
        onPlaybackError={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Playing saved schedule",
    );
  });

  it("announces emergency playback immediately", () => {
    render(
      <Playback
        manifest={{ ...manifest, priority: "emergency" }}
        assets={repository(async () => "https://media.example.test/asset.png")}
        offline={false}
        fallback={false}
        identify={false}
        onPlaying={vi.fn()}
        onPlaybackError={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Emergency message");
  });

  it("reports asset resolution failures to the recovery controller", async () => {
    const playbackError = vi.fn();
    render(
      <Playback
        manifest={manifest}
        assets={repository(async () => {
          throw new Error("Cached asset is missing");
        })}
        offline={false}
        fallback={false}
        identify={false}
        onPlaying={vi.fn()}
        onPlaybackError={playbackError}
      />,
    );

    await waitFor(() => expect(playbackError).toHaveBeenCalledOnce());
  });

  it("recovers when an item never reaches render readiness", async () => {
    vi.useFakeTimers();
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    let resolveAsset: ((url: string) => void) | undefined;
    const playbackError = vi.fn();
    const { container } = render(
      <Playback
        manifest={manifest}
        assets={repository(
          () =>
            new Promise<string>((resolve) => {
              resolveAsset = resolve;
            }),
        )}
        offline={false}
        fallback={false}
        identify={false}
        onPlaying={vi.fn()}
        onPlaybackError={playbackError}
      />,
    );

    await act(() => vi.advanceTimersByTimeAsync(29_999));
    expect(playbackError).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(playbackError).toHaveBeenCalledOnce();

    resolveAsset?.("blob:too-late");
    await act(async () => undefined);
    expect(container.querySelector("img")).toBeNull();
    expect(revoke).toHaveBeenCalledWith("blob:too-late");
  });

  it("fails safely for an empty recovered manifest", async () => {
    const playbackError = vi.fn();
    const { container } = render(
      <Playback
        manifest={{ ...manifest, items: [] }}
        assets={repository(async () => "unused")}
        offline={false}
        fallback={false}
        identify={false}
        onPlaying={vi.fn()}
        onPlaybackError={playbackError}
      />,
    );

    expect(container.querySelector("main.playback")).not.toBeNull();
    await waitFor(() => expect(playbackError).toHaveBeenCalledOnce());
  });

  it("blanks the prior source while a new item generation resolves", async () => {
    let resolveSecond: ((url: string) => void) | undefined;
    const assets: AssetRepository = {
      prefetch: vi.fn(),
      resolve: vi
        .fn()
        .mockResolvedValueOnce("blob:first")
        .mockImplementationOnce(
          () =>
            new Promise<string>((resolve) => {
              resolveSecond = resolve;
            }),
        ),
      removeAll: vi.fn(),
    };
    const secondManifest = {
      ...manifest,
      version: "manifest-2",
      items: [{ ...manifest.items[0]!, id: "asset-2" }],
    };
    const { container, rerender } = render(
      <Playback
        manifest={manifest}
        assets={assets}
        offline={false}
        fallback={false}
        identify={false}
        onPlaying={vi.fn()}
        onPlaybackError={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector("img")).toHaveAttribute(
        "src",
        "blob:first",
      ),
    );

    rerender(
      <Playback
        manifest={secondManifest}
        assets={assets}
        offline={false}
        fallback={false}
        identify={false}
        onPlaying={vi.fn()}
        onPlaybackError={vi.fn()}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    resolveSecond?.("blob:second");
    await waitFor(() =>
      expect(container.querySelector("img")).toHaveAttribute(
        "src",
        "blob:second",
      ),
    );
  });

  it.each([
    ["image", "img", "load"],
    ["video", "video", "playing"],
  ] as const)(
    "reports %s playback only after the element is ready",
    async (kind, selector, event) => {
      const playing = vi.fn();
      const current = {
        ...manifest,
        items: [{ ...manifest.items[0]!, kind }],
      };
      const { container } = render(
        <Playback
          manifest={current}
          assets={repository(async () => "https://media.example.test/item")}
          offline={false}
          fallback={false}
          identify={false}
          onPlaying={playing}
          onPlaybackError={vi.fn()}
        />,
      );
      await waitFor(() =>
        expect(container.querySelector(selector)).not.toBeNull(),
      );
      expect(playing).not.toHaveBeenCalled();
      fireEvent(container.querySelector(selector)!, new Event(event));
      expect(playing).toHaveBeenCalledOnce();
      expect(playing).toHaveBeenCalledWith("asset-1");
    },
  );

  it("fails closed if legacy web content reaches the renderer", async () => {
    const playbackError = vi.fn();
    const assets = repository(async () => "https://media.example.test/page");
    const { container } = render(
      <Playback
        manifest={{
          ...manifest,
          items: [{ ...manifest.items[0]!, kind: "web" }],
        }}
        assets={assets}
        offline={false}
        fallback={false}
        identify={false}
        onPlaying={vi.fn()}
        onPlaybackError={playbackError}
      />,
    );

    await waitFor(() => expect(playbackError).toHaveBeenCalledOnce());
    expect(assets.resolve).not.toHaveBeenCalled();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("reports template playback only after validated content renders", async () => {
    const playing = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            title: "Weather alert",
            message: "Stay inside",
            backgroundColor: "#c1121f",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const { container } = render(
      <Playback
        manifest={{
          ...manifest,
          items: [
            {
              ...manifest.items[0]!,
              kind: "template",
              mimeType: "application/vnd.screengoblin.emergency+json",
            },
          ],
        }}
        assets={repository(async () => "blob:template")}
        offline={false}
        fallback={false}
        identify={false}
        onPlaying={playing}
        onPlaybackError={vi.fn()}
      />,
    );

    expect(playing).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("heading", { name: "Weather alert" }),
    ).toBeVisible();
    expect(
      container.querySelector(".emergency-template-background rect"),
    ).toHaveAttribute("fill", "#c1121f");
    await waitFor(() => expect(playing).toHaveBeenCalledWith("asset-1"));
  });

  it("rejects malformed template presentation fields", async () => {
    const playbackError = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            title: "Alert",
            message: "Stay inside",
            backgroundColor: "url(https://untrusted.example/image)",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    render(
      <Playback
        manifest={{
          ...manifest,
          items: [{ ...manifest.items[0]!, kind: "template" }],
        }}
        assets={repository(async () => "blob:template")}
        offline={false}
        fallback={false}
        identify={false}
        onPlaying={vi.fn()}
        onPlaybackError={playbackError}
      />,
    );

    await waitFor(() => expect(playbackError).toHaveBeenCalledOnce());
    expect(screen.queryByRole("heading", { name: "Alert" })).toBeNull();
  });

  it("ignores a late resolution from a replaced release", async () => {
    let resolveFirst: ((url: string) => void) | undefined;
    const assets: AssetRepository = {
      prefetch: vi.fn(),
      resolve: vi.fn((asset) =>
        asset.id === "asset-1"
          ? new Promise<string>((resolve) => {
              resolveFirst = resolve;
            })
          : Promise.resolve("blob:current"),
      ),
      removeAll: vi.fn(),
    };
    const playing = vi.fn();
    const current = {
      ...manifest,
      version: "manifest-2",
      items: [{ ...manifest.items[0]!, id: "asset-2" }],
    };
    const { container, rerender } = render(
      <Playback
        manifest={manifest}
        assets={assets}
        offline={false}
        fallback={false}
        identify={false}
        onPlaying={playing}
        onPlaybackError={vi.fn()}
      />,
    );
    rerender(
      <Playback
        manifest={current}
        assets={assets}
        offline={false}
        fallback={false}
        identify={false}
        onPlaying={playing}
        onPlaybackError={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector("img")).toHaveAttribute(
        "src",
        "blob:current",
      ),
    );
    resolveFirst?.("blob:stale");
    await act(async () => undefined);
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "blob:current",
    );
    expect(playing).not.toHaveBeenCalled();
  });

  it("ignores a late resolution failure after unmount", async () => {
    let rejectResolution: ((reason: Error) => void) | undefined;
    const playbackError = vi.fn();
    const { unmount } = render(
      <Playback
        manifest={manifest}
        assets={repository(
          () =>
            new Promise<string>((_resolve, reject) => {
              rejectResolution = reject;
            }),
        )}
        offline={false}
        fallback={false}
        identify={false}
        onPlaying={vi.fn()}
        onPlaybackError={playbackError}
      />,
    );

    unmount();
    rejectResolution?.(new Error("late cache failure"));
    await act(async () => undefined);
    expect(playbackError).not.toHaveBeenCalled();
  });

  it("does not restart playback for a same-version envelope refresh", async () => {
    const assets = repository(async () => "blob:stable");
    const playing = vi.fn();
    const { container, rerender } = render(
      <Playback
        manifest={manifest}
        assets={assets}
        offline={false}
        fallback={false}
        identify={false}
        onPlaying={playing}
        onPlaybackError={vi.fn()}
      />,
    );
    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    fireEvent.load(container.querySelector("img")!);
    expect(playing).toHaveBeenCalledOnce();

    rerender(
      <Playback
        manifest={{
          ...manifest,
          generatedAt: "2026-09-11T12:01:00.000Z",
          validUntil: "2026-09-11T14:01:00.000Z",
          items: manifest.items.map((item) => ({ ...item })),
        }}
        assets={assets}
        offline={false}
        fallback={false}
        identify={false}
        onPlaying={playing}
        onPlaybackError={vi.fn()}
      />,
    );

    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "blob:stable",
    );
    expect(assets.resolve).toHaveBeenCalledOnce();
    expect(playing).toHaveBeenCalledOnce();
  });

  it("restarts a new semantic release at its first item", async () => {
    const assets: AssetRepository = {
      prefetch: vi.fn(),
      resolve: vi.fn(async (asset) => `https://media.example.test/${asset.id}`),
      removeAll: vi.fn(),
    };
    const firstRelease = {
      ...manifest,
      items: [
        { ...manifest.items[0]!, id: "old-1", kind: "video" as const },
        { ...manifest.items[0]!, id: "old-2", kind: "video" as const },
      ],
    };
    const secondRelease = {
      ...firstRelease,
      version: "manifest-2",
      items: [
        { ...manifest.items[0]!, id: "new-1", kind: "video" as const },
        { ...manifest.items[0]!, id: "new-2", kind: "video" as const },
      ],
    };
    const { container, rerender } = render(
      <Playback
        manifest={firstRelease}
        assets={assets}
        offline={false}
        fallback={false}
        identify={false}
        onPlaying={vi.fn()}
        onPlaybackError={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector("video")).toHaveAttribute(
        "src",
        "https://media.example.test/old-1",
      ),
    );
    fireEvent.ended(container.querySelector("video")!);
    await waitFor(() =>
      expect(container.querySelector("video")).toHaveAttribute(
        "src",
        "https://media.example.test/old-2",
      ),
    );

    rerender(
      <Playback
        manifest={secondRelease}
        assets={assets}
        offline={false}
        fallback={false}
        identify={false}
        onPlaying={vi.fn()}
        onPlaybackError={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector("video")).toHaveAttribute(
        "src",
        "https://media.example.test/new-1",
      ),
    );
  });

  it("starts item duration only after readiness", async () => {
    vi.useFakeTimers();
    const assets: AssetRepository = {
      prefetch: vi.fn(),
      resolve: vi
        .fn()
        .mockResolvedValueOnce("blob:first")
        .mockResolvedValueOnce("blob:second"),
      removeAll: vi.fn(),
    };
    const playlist = {
      ...manifest,
      items: [
        { ...manifest.items[0]!, durationSeconds: 1 },
        { ...manifest.items[0]!, id: "asset-2", durationSeconds: 1 },
      ],
    };
    const { container } = render(
      <Playback
        manifest={playlist}
        assets={assets}
        offline={false}
        fallback={false}
        identify={false}
        onPlaying={vi.fn()}
        onPlaybackError={vi.fn()}
      />,
    );
    await act(async () => undefined);
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(assets.resolve).toHaveBeenCalledOnce();

    fireEvent.load(container.querySelector("img")!);
    await act(async () => undefined);
    await act(() => vi.advanceTimersByTimeAsync(999));
    expect(assets.resolve).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(assets.resolve).toHaveBeenCalledTimes(2);
  });

  it("allows only one advance when video end and duration coincide", async () => {
    vi.useFakeTimers();
    const assets: AssetRepository = {
      prefetch: vi.fn(),
      resolve: vi.fn(async (asset) => `blob:${asset.id}`),
      removeAll: vi.fn(),
    };
    const playlist = {
      ...manifest,
      items: [
        { ...manifest.items[0]!, kind: "video" as const, durationSeconds: 1 },
        {
          ...manifest.items[0]!,
          id: "asset-2",
          kind: "video" as const,
          durationSeconds: 1,
        },
        {
          ...manifest.items[0]!,
          id: "asset-3",
          kind: "video" as const,
          durationSeconds: 1,
        },
      ],
    };
    const { container } = render(
      <Playback
        manifest={playlist}
        assets={assets}
        offline={false}
        fallback={false}
        identify={false}
        onPlaying={vi.fn()}
        onPlaybackError={vi.fn()}
      />,
    );
    await act(async () => undefined);
    const firstVideo = container.querySelector("video")!;
    fireEvent.playing(firstVideo);
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    fireEvent.ended(firstVideo);
    await act(async () => undefined);
    expect(assets.resolve).toHaveBeenCalledTimes(2);
    expect(assets.resolve).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "asset-2" }),
    );
  });

  it("restarts a single-item video after it ends", async () => {
    const assets: AssetRepository = {
      prefetch: vi.fn(),
      resolve: vi
        .fn()
        .mockResolvedValueOnce("blob:first-cycle")
        .mockResolvedValueOnce("blob:second-cycle"),
      removeAll: vi.fn(),
    };
    const videoManifest = {
      ...manifest,
      items: [{ ...manifest.items[0]!, kind: "video" as const }],
    };
    const { container } = render(
      <Playback
        manifest={videoManifest}
        assets={assets}
        offline={false}
        fallback={false}
        identify={false}
        onPlaying={vi.fn()}
        onPlaybackError={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(container.querySelector("video")).toHaveAttribute(
        "src",
        "blob:first-cycle",
      ),
    );
    fireEvent.ended(container.querySelector("video")!);
    await waitFor(() =>
      expect(container.querySelector("video")).toHaveAttribute(
        "src",
        "blob:second-cycle",
      ),
    );
    expect(assets.resolve).toHaveBeenCalledTimes(2);
  });

  it("reports repeated media errors only once", async () => {
    const playbackError = vi.fn();
    const { container } = render(
      <Playback
        manifest={manifest}
        assets={repository(async () => "blob:broken")}
        offline={false}
        fallback={false}
        identify={false}
        onPlaying={vi.fn()}
        onPlaybackError={playbackError}
      />,
    );
    const image = await waitFor(() => {
      const value = container.querySelector("img");
      expect(value).not.toBeNull();
      return value!;
    });
    fireEvent.error(image);
    fireEvent.error(image);
    expect(playbackError).toHaveBeenCalledOnce();
  });

  it("revokes an active blob exactly once when playback fails", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const { container, unmount } = render(
      <Playback
        manifest={manifest}
        assets={repository(async () => "blob:broken")}
        offline={false}
        fallback={false}
        identify={false}
        onPlaying={vi.fn()}
        onPlaybackError={vi.fn()}
      />,
    );
    const image = await waitFor(() => {
      const value = container.querySelector("img");
      expect(value).not.toBeNull();
      return value!;
    });

    fireEvent.error(image);
    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("blob:broken");
    unmount();
    expect(revoke).toHaveBeenCalledOnce();
  });
});
