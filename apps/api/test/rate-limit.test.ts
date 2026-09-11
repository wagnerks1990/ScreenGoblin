import { describe, expect, it, vi } from "vitest";
import {
  enforceRateLimitBudget,
  MemoryRateLimitBudget,
  opaqueRateLimitKey,
  RedisRateLimitBudget,
} from "../src/utils/rate-limit.js";

describe("rate-limit storage", () => {
  it("produces stable domain-separated keys without exposing identifiers", () => {
    const secret = "rate-limit-test-secret-that-is-long-enough";
    const email = "private.user@example.test";
    const account = opaqueRateLimitKey(secret, "login-account", email);
    expect(account).toBe(opaqueRateLimitKey(secret, "login-account", email));
    expect(account).not.toContain(email);
    expect(account).not.toBe(opaqueRateLimitKey(secret, "pair-code", email));
  });

  it("enforces independent in-memory budgets for tests and local development", async () => {
    const budget = new MemoryRateLimitBudget();
    await enforceRateLimitBudget(budget, "account:key", 2);
    await enforceRateLimitBudget(budget, "account:key", 2);
    await expect(
      enforceRateLimitBudget(budget, "account:key", 2),
    ).rejects.toMatchObject({ statusCode: 429, code: "RATE_LIMITED" });
    await expect(
      enforceRateLimitBudget(budget, "different:key", 2),
    ).resolves.toBeUndefined();
  });

  it("uses one atomic Redis operation with only an opaque key", async () => {
    const evalCommand = vi.fn().mockResolvedValue([2, 45_000]);
    const budget = new RedisRateLimitBudget({
      eval: evalCommand,
    } as never);
    await expect(
      budget.consume("pair-code:opaque", 5, 60_000),
    ).resolves.toEqual({ allowed: true, retryAfterSeconds: 45 });
    expect(evalCommand).toHaveBeenCalledOnce();
    expect(evalCommand.mock.calls[0]).toEqual([
      expect.any(String),
      1,
      "screengoblin:budget:pair-code:opaque",
      60_000,
    ]);
  });

  it("fails closed when the distributed budget store is unavailable", async () => {
    const budget = {
      consume: vi.fn().mockRejectedValue(new Error("redis unavailable")),
    };
    await expect(
      enforceRateLimitBudget(budget, "opaque", 1),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "RATE_LIMIT_UNAVAILABLE",
    });
  });
});
