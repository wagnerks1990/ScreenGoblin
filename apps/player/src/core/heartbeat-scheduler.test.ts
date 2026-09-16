import { afterEach, describe, expect, it, vi } from "vitest";
import { PlayerApiFailure } from "./api";
import { HeartbeatScheduler } from "./heartbeat-scheduler";

const response = (nextHeartbeatSeconds = 60) => ({
  nextHeartbeatSeconds,
  serverTime: "2026-09-16T00:00:00.000Z",
});

const createScheduler = (
  options: ConstructorParameters<typeof HeartbeatScheduler>[0],
) => new HeartbeatScheduler({ ...options, now: () => Date.now() });

afterEach(() => {
  vi.useRealTimers();
});

describe("HeartbeatScheduler", () => {
  it("uses recursive jittered timers and never overlaps a stalled request", async () => {
    vi.useFakeTimers();
    let finishSecond!: () => void;
    const send = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSecond = () => resolve(response());
          }),
      );
    const scheduler = createScheduler({ send, random: () => 0 });

    scheduler.start(true, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(53_999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(180_000);
    expect(send).toHaveBeenCalledTimes(2);
    finishSecond();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(54_000);
    expect(send).toHaveBeenCalledTimes(3);
    scheduler.stop();
  });

  it("coalesces lifecycle and reconnect wakeups into one pending run", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const send = vi.fn(
      () =>
        new Promise<ReturnType<typeof response>>((resolve) => {
          finish = () => resolve(response());
        }),
    );
    const scheduler = createScheduler({ send, random: () => 0.5 });

    scheduler.start(true, true);
    scheduler.trigger();
    scheduler.trigger();
    scheduler.resume();
    expect(send).toHaveBeenCalledTimes(1);

    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("pauses offline, phase-spreads reconnect, and aborts in-flight cleanup", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const send = vi.fn(
      (signal: AbortSignal) =>
        new Promise<ReturnType<typeof response>>(() => {
          observedSignal = signal;
        }),
    );
    const scheduler = createScheduler({
      send,
      initialIntervalSeconds: 20,
      random: () => 0.5,
    });

    scheduler.start(false);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(send).not.toHaveBeenCalled();
    scheduler.resume();
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledOnce();
    expect(observedSignal?.aborted).toBe(false);
    scheduler.stop();
    expect(observedSignal?.aborted).toBe(true);
    scheduler.resume();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    [0, 54_000],
    [0.5, 60_000],
    [1, 66_000],
  ])("bounds cadence jitter for random %s", async (random, delay) => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(response());
    const scheduler = createScheduler({ send, random: () => random });

    scheduler.start(true, true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("uses a newly accepted interval only for later attempts", async () => {
    vi.useFakeTimers();
    const send = vi
      .fn()
      .mockResolvedValueOnce(response(10))
      .mockResolvedValue(response(30));
    const scheduler = createScheduler({ send, random: () => 0.5 });

    scheduler.start(true, true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(3);
    scheduler.stop();
  });

  it("backs off failures with jitter and never violates Retry-After", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new PlayerApiFailure("offline", "network", true))
      .mockRejectedValueOnce(
        new PlayerApiFailure("busy", "http", true, 503, 20_000),
      )
      .mockResolvedValue(response(10));
    const scheduler = createScheduler({
      send,
      onError,
      random: () => 0,
    });

    scheduler.start(true, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4_499);
    expect(send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("phase-spreads a normal process start across the initial cadence", async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(response());
    const scheduler = createScheduler({
      send,
      initialIntervalSeconds: 20,
      random: () => 0.5,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledOnce();
    scheduler.stop();
  });

  it("never lets lifecycle wakeups postpone an earlier healthy cadence", async () => {
    let now = 0;
    let timerCallback!: () => void;
    const setTimeout = vi.fn((callback: () => void, milliseconds: number) => {
      void milliseconds;
      timerCallback = callback;
      return 1;
    });
    const clearTimeout = vi.fn();
    const random = vi.fn().mockReturnValueOnce(0.5).mockReturnValue(1);
    const send = vi.fn().mockResolvedValue(response());
    const scheduler = new HeartbeatScheduler({
      send,
      random,
      now: () => now,
      setTimeout,
      clearTimeout,
    });

    scheduler.start(true, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(setTimeout).toHaveBeenCalledOnce();
    expect(setTimeout.mock.calls[0]?.[1]).toBe(60_000);
    now = 59_000;
    scheduler.trigger();
    scheduler.trigger();
    expect(setTimeout).toHaveBeenCalledOnce();
    expect(clearTimeout).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    now = 60_000;
    timerCallback();
    expect(send).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it.each([
    ["trigger", 120_000],
    ["resume", 120_000],
    ["long-retry-after", 172_800_000],
  ])("preserves the Retry-After floor across %s", async (mode, floor) => {
    vi.useFakeTimers();
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        new PlayerApiFailure("busy", "http", true, 503, floor),
      )
      .mockResolvedValue(response());
    const scheduler = createScheduler({ send, random: () => 0 });

    scheduler.start(true, true);
    await vi.advanceTimersByTimeAsync(0);
    if (mode === "resume") {
      scheduler.suspend();
      await vi.advanceTimersByTimeAsync(10_000);
      scheduler.resume();
      await vi.advanceTimersByTimeAsync(floor - 10_001);
    } else {
      scheduler.trigger();
      await vi.advanceTimersByTimeAsync(floor - 1);
    }
    expect(send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("preserves Retry-After when a wakeup arrives during the failed request", async () => {
    vi.useFakeTimers();
    let reject!: (reason: unknown) => void;
    const send = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, rejectRequest) => {
            reject = rejectRequest;
          }),
      )
      .mockResolvedValue(response());
    const scheduler = createScheduler({ send, random: () => 0 });

    scheduler.start(true, true);
    scheduler.trigger();
    reject(new PlayerApiFailure("busy", "http", true, 503, 120_000));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });
});
