import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchSignedDeadline } from "./signed-deadline";

describe("watchSignedDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("catches a forward wall-clock correction within thirty seconds", () => {
    const elapsed = vi.fn();
    watchSignedDeadline(Date.now() + 60 * 60_000, elapsed);

    vi.setSystemTime(new Date("2026-09-12T02:00:00.000Z"));
    vi.advanceTimersByTime(30_000);

    expect(elapsed).toHaveBeenCalledOnce();
  });

  it("expires synchronously when the signed deadline has already passed", () => {
    const elapsed = vi.fn();

    watchSignedDeadline(Date.now() - 1, elapsed);

    expect(elapsed).toHaveBeenCalledOnce();
  });

  it("does not let a backward clock correction extend the original lifetime", () => {
    const elapsed = vi.fn();
    watchSignedDeadline(Date.now() + 60_000, elapsed);

    vi.setSystemTime(new Date("2026-09-11T23:00:00.000Z"));
    vi.advanceTimersByTime(60_000);

    expect(elapsed).toHaveBeenCalledOnce();
  });

  it("preserves long original lifetimes across safe timer-sized chunks", () => {
    const elapsed = vi.fn();
    watchSignedDeadline(Date.now() + 48 * 60 * 60_000, elapsed);

    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    vi.advanceTimersByTime(48 * 60 * 60_000 - 1);
    expect(elapsed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(elapsed).toHaveBeenCalledOnce();
  });

  it("rechecks immediately when a suspended page becomes visible", () => {
    const elapsed = vi.fn();
    watchSignedDeadline(Date.now() + 60 * 60_000, elapsed);

    vi.setSystemTime(new Date("2026-09-12T02:00:00.000Z"));
    document.dispatchEvent(new Event("visibilitychange"));

    expect(elapsed).toHaveBeenCalledOnce();
  });

  it("expires exactly once across competing checks", () => {
    const elapsed = vi.fn();
    watchSignedDeadline(Date.now() + 1_000, elapsed);

    vi.advanceTimersByTime(1_000);
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pageshow"));

    expect(elapsed).toHaveBeenCalledOnce();
  });

  it("cancels timers and lifecycle checks", () => {
    const elapsed = vi.fn();
    const cancel = watchSignedDeadline(Date.now() + 1_000, elapsed);

    cancel();
    vi.setSystemTime(new Date("2026-09-13T00:00:00.000Z"));
    vi.runAllTimers();
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pageshow"));

    expect(elapsed).not.toHaveBeenCalled();
  });
});
