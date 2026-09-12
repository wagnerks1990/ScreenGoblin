import type { Credentials, Heartbeat, PlayerManifest } from "./types";
import { verifyManifestSignature } from "./crypto";

const trim = (url: string) => url.replace(/\/+$/, "");

export type PlayerApiFailureKind =
  "aborted" | "timeout" | "network" | "http" | "protocol";

/** A stable error contract callers can use without matching display strings. */
export class PlayerApiFailure extends Error {
  constructor(
    message: string,
    readonly kind: PlayerApiFailureKind,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PlayerApiFailure";
  }
}

export interface PlayerRequestOptions {
  /** Allows a future single-flight owner to cancel work it no longer needs. */
  signal?: AbortSignal;
}

export interface PlayerApiOptions {
  requestTimeoutMs?: number;
  manifestMaxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const defaults = {
  requestTimeoutMs: 10_000,
  manifestMaxAttempts: 3,
  retryBaseDelayMs: 500,
  retryMaxDelayMs: 5_000,
} as const;

const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);

const parseRetryAfter = (value: string | null, now = Date.now()) => {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
};

export class PlayerApi {
  private readonly options: Required<PlayerApiOptions>;

  constructor(
    private readonly apiBaseUrl: string,
    private readonly token?: string,
    private readonly screenId?: string,
    private readonly manifestVerificationKey?: string,
    options: PlayerApiOptions = {},
  ) {
    this.options = {
      requestTimeoutMs: options.requestTimeoutMs ?? defaults.requestTimeoutMs,
      manifestMaxAttempts:
        options.manifestMaxAttempts ?? defaults.manifestMaxAttempts,
      retryBaseDelayMs: options.retryBaseDelayMs ?? defaults.retryBaseDelayMs,
      retryMaxDelayMs: options.retryMaxDelayMs ?? defaults.retryMaxDelayMs,
      random: options.random ?? Math.random,
      sleep:
        options.sleep ??
        ((milliseconds) =>
          new Promise((resolve) => window.setTimeout(resolve, milliseconds))),
    };
    if (
      this.options.requestTimeoutMs <= 0 ||
      this.options.manifestMaxAttempts < 1 ||
      this.options.retryBaseDelayMs < 0 ||
      this.options.retryMaxDelayMs < 0
    )
      throw new RangeError("Player API timing options are out of range");
  }

