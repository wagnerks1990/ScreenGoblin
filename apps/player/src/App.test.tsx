import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlayerApiFailure } from "./core/api";
import type { Credentials, PlayerManifest } from "./core/types";
import App from "./App";

const mocks = vi.hoisted(() => ({
  clear: vi.fn(),
  getCredentials: vi.fn(),
  removeAll: vi.fn(),
  recover: vi.fn(),
  stageAndActivate: vi.fn(),
  manifest: vi.fn(),
  heartbeat: vi.fn(),
  hasNativeDeviceIdentity: vi.fn(),
}));

vi.mock("./core/storage", () => ({
  IndexedDbPlayerStore: class {
    getCredentials = mocks.getCredentials;
    putCredentials = vi.fn();
    clear = mocks.clear;
  },
}));

vi.mock("./core/assets", () => ({
  CacheAssetRepository: class {
    removeAll = mocks.removeAll;
  },
}));

vi.mock("./core/manifest", () => ({
  ManifestManager: class {
    recover = mocks.recover;
    stageAndActivate = mocks.stageAndActivate;
  },
}));

vi.mock("./core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./core/api")>();
  return {
    ...actual,
    developmentBearerAllowed: () => true,
    PlayerApi: class {
      manifest = mocks.manifest;
      heartbeat = mocks.heartbeat;
    },
  };
});

vi.mock("./core/device", () => ({
  freeStorageBytes: () => Promise.resolve(1_000_000),
  hasNativeDeviceIdentity: mocks.hasNativeDeviceIdentity,
  installationId: () => Promise.resolve("installation-123"),
  networkType: () => "wifi",
}));

vi.mock("./components/Pairing", () => ({
  Pairing: () => <div>Pair this screen</div>,
}));

vi.mock("./components/Playback", () => ({
  Playback: () => <div>Playing content</div>,
}));

const credentials: Credentials = {
  authMode: "development-bearer",
  installationId: "installation-123",
  screenId: "screen-1",
  deviceToken: "device-token",
  apiBaseUrl: "http://localhost:3000/api/v1/device",
  heartbeatIntervalSeconds: 60,
  manifestVerificationKey: "public-key",
};

const manifest: PlayerManifest = {
  screenId: "screen-1",
  version: "release-1",
  generatedAt: "2026-09-12T00:00:00.000Z",
  validUntil: "2026-09-13T00:00:00.000Z",
  priority: "normal",
  withdrawn: false,
  items: [],
};

beforeEach(() => {
  mocks.clear.mockReset().mockResolvedValue(undefined);
  mocks.getCredentials.mockReset().mockResolvedValue(credentials);
  mocks.removeAll.mockReset().mockResolvedValue(undefined);
  mocks.recover.mockReset().mockResolvedValue(manifest);
  mocks.stageAndActivate.mockReset().mockResolvedValue(manifest);
  mocks.manifest.mockReset().mockResolvedValue(manifest);
  mocks.heartbeat.mockReset().mockResolvedValue(undefined);
  mocks.hasNativeDeviceIdentity.mockReset().mockReturnValue(false);
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
});

afterEach(cleanup);

describe("device revocation", () => {
  it("deprovisions instead of recovering cached content after a manifest 401", async () => {
    mocks.manifest.mockRejectedValue(
      new PlayerApiFailure("revoked", "http", false, 401),
    );

    render(<App />);

    expect(await screen.findByText("Pair this screen")).toBeInTheDocument();
    expect(mocks.clear).toHaveBeenCalledTimes(1);
    expect(mocks.removeAll).toHaveBeenCalledTimes(1);
    expect(mocks.recover).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Playing content")).not.toBeInTheDocument();
  });

  it("deprovisions and removes cached content after a heartbeat 401", async () => {
    mocks.heartbeat.mockRejectedValue(
      new PlayerApiFailure("revoked", "http", false, 401),
    );

    render(<App />);

    await waitFor(() => expect(mocks.heartbeat).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Pair this screen")).toBeInTheDocument();
    expect(mocks.clear).toHaveBeenCalledTimes(1);
    expect(mocks.removeAll).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Playing content")).not.toBeInTheDocument();
  });

  it("purges stale content staged after concurrent heartbeat revocation", async () => {
    let finishStaging!: (value: PlayerManifest) => void;
    mocks.stageAndActivate.mockReturnValue(
      new Promise((resolve) => {
        finishStaging = resolve;
      }),
    );
    mocks.heartbeat.mockRejectedValue(
      new PlayerApiFailure("revoked", "http", false, 401),
    );

    render(<App />);

    expect(await screen.findByText("Pair this screen")).toBeInTheDocument();
    finishStaging(manifest);

    await waitFor(() => expect(mocks.clear).toHaveBeenCalledTimes(2));
    expect(mocks.removeAll).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Playing content")).not.toBeInTheDocument();
  });
});

describe("boot credential validation", () => {
  it("purges orphaned manifests and assets when credentials are absent", async () => {
    mocks.getCredentials.mockResolvedValue(undefined);

    render(<App />);

    expect(await screen.findByText("Pair this screen")).toBeInTheDocument();
    expect(mocks.clear).toHaveBeenCalledTimes(1);
    expect(mocks.removeAll).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Playing content")).not.toBeInTheDocument();
  });

  it("waits for credentials and managed assets to be cleared before pairing", async () => {
    let finishStoreClear!: () => void;
    let finishAssetClear!: () => void;
    mocks.getCredentials.mockResolvedValue({
      authMode: "proof-v1",
      installationId: "different-device",
      screenId: "screen-1",
      credentialId: "credential-1",
      keyId: "different-device",
      apiBaseUrl: "https://signage.example.test/api/v1/device",
      heartbeatIntervalSeconds: 60,
      manifestVerificationKey: "public-key",
    });
    mocks.clear.mockReturnValue(
      new Promise<void>((resolve) => {
        finishStoreClear = resolve;
      }),
    );
    mocks.removeAll.mockReturnValue(
      new Promise<void>((resolve) => {
        finishAssetClear = resolve;
      }),
    );

    render(<App />);

    await waitFor(() => expect(mocks.clear).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Starting player…")).toBeInTheDocument();
    expect(screen.queryByText("Pair this screen")).not.toBeInTheDocument();

    finishStoreClear();
    await Promise.resolve();
    expect(screen.queryByText("Pair this screen")).not.toBeInTheDocument();

    finishAssetClear();
    expect(await screen.findByText("Pair this screen")).toBeInTheDocument();
  });

  it("fails closed when invalid credential cleanup fails", async () => {
    mocks.getCredentials.mockResolvedValue({
      authMode: "proof-v1",
      installationId: "different-device",
      screenId: "screen-1",
      credentialId: "credential-1",
      keyId: "different-device",
      apiBaseUrl: "https://signage.example.test/api/v1/device",
      heartbeatIntervalSeconds: 60,
      manifestVerificationKey: "public-key",
    });
    mocks.clear.mockRejectedValue(new Error("IndexedDB unavailable"));

    render(<App />);

    expect(
      await screen.findByText("Player needs attention"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Player storage could not be opened or securely cleared",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Pair this screen")).not.toBeInTheDocument();
  });
});
