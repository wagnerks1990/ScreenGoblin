import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlayerApi } from "../core/api";
import type { Credentials } from "../core/types";
import { Pairing } from "./Pairing";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
      />,
    );

    await user.type(
      screen.getByLabelText("Six-digit pairing code"),
      "123456{Enter}",
    );

    await waitFor(() => {
      expect(pair).toHaveBeenCalledWith("123456", "installation-123");
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
      />,
    );

    const code = screen.getByLabelText("Six-digit pairing code");
    await user.type(code, "123456{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Pairing code expired",
    );
    expect(code).toHaveValue("123456");
  });
});