  private async attempt<T>(
    path: string,
    init: RequestInit,
    options: PlayerRequestOptions,
  ): Promise<T> {
    if (options.signal?.aborted)
      throw new PlayerApiFailure(
        "Player API request was cancelled",
        "aborted",
        false,
      );

    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    let timeoutId: number | undefined;
    let didTimeout = false;
    const timedOut = new Promise<never>((_, reject) => {
      timeoutId = window.setTimeout(() => {
        didTimeout = true;
        controller.abort();
        reject(
          new PlayerApiFailure(
            `Player API request timed out after ${this.options.requestTimeoutMs}ms`,
            "timeout",
            true,
          ),
        );
      }, this.options.requestTimeoutMs);
    });

    const headers = new Headers(init.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (!headers.has("Content-Type"))
      headers.set("Content-Type", "application/json");
    if (this.token) headers.set("X-Device-Token", this.token);
    if (this.screenId) headers.set("X-Screen-Id", this.screenId);

    try {
      const response = await Promise.race([
        fetch(`${trim(this.apiBaseUrl)}${path}`, {
          ...init,
          headers,
          signal: controller.signal,
        }),
        timedOut,
      ]);
      if (!response.ok) {
        const retryable = retryableStatuses.has(response.status);
        const retryAfterMs = retryable
          ? parseRetryAfter(response.headers.get("Retry-After"))
          : undefined;
        throw new PlayerApiFailure(
          `Player API returned HTTP ${response.status}`,
          "http",
          retryable,
          response.status,
          retryAfterMs,
        );
      }
      if (response.status === 204) return undefined as T;
      try {
        return (await response.json()) as T;
      } catch (cause) {
        throw new PlayerApiFailure(
          "Player API returned an invalid JSON response",
          "protocol",
          false,
          response.status,
          undefined,
          { cause },
        );
      }
    } catch (cause) {
      if (cause instanceof PlayerApiFailure) throw cause;
      if (didTimeout)
        throw new PlayerApiFailure(
          `Player API request timed out after ${this.options.requestTimeoutMs}ms`,
          "timeout",
          true,
          undefined,
          undefined,
          { cause },
        );
      if (options.signal?.aborted)
        throw new PlayerApiFailure(
          "Player API request was cancelled",
          "aborted",
          false,
          undefined,
          undefined,
          { cause },
        );
      throw new PlayerApiFailure(
        "Player API network request failed",
        "network",
        true,
        undefined,
        undefined,
        { cause },
      );
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  private retryDelay(failure: PlayerApiFailure, failedAttempt: number) {
    if (failure.retryAfterMs !== undefined)
      return Math.min(failure.retryAfterMs, this.options.retryMaxDelayMs);
    const ceiling = Math.min(
      this.options.retryMaxDelayMs,
      this.options.retryBaseDelayMs * 2 ** (failedAttempt - 1),
    );
    return Math.floor(ceiling * (0.5 + this.options.random() * 0.5));
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    options: PlayerRequestOptions = {},
    maxAttempts = 1,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.attempt<T>(path, init, options);
      } catch (cause) {
        if (
          !(cause instanceof PlayerApiFailure) ||
          !cause.retryable ||
          attempt >= maxAttempts ||
          options.signal?.aborted
        )
          throw cause;
        await this.options.sleep(this.retryDelay(cause, attempt));
      }
    }
  }

  async pair(
    code: string,
    installationId: string,
    options: PlayerRequestOptions = {},
  ): Promise<Credentials> {
    // Pairing consumes a one-time code. Never replay this POST automatically:
    // a timeout can occur after the server successfully enrolls the device.
    const result = await this.request<Omit<Credentials, "installationId">>(
      "/api/v1/device/pair",
      {
        method: "POST",
        body: JSON.stringify({
          code,
          device: {
            installationId,
            model: "Android TV",
            osVersion: navigator.userAgent,
            playerVersion: __APP_VERSION__,
          },
        }),
      },
      options,
    );
    return { ...result, installationId };
  }

  async manifest(options: PlayerRequestOptions = {}): Promise<PlayerManifest> {
    // GET is safe to retry. Every attempt retains its own hard deadline.
    const response = await this.request<{
      version: string;
      generatedAt: string;
      validUntil: string;
      playbackEndsAt?: string;
      screenId: string;
      priority: PlayerManifest["priority"];
      withdrawn: boolean;
      items: Array<{
        asset: Omit<PlayerManifest["items"][number], "durationSeconds">;
        durationSeconds: number;
      }>;
      signatureAlgorithm: "Ed25519";
      signature: string;
    }>(
      "/manifest",
      { cache: "no-store" },
      options,
      this.options.manifestMaxAttempts,
    );
    const { signature, signatureAlgorithm, ...unsigned } = response;
    if (
      !this.screenId ||
      response.screenId !== this.screenId ||
      signatureAlgorithm !== "Ed25519" ||
      !this.manifestVerificationKey ||
      !(await verifyManifestSignature(
        unsigned,
        signature,
        this.manifestVerificationKey,
      ))
    )
      throw new PlayerApiFailure(
        "Manifest signature or screen binding is invalid",
        "protocol",
        false,
      );
    return {
      ...unsigned,
      items: response.items.map(({ asset, durationSeconds }) => ({
        ...asset,
        durationSeconds,
      })),
    };
  }

  heartbeat(
    value: Heartbeat,
    options: PlayerRequestOptions = {},
  ): Promise<void> {
    const wireValue = {
      installationId: value.installationId,
      playerVersion: value.playerVersion,
      uptimeSeconds: value.uptimeSeconds,
      freeStorageBytes: value.freeStorageBytes,
      networkType: value.networkType,
      occurredAt: value.occurredAt,
      ...(value.manifestVersion
        ? { manifestVersion: value.manifestVersion }
        : {}),
      ...(value.nowPlayingAssetId
        ? { nowPlayingAssetId: value.nowPlayingAssetId }
        : {}),
    };
    // Heartbeat POSTs are bounded but not replayed without an idempotency contract.
    return this.request(
      "/heartbeat",
      {
        method: "POST",
        body: JSON.stringify(wireValue),
      },
      options,
    );
  }
}

declare const __APP_VERSION__: string;
