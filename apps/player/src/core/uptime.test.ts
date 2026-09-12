import { afterEach, describe, expect, it, vi } from "vitest";
import { createMonotonicUptime } from "./uptime";

describe("createMonotonicUptime", () => {
  afterEach(() => vi.useRealTimers());

  it("is unaffected by a backward wall-clock correction", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00.000Z"));
    let monotonicNow = 1_000;
    const uptime = createMonotonicUptime(() => monotonicNow);

    monotonicNow = 4_999;
    vi.setSystemTime(new Date("2026-09-12T11:00:00.000Z"));

    expect(uptime()).toBe(3);
  });

  it("never reports a negative or decreasing value", () => {
    let monotonicNow = 10_000;
    const uptime = createMonotonicUptime(() => monotonicNow);

    monotonicNow = 9_000;
    expect(uptime()).toBe(0);
    monotonicNow = 12_500;
    expect(uptime()).toBe(2);
    monotonicNow = 11_000;
    expect(uptime()).toBe(2);
  });
});
