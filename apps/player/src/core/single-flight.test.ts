import { describe, expect, it, vi } from "vitest";
import { SingleFlight } from "./single-flight";

describe("SingleFlight", () => {
  it("does not start a stale overlapping synchronization", async () => {
    let release: (() => void) | undefined;
    const firstTask = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const staleTask = vi.fn().mockResolvedValue(undefined);
    const flight = new SingleFlight();

    const first = flight.run(firstTask);
    await expect(flight.run(staleTask)).resolves.toBe(false);
    expect(staleTask).not.toHaveBeenCalled();
    release?.();
    await expect(first).resolves.toBe(true);
    await expect(flight.run(staleTask)).resolves.toBe(true);
  });

  it("releases the guard after a failure", async () => {
    const flight = new SingleFlight();
    await expect(
      flight.run(async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    await expect(flight.run(async () => undefined)).resolves.toBe(true);
  });
});
