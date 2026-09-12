/**
 * Returns whole elapsed seconds from a monotonic clock.
 *
 * Player uptime is telemetry, not wall-clock time. Using performance.now()
 * prevents NTP or manual clock corrections from producing a negative value.
 */
export function createMonotonicUptime(
  now: () => number = () => performance.now(),
): () => number {
  const startedAt = now();
  let previous = 0;

  return () => {
    const elapsed = Math.max(0, Math.floor((now() - startedAt) / 1_000));
    previous = Math.max(previous, elapsed);
    return previous;
  };
}
