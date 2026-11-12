import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PasswordRecovery } from "./PasswordRecovery";
import { MailSettings } from "./pages/MailSettings";
import { api, type MailOverview } from "./api";
const overview: MailOverview = {
  configured: true,
  receivingConfigured: true,
  workerHealthy: true,
  offlineMinutes: 10,
  from: "no-reply@signage.example.test",
  inbox: null,
  offlineAlertsEnabled: false,
  jobs: [],
  received: [],
};
afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});
function recovery(confirm = false, enabled: boolean | undefined = true) {
  return render(
    <MemoryRouter>
      <PasswordRecovery confirm={confirm} enabled={enabled} />
    </MemoryRouter>,
  );
}
describe("account recovery privacy and failures", () => {
  it("disables recovery controls when mail is unavailable", () => {
    recovery(false, false);
    expect(screen.getByText(/Contact your administrator/)).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
  it("requests a link only after explicit submission and gives a generic result", async () => {
    const request = vi.spyOn(api, "requestPasswordReset").mockResolvedValue({
      message: "If an eligible account exists, instructions will be emailed.",
    });
    recovery();
    expect(request).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText("Email"), "owner@example.test");
    await userEvent.click(
      screen.getByRole("button", { name: "Email reset link" }),
    );
    expect(request).toHaveBeenCalledWith("owner@example.test");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "If an eligible account exists",
    );
  });
  it("removes the fragment immediately, keeps the capability in memory, and never auto-submits", async () => {
    const token = "a".repeat(43);
    window.history.replaceState(null, "", "/reset-password#token=" + token);
    const confirm = vi.spyOn(api, "confirmPasswordReset").mockResolvedValue();
    recovery(true);
    expect(window.location.hash).toBe("");
    expect(confirm).not.toHaveBeenCalled();
    await userEvent.type(
      screen.getByLabelText("New password"),
      "a new strong password",
    );
    await userEvent.type(
      screen.getByLabelText("Confirm new password"),
      "a new strong password",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Change password" }),
    );
    expect(confirm).toHaveBeenCalledWith(token, "a new strong password");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Password changed",
    );
  });
  it("rejects missing capability and preserves the form on server failure", async () => {
    const confirm = vi.spyOn(api, "confirmPasswordReset");
    recovery(true);
    await userEvent.type(
      screen.getByLabelText("New password"),
      "a new strong password",
    );
    await userEvent.type(
      screen.getByLabelText("Confirm new password"),
      "a new strong password",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Change password" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid");
    expect(confirm).not.toHaveBeenCalled();
  });
  it("shows request failure without substituting success", async () => {
    vi.spyOn(api, "requestPasswordReset").mockRejectedValue(
      new Error("Email is temporarily unavailable"),
    );
    recovery();
    await userEvent.type(screen.getByLabelText("Email"), "owner@example.test");
    await userEvent.click(
      screen.getByRole("button", { name: "Email reset link" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("unavailable");
    expect(
      screen.getByRole("button", { name: "Email reset link" }),
    ).toBeEnabled();
  });
});
describe("tenant mail settings", () => {
  it("does not load mail data without a live session", () => {
    vi.spyOn(api, "hasLiveSession").mockReturnValue(false);
    const load = vi.spyOn(api, "mailOverview");
    render(<MailSettings />);
    expect(load).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Sign in");
  });
  it("offers a retry on load failure without showing example mail", async () => {
    vi.spyOn(api, "hasLiveSession").mockReturnValue(true);
    vi.spyOn(api, "mailOverview").mockRejectedValue(new Error("failed"));
    render(<MailSettings />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "could not be loaded",
    );
    expect(screen.queryByText("Delivery history")).toBeNull();
  });
  it("requires explicit opt-in and explicit self-addressed delivery tests", async () => {
    vi.spyOn(api, "hasLiveSession").mockReturnValue(true);
    vi.spyOn(api, "mailOverview").mockResolvedValue(overview);
    const preference = vi.spyOn(api, "mailPreferences").mockResolvedValue();
    const test = vi
      .spyOn(api, "mailTest")
      .mockResolvedValue({ id: "test-job" });
    render(<MailSettings />);
    const toggle = await screen.findByLabelText(
      "Email offline and recovery alerts to my sign-in address",
    );
    expect(toggle).not.toBeChecked();
    expect(test).not.toHaveBeenCalled();
    await userEvent.click(toggle);
    await userEvent.click(
      screen.getByRole("button", { name: "Save alert preferences" }),
    );
    await waitFor(() => expect(preference).toHaveBeenCalledWith(true));
    await userEvent.click(
      screen.getByRole("button", { name: "Send a test to my account" }),
    );
    await waitFor(() => expect(test).toHaveBeenCalledOnce());
    expect(test.mock.calls[0]).toHaveLength(1);
    expect(test.mock.calls[0]![0]).toMatch(/^[a-f0-9-]{36}$/);
    expect(await screen.findByRole("status")).toHaveTextContent("queued");
  });
  it("keeps the idempotency key after an ambiguous test failure", async () => {
    vi.spyOn(api, "hasLiveSession").mockReturnValue(true);
    vi.spyOn(api, "mailOverview").mockResolvedValue(overview);
    const test = vi
      .spyOn(api, "mailTest")
      .mockRejectedValue(new Error("Result unknown; retry"));
    render(<MailSettings />);
    const button = await screen.findByRole("button", {
      name: "Send a test to my account",
    });
    await userEvent.click(button);
    await screen.findByRole("alert");
    await userEvent.click(button);
    await waitFor(() => expect(test).toHaveBeenCalledTimes(2));
    expect(test.mock.calls[1]![0]).toBe(test.mock.calls[0]![0]);
  });
});
