import { createHmac } from "node:crypto";
import type { Redis } from "ioredis";
import { ApiError } from "./http.js";

export interface RateLimitBudget {
  consume(
    key: string,
    maximum: number,
    windowMilliseconds: number,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

export const opaqueRateLimitKey = (
  secret: string,
  dimension: string,
  value: string,
): string =>
  `${dimension}:${createHmac("sha256", secret)
    .update(`screengoblin-rate-limit-v1\0${dimension}\0${value}`)
    .digest("base64url")}`;

export class MemoryRateLimitBudget implements RateLimitBudget {
  private readonly counters = new Map<
    string,
    { count: number; expiresAt: number }
  >();

  async consume(key: string, maximum: number, windowMilliseconds: number) {
    const now = Date.now();
    const existing = this.counters.get(key);
    const counter =
      existing && existing.expiresAt > now
        ? existing
        : { count: 0, expiresAt: now + windowMilliseconds };
    counter.count += 1;
    this.counters.set(key, counter);
    return {
      allowed: counter.count <= maximum,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((counter.expiresAt - now) / 1000),
      ),
    };
  }
}

const REDIS_BUDGET_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return { current, ttl }
`;

export class RedisRateLimitBudget implements RateLimitBudget {
  constructor(private readonly redis: Redis) {}

  async consume(key: string, maximum: number, windowMilliseconds: number) {
    const result = (await this.redis.eval(
      REDIS_BUDGET_SCRIPT,
      1,
      `screengoblin:budget:${key}`,
      windowMilliseconds,
    )) as [number, number];
    const [current, ttl] = result;
    return {
      allowed: current <= maximum,
      retryAfterSeconds: Math.max(1, Math.ceil(ttl / 1000)),
    };
  }
}

export const enforceRateLimitBudget = async (
  budget: RateLimitBudget,
  key: string,
  maximum: number,
  windowMilliseconds = 60_000,
): Promise<void> => {
  let result: Awaited<ReturnType<RateLimitBudget["consume"]>>;
  try {
    result = await budget.consume(key, maximum, windowMilliseconds);
  } catch {
    throw new ApiError(
      503,
      "RATE_LIMIT_UNAVAILABLE",
      "Request protection is temporarily unavailable",
    );
  }
  if (!result.allowed)
    throw new ApiError(429, "RATE_LIMITED", "Rate limit exceeded");
};
