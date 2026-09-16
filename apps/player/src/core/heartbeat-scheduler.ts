import { PlayerApiFailure } from "./api";

export interface HeartbeatSchedule {
  nextHeartbeatSeconds: number;
  serverTime: string;
}

interface HeartbeatSchedulerOptions {
  send: (signal: AbortSignal) => Promise<HeartbeatSchedule>;
  onError?: (reason: unknown) => void | Promise<void>;
  random?: () => number;
  setTimeout?: (callback: () => void, milliseconds: number) => number;
  clearTimeout?: (timer: number) => void;
  now?: () => number;
  initialIntervalSeconds?: number;
  retryBaseSeconds?: number;
  retryMaxSeconds?: number;
}

const MIN_INTERVAL_SECONDS = 5;
const MAX_INTERVAL_SECONDS = 86_400;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

/**
 * Owns one recursive heartbeat timer and at most one request. External wakeups
 * collapse into one pending run, avoiding interval pile-ups after a stalled
 * request or a burst of browser lifecycle events.
 */
export class HeartbeatScheduler {
  private readonly random: () => number;
  private readonly setTimer: (
    callback: () => void,
    milliseconds: number,
  ) => number;
  private readonly clearTimer: (timer: number) => void;
  private readonly now: () => number;
  private readonly retryBaseSeconds: number;
  private readonly retryMaxSeconds: number;
  private timer: number | undefined;
  private timerDueAt: number | undefined;
  private controller: AbortController | undefined;
  private started = false;
  private suspended = false;
  private running = false;
  private wakePending = false;
  private consecutiveFailures = 0;
  private cadenceSeconds: number;
  private notBefore = 0;
  private immediateOnResume = false;

  constructor(private readonly options: HeartbeatSchedulerOptions) {
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimeout ?? window.setTimeout.bind(window);
    this.clearTimer = options.clearTimeout ?? window.clearTimeout.bind(window);
    this.now = options.now ?? (() => performance.now());
    this.cadenceSeconds = this.boundInterval(
      options.initialIntervalSeconds ?? 60,
    );
    this.retryBaseSeconds = Math.max(
      MIN_INTERVAL_SECONDS,
      options.retryBaseSeconds ?? MIN_INTERVAL_SECONDS,
    );
    this.retryMaxSeconds = Math.min(
      MAX_INTERVAL_SECONDS,
      Math.max(this.retryBaseSeconds, options.retryMaxSeconds ?? 300),
    );
  }

  start(active = true, immediate = false): void {
    if (this.started) return;
    this.started = true;
    this.suspended = !active;
    this.immediateOnResume = immediate;
    if (!active) return;
    if (immediate) {
      this.immediateOnResume = false;
      this.requestRun();
    } else {
      this.scheduleCatchUp();
    }
  }

  /** Pause future work and discard a lifecycle wakeup queued while offline. */
  suspend(): void {
    if (!this.started) return;
    this.suspended = true;
    this.wakePending = false;
    this.clearScheduledTimer();
  }

  /** Reconnect within one cadence; repeated reconnect/lifecycle events coalesce. */
  resume(): void {
    if (!this.started) return;
    this.suspended = false;
    if (this.immediateOnResume && this.cooldownRemaining() === 0) {
      this.immediateOnResume = false;
      this.requestRun();
      return;
    }
    this.trigger();
  }

  trigger(): void {
    if (!this.started || this.suspended) return;
    if (this.running) {
      this.wakePending = true;
      return;
    }
    this.scheduleCatchUp();
  }

  stop(): void {
    this.started = false;
    this.suspended = true;
    this.wakePending = false;
    this.clearScheduledTimer();
    this.controller?.abort();
    this.controller = undefined;
    this.immediateOnResume = false;
  }

  private clearScheduledTimer(): void {
    if (this.timer === undefined) return;
    this.clearTimer(this.timer);
    this.timer = undefined;
    this.timerDueAt = undefined;
  }

  private requestRun(): void {
    if (!this.started || this.suspended || this.running) return;
    this.running = true;
    this.controller = new AbortController();
    void this.run(this.controller);
  }

  private jitter(seconds: number): number {
    const boundedRandom = Math.min(1, Math.max(0, this.random()));
    return Math.min(
      MAX_INTERVAL_SECONDS * 1_000,
      Math.round(seconds * (0.9 + boundedRandom * 0.2) * 1_000),
    );
  }

  private boundInterval(seconds: number): number {
    return Math.min(
      MAX_INTERVAL_SECONDS,
      Math.max(MIN_INTERVAL_SECONDS, Math.round(seconds)),
    );
  }

  private catchUpDelay(): number {
    const boundedRandom = Math.min(1, Math.max(0, this.random()));
    return Math.round(this.cadenceSeconds * boundedRandom * 1_000);
  }

  private failureDelay(reason: unknown): number {
    const exponent = Math.max(0, this.consecutiveFailures - 1);
    const backoffSeconds = Math.min(
      this.retryMaxSeconds,
      this.retryBaseSeconds * 2 ** exponent,
    );
    const jitteredBackoff = this.jitter(backoffSeconds);
    // Retry-After is a floor. Never use negative jitter to contact the server
    // before the requested time; long floors are maintained with timer chunks.
    return reason instanceof PlayerApiFailure &&
      reason.retryAfterMs !== undefined &&
      reason.retryAfterMs >= 0
      ? Math.max(reason.retryAfterMs, jitteredBackoff)
      : jitteredBackoff;
  }

  private cooldownRemaining(): number {
    return Math.max(0, this.notBefore - this.now());
  }

  private schedule(milliseconds: number, pullForwardOnly = false): void {
    if (!this.started || this.suspended) return;
    const dueAt = Math.max(
      this.now() + Math.max(0, milliseconds),
      this.notBefore,
    );
    if (
      pullForwardOnly &&
      this.timerDueAt !== undefined &&
      this.timerDueAt <= dueAt
    )
      return;
    this.clearScheduledTimer();
    this.timerDueAt = dueAt;
    this.armTimer(dueAt);
  }

  private armTimer(dueAt: number): void {
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, dueAt - this.now()));
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      if (this.timerDueAt !== dueAt) return;
      if (this.now() < dueAt) {
        this.armTimer(dueAt);
        return;
      }
      this.timerDueAt = undefined;
      this.requestRun();
    }, delay);
  }

  private scheduleCatchUp(): void {
    this.schedule(this.catchUpDelay(), true);
  }

  private async run(controller: AbortController): Promise<void> {
    let delay: number | undefined;
    try {
      const response = await this.options.send(controller.signal);
      this.consecutiveFailures = 0;
      this.notBefore = 0;
      this.cadenceSeconds = this.boundInterval(response.nextHeartbeatSeconds);
      delay = this.jitter(this.cadenceSeconds);
    } catch (reason) {
      if (!controller.signal.aborted) {
        if (reason instanceof PlayerApiFailure && !reason.retryable) {
          this.consecutiveFailures = 0;
          delay = this.jitter(this.cadenceSeconds);
        } else {
          this.consecutiveFailures += 1;
          delay = this.failureDelay(reason);
        }
        this.notBefore = this.now() + delay;
        await this.options.onError?.(reason);
      }
    } finally {
      if (this.controller === controller) this.controller = undefined;
      this.running = false;
    }
    if (!this.started || this.suspended || controller.signal.aborted) return;
    if (this.wakePending) {
      this.wakePending = false;
      this.scheduleCatchUp();
      return;
    }
    if (delay !== undefined) this.schedule(delay);
  }
}
