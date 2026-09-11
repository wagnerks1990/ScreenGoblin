import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssetRepository, PlayerManifest } from "../core/types";
import { Playback } from "./Playback";

afterEach(cleanup);

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
});
