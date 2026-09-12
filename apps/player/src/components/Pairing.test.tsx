import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlayerApi } from "../core/api";
import type { Credentials } from "../core/types";
import { Pairing } from "./Pairing";

const device = vi.hoisted(() => ({
  native: false,
  rotate: vi.fn(),
}));

vi.mock("../core/device", () => ({
  hasNativeDeviceIdentity: () => device.native,
  rotateDeviceIdentity: device.rotate,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const replacementKeyId = "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM";
const savedPairing = {
  version: 1 as const,
  stage: "pending" as const,
  apiBaseUrl: "https://signage.example.test",
  finalBody: '{"saved":true}',
  expectedKeyId: replacementKeyId,
  installationId: replacementKeyId,
  expiresAt: "2099-09-12T00:05:00.000Z",
  approval: {
    status: "pending-approval" as const,
    grantId: "grant123",
    candidateId: "candidate123",
    keyId: replacementKeyId,
    fingerprint: replacementKeyId,
    expiresAt: "2099-09-12T00:05:00.000Z",
  },
};

const credentials: Credentials = {
  authMode: "development-bearer",
  installationId: "installation-123",
  screenId: "screen-1",
  deviceToken: "device-token",
  apiBaseUrl: "https://signage.example.test",
  heartbeatIntervalSeconds: 60,
  manifestVerificationKey: "public-key",
};

describe("player pairing", () => {
  afterEach(() => {
    device.native = false;
    device.rotate.mockReset();
  });

  it("submits a valid pairing code from the keyboard", async () => {
    const user = userEvent.setup();
    const paired = vi.fn();
    const pair = vi
      .spyOn(PlayerApi.prototype, "pair")
      .mockResolvedValue(credentials);
    render(
      <Pairing
        installationId="installation-123"
        defaultApiUrl="https://signage.example.test"
        onPaired={paired}
        onPendingPairing={vi.fn()}
        onDiscardPendingPairing={vi.fn()}
      />,
    );

    await user.type(
      screen.getByLabelText("Six-digit pairing code"),
      "123456{Enter}",
    );

    await waitFor(() => {
      expect(pair).toHaveBeenCalledWith(
        "123456",
        "installation-123",
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          onPending: expect.any(Function),
        }),
      );
      expect(paired).toHaveBeenCalledWith(credentials);
    });
  });

  it("announces pairing failures without discarding the entered code", async () => {
    const user = userEvent.setup();
    vi.spyOn(PlayerApi.prototype, "pair").mockRejectedValue(
      new Error("Pairing code expired"),
    );
    render(
      <Pairing
        installationId="installation-123"
        defaultApiUrl="https://signage.example.test"
        onPaired={vi.fn()}
        onPendingPairing={vi.fn()}
        onDiscardPendingPairing={vi.fn()}
      />,
    );

    const code = screen.getByLabelText("Six-digit pairing code");
    await user.type(code, "123456{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Pairing code expired",
    );
    expect(code).toHaveValue("123456");
  });

  it("rotates identity only from the explicit replacement control", async () => {
    device.native = true;
    device.rotate.mockResolvedValue({
      algorithm: "ES256",
      publicKeySpki:
        "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ",
      keyId: replacementKeyId,
      securityLevel: "strongbox",
    });
    const identityChanged = vi.fn();
    const pair = vi.spyOn(PlayerApi.prototype, "pair").mockResolvedValue({
      ...credentials,
      installationId: replacementKeyId,
    });
    const user = userEvent.setup();
    render(
      <Pairing
        installationId="old-installation"
        defaultApiUrl="https://signage.example.test"
        onPaired={vi.fn()}
        onIdentityChanged={identityChanged}
        onPendingPairing={vi.fn()}
        onDiscardPendingPairing={vi.fn()}
      />,
    );

    expect(device.rotate).not.toHaveBeenCalled();
    const replace = screen.getByRole("button", {
      name: "Replace previous enrollment",
    });
    expect(replace).toBeDisabled();
    await user.click(
      screen.getByLabelText(/I have a targeted replacement code/),
    );
    expect(replace).toBeEnabled();
    await user.click(replace);
    expect(device.rotate).toHaveBeenCalledOnce();
    expect(identityChanged).toHaveBeenCalledWith(replacementKeyId);
    expect(
      screen.getByText(
        `Player ID ${replacementKeyId.slice(0, 8).toUpperCase()}`,
      ),
    ).toBeVisible();

    await user.type(
      screen.getByLabelText("Six-digit pairing code"),
      "123456{Enter}",
    );
    await waitFor(() =>
      expect(pair).toHaveBeenCalledWith(
        "123456",
        replacementKeyId,
        expect.any(Object),
      ),
    );
  });

  it("shows the exact pending fingerprint and lets the operator wait be cancelled", async () => {
    const user = userEvent.setup();
    vi.spyOn(PlayerApi.prototype, "pair").mockImplementation(
      async (_code, _installationId, options) => {
        const approval = {
          status: "pending-approval" as const,
          grantId: "grant123",
          candidateId: "candidate123",
          keyId: replacementKeyId,
          fingerprint: replacementKeyId,
          expiresAt: "2099-09-12T00:05:00.000Z",
        };
        options?.onPending?.(approval, {
          version: 1,
          stage: "pending",
          apiBaseUrl: "https://signage.example.test",
          finalBody: "{}",
          expectedKeyId: replacementKeyId,
          installationId: replacementKeyId,
          expiresAt: approval.expiresAt,
          approval,
        });
        await new Promise<void>((_resolve, reject) =>
          options?.signal?.addEventListener("abort", () =>
            reject(new Error("cancelled")),
          ),
        );
        throw new Error("unreachable");
      },
    );
    render(
      <Pairing
        installationId={replacementKeyId}
        defaultApiUrl="https://signage.example.test"
        onPaired={vi.fn()}
        onPendingPairing={vi.fn()}
        onDiscardPendingPairing={vi.fn()}
      />,
    );

    await user.type(
      screen.getByLabelText("Six-digit pairing code"),
      "123456{Enter}",
    );
    expect(await screen.findByText("Awaiting operator approval")).toBeVisible();
    expect(screen.getByText(replacementKeyId)).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Pause approval wait" }),
    );
    expect(await screen.findByText(/Approval wait paused/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Resume approval wait" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Replace previous enrollment" }),
    ).not.toBeInTheDocument();
  });

  it("automatically resumes a saved exact proof and blocks another rotation", async () => {
    device.native = true;
    const paired = vi.fn();
    const resume = vi
      .spyOn(PlayerApi.prototype, "resumePairing")
      .mockResolvedValue({ ...credentials, installationId: replacementKeyId });

    render(
      <Pairing
        installationId={replacementKeyId}
        defaultApiUrl="https://ignored.example.test"
        pendingPairing={savedPairing}
        onPaired={paired}
        onPendingPairing={vi.fn()}
        onDiscardPendingPairing={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(resume).toHaveBeenCalledWith(
        savedPairing,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(paired).toHaveBeenCalled();
    });
    expect(device.rotate).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Replace previous enrollment" }),
    ).not.toBeInTheDocument();
  });
});
