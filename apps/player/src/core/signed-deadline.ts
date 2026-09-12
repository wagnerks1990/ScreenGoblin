const MAX_WALL_CLOCK_CHECK_MS = 30_000;
const MAX_TIMER_DELAY_MS = 24 * 60 * 60_000;

export interface SignedDeadlineWatcherOptions {
  wallClockTarget?: Document;
  lifecycleTarget?: Window;
}

/**
 * Enforces a signed wall-clock deadline without allowing a later clock
 * correction to extend the lifetime calculated when the watcher was created.
 *
 * Wall-clock polling catches forward corrections. The independent fail-safe
 * countdown catches backward corrections, and lifecycle checks close the gap
 * promptly after a suspended WebView resumes.
 */
export function watchSignedDeadline(
  deadline: number,
  onElapsed: () => void,
  options: SignedDeadlineWatcherOptions = {},
): () => void {
  if (!Number.isFinite(deadline)) throw new Error("Deadline must be finite");

  const wallClockTarget = options.wallClockTarget ?? document;
  const lifecycleTarget = options.lifecycleTarget ?? window;
  const initialRemaining = Math.max(0, deadline - Date.now());
  let wallTimer: number | undefined;
  let failSafeTimer: number | undefined;
  let failSafeRemaining = initialRemaining;
  let finished = false;

  const removeListeners = () => {
    wallClockTarget.removeEventListener("visibilitychange", checkWallClock);
    lifecycleTarget.removeEventListener("pageshow", checkWallClock);
  };

  const cancelTimers = () => {
    if (wallTimer !== undefined) window.clearTimeout(wallTimer);
    if (failSafeTimer !== undefined) window.clearTimeout(failSafeTimer);
    wallTimer = undefined;
    failSafeTimer = undefined;
  };

  const expire = () => {
    if (finished) return;
    finished = true;
    cancelTimers();
    removeListeners();
    onElapsed();
  };

  function checkWallClock() {
    if (finished) return;
    if (wallTimer !== undefined) window.clearTimeout(wallTimer);
    wallTimer = undefined;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      expire();
      return;
    }
    wallTimer = window.setTimeout(
      checkWallClock,
      Math.min(remaining, MAX_WALL_CLOCK_CHECK_MS),
    );
  }

  const scheduleFailSafe = () => {
    if (finished) return;
    if (failSafeRemaining <= 0) {
      expire();
      return;
    }
    const delay = Math.min(failSafeRemaining, MAX_TIMER_DELAY_MS);
    failSafeTimer = window.setTimeout(() => {
      failSafeTimer = undefined;
      failSafeRemaining -= delay;
      scheduleFailSafe();
    }, delay);
  };

  wallClockTarget.addEventListener("visibilitychange", checkWallClock);
  lifecycleTarget.addEventListener("pageshow", checkWallClock);
  checkWallClock();
  scheduleFailSafe();

  return () => {
    if (finished) return;
    finished = true;
    cancelTimers();
    removeListeners();
  };
}
