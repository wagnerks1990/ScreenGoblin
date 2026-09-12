import type {
  Credentials,
  Heartbeat,
  PendingProofPairing,
  PlayerManifest,
  SignedPlayerManifest,
} from "./types";
import {
  canonicalJson,
  canonicalPairingTranscript,
  type DeviceAuthChallengeRequest,
  type DeviceChallengeResponse,
  type DeviceMetadata,
  type PairingChallengeRequest,
  type PairingPendingApprovalResponse,
  type PairingResponse,
} from "@screengoblin/contracts";
import { createSignedPlayerManifest } from "./manifest";
import { sha256Hex, utf8, verifyManifestSignature } from "./crypto";
import {
  getDeviceIdentity,
  hasNativeDeviceIdentity,
  signDeviceChallenge,
} from "./device";

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

export interface PlayerPairingOptions extends PlayerRequestOptions {
  /** Called after a replacement key is proved and awaits operator activation. */
  onPending?: (
    pending: PairingPendingApprovalResponse,
    recovery: PendingProofPairing,
  ) => void | Promise<void>;
  /** Must durably persist recovery bytes before the first final POST. */
  onProofPrepared?: (recovery: PendingProofPairing) => void | Promise<void>;
}

interface PlayerApiResult<T> {
  status: number;
  payload: T;
}

interface ProtectedPlayerApiResult<T> {
  payload: T;
  requestChallengeId?: string;
}

export interface PlayerApiOptions {
  requestTimeoutMs?: number;
  manifestMaxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  pairingApprovalPollIntervalMs?: number;
  pairingApprovalMaxWaitMs?: number;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const defaults = {
  requestTimeoutMs: 10_000,
  manifestMaxAttempts: 3,
  retryBaseDelayMs: 500,
  retryMaxDelayMs: 5_000,
  // Device pairing is limited to five requests per minute. Four polls per
  // minute leave capacity for the initial proof and transient retries.
  pairingApprovalPollIntervalMs: 15_000,
  pairingApprovalMaxWaitMs: 10 * 60_000,
} as const;

const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function decodeCanonicalBase64Url(
  value: unknown,
  name: string,
  minimumBytes: number,
  maximumBytes = minimumBytes,
): Uint8Array {
  if (
    typeof value !== "string" ||
    !BASE64URL.test(value) ||
    value.length % 4 === 1
  )
    throw new PlayerApiFailure(
      `${name} is not canonical base64url`,
      "protocol",
      false,
    );
  try {
    const padded = `${value.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat(
      (4 - (value.length % 4)) % 4,
    )}`;
    const binary = atob(padded);
    const canonical = btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    if (
      canonical !== value ||
      binary.length < minimumBytes ||
      binary.length > maximumBytes
    )
      throw new Error("invalid encoding");
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch (cause) {
    if (cause instanceof PlayerApiFailure) throw cause;
    throw new PlayerApiFailure(
      `${name} is not canonical base64url`,
      "protocol",
      false,
      undefined,
      undefined,
      { cause },
    );
  }
}

function validOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 64 &&
    BASE64URL.test(value)
  );
}

function validateChallenge(value: unknown): DeviceChallengeResponse {
  if (!value || typeof value !== "object")
    throw new PlayerApiFailure(
      "Invalid device challenge response",
      "protocol",
      false,
    );
  const response = value as Record<string, unknown>;
  const expiresAt =
    typeof response.expiresAt === "string"
      ? Date.parse(response.expiresAt)
      : NaN;
  if (
    !Number.isFinite(expiresAt) ||
    new Date(expiresAt).toISOString() !== response.expiresAt ||
    expiresAt <= Date.now()
  )
    throw new PlayerApiFailure(
      "Invalid device challenge response",
      "protocol",
      false,
    );
  decodeCanonicalBase64Url(response.id, "Device challenge ID", 32);
  decodeCanonicalBase64Url(response.challenge, "Device challenge", 16, 512);
  return {
    id: response.id as string,
    challenge: response.challenge as string,
    expiresAt: response.expiresAt,
  };
}

function secureApiBaseUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    return (
      (url.protocol === "https:" || (url.protocol === "http:" && local)) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function validatePairingResponse(
  value: unknown,
  expectedKeyId: string,
): PairingResponse {
  if (!value || typeof value !== "object")
    throw new PlayerApiFailure(
      "Invalid proof pairing response",
      "protocol",
      false,
    );
  const response = value as Record<string, unknown>;
  if (
    response.authMode !== "proof-v1" ||
    response.keyId !== expectedKeyId ||
    !validOpaqueId(response.screenId) ||
    !validOpaqueId(response.credentialId) ||
    !secureApiBaseUrl(response.apiBaseUrl) ||
    !Number.isSafeInteger(response.heartbeatIntervalSeconds) ||
    (response.heartbeatIntervalSeconds as number) < 5 ||
    (response.heartbeatIntervalSeconds as number) > 86_400 ||
    Object.hasOwn(response, "deviceToken") ||
    Object.keys(response).some(
      (key) =>
        ![
          "authMode",
          "screenId",
          "credentialId",
          "keyId",
          "apiBaseUrl",
          "heartbeatIntervalSeconds",
          "manifestVerificationKey",
        ].includes(key),
    )
  )
    throw new PlayerApiFailure(
      "Invalid proof pairing response",
      "protocol",
      false,
    );
  try {
    decodeCanonicalBase64Url(
      response.manifestVerificationKey,
      "Manifest verification key",
      32,
    );
  } catch {
    throw new PlayerApiFailure(
      "Invalid proof pairing response",
      "protocol",
      false,
    );
  }
  return response as unknown as PairingResponse;
}

function validatePendingPairingResponse(
  value: unknown,
  expectedKeyId: string,
): PairingPendingApprovalResponse {
  if (!value || typeof value !== "object")
    throw new PlayerApiFailure(
      "Invalid pending pairing response",
      "protocol",
      false,
    );
  const response = value as Record<string, unknown>;
  const expiresAt =
    typeof response.expiresAt === "string"
      ? Date.parse(response.expiresAt)
      : NaN;
  if (
    response.status !== "pending-approval" ||
    !validOpaqueId(response.grantId) ||
    !validOpaqueId(response.candidateId) ||
    response.keyId !== expectedKeyId ||
    response.fingerprint !== expectedKeyId ||
    !Number.isFinite(expiresAt) ||
    new Date(expiresAt).toISOString() !== response.expiresAt ||
    expiresAt <= Date.now() ||
    Object.keys(response).some(
      (key) =>
        ![
          "status",
          "grantId",
          "candidateId",
          "keyId",
          "fingerprint",
          "expiresAt",
          "approval",
        ].includes(key),
    )
  )
    throw new PlayerApiFailure(
      "Invalid pending pairing response",
      "protocol",
      false,
    );
  decodeCanonicalBase64Url(response.keyId, "Pending pairing key ID", 32);
  return response as unknown as PairingPendingApprovalResponse;
}

function validatePendingProofPairing(
  value: PendingProofPairing,
  expectedApiBaseUrl: string,
): Record<string, unknown> {
  const record = value as unknown as Record<string, unknown>;
  const expiresAt =
    typeof record.expiresAt === "string" ? Date.parse(record.expiresAt) : NaN;
  if (
    record.version !== 1 ||
    !["prepared", "pending"].includes(record.stage as string) ||
    !secureApiBaseUrl(record.apiBaseUrl) ||
    trim(record.apiBaseUrl as string) !== trim(expectedApiBaseUrl) ||
    typeof record.finalBody !== "string" ||
    record.finalBody.length < 1 ||
    record.finalBody.length > 16_384 ||
    typeof record.expectedKeyId !== "string" ||
    record.installationId !== record.expectedKeyId ||
    !Number.isFinite(expiresAt) ||
    new Date(expiresAt).toISOString() !== record.expiresAt ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + defaults.pairingApprovalMaxWaitMs ||
    Object.keys(record).some(
      (key) =>
        ![
          "version",
          "stage",
          "apiBaseUrl",
          "finalBody",
          "expectedKeyId",
          "installationId",
          "expiresAt",
          "approval",
        ].includes(key),
    )
  )
    throw new PlayerApiFailure(
      "Invalid pending pairing recovery record",
      "protocol",
      false,
    );
  decodeCanonicalBase64Url(record.expectedKeyId, "Pending pairing key ID", 32);
  const storedApproval = record.approval as
    PairingPendingApprovalResponse | undefined;
  if (
    (record.stage === "pending" && !storedApproval) ||
    (record.stage === "prepared" && storedApproval !== undefined) ||
    (storedApproval &&
      validatePendingPairingResponse(
        storedApproval,
        record.expectedKeyId as string,
      ).expiresAt !== storedApproval.expiresAt)
  )
    throw new PlayerApiFailure(
      "Invalid pending pairing recovery record",
      "protocol",
      false,
    );
  try {
    const body = JSON.parse(record.finalBody as string) as Record<
      string,
      unknown
    >;
    if (canonicalJson(body) !== record.finalBody)
      throw new Error("non-canonical body");
    const device = body.device as Record<string, unknown>;
    const identity = body.identity as Record<string, unknown>;
    const proof = body.pairingProof as Record<string, unknown>;
    if (
      !device ||
      !identity ||
      !proof ||
      typeof body.code !== "string" ||
      !/^\d{6}$/.test(body.code) ||
      device.installationId !== record.installationId ||
      identity.keyId !== record.expectedKeyId ||
      proof.keyId !== record.expectedKeyId ||
      proof.signatureFormat !== "ES256-DER"
    )
      throw new Error("body binding mismatch");
    decodeCanonicalBase64Url(
      identity.publicKeySpki,
      "Pairing public key",
      80,
      128,
    );
    decodeCanonicalBase64Url(proof.challengeId, "Pairing challenge ID", 32);
    decodeCanonicalBase64Url(proof.challenge, "Pairing challenge", 16, 512);
    decodeCanonicalBase64Url(proof.signature, "Pairing signature", 64, 80);
    return body;
  } catch (cause) {
    if (cause instanceof PlayerApiFailure) throw cause;
    throw new PlayerApiFailure(
      "Invalid pending pairing recovery record",
      "protocol",
      false,
      undefined,
      undefined,
      { cause },
    );
  }
}

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
    private readonly credentials?: Credentials,
    options: PlayerApiOptions = {},
  ) {
    this.options = {
      requestTimeoutMs: options.requestTimeoutMs ?? defaults.requestTimeoutMs,
      manifestMaxAttempts:
        options.manifestMaxAttempts ?? defaults.manifestMaxAttempts,
      retryBaseDelayMs: options.retryBaseDelayMs ?? defaults.retryBaseDelayMs,
      retryMaxDelayMs: options.retryMaxDelayMs ?? defaults.retryMaxDelayMs,
      pairingApprovalPollIntervalMs:
        options.pairingApprovalPollIntervalMs ??
        defaults.pairingApprovalPollIntervalMs,
      pairingApprovalMaxWaitMs:
        options.pairingApprovalMaxWaitMs ?? defaults.pairingApprovalMaxWaitMs,
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
      this.options.retryMaxDelayMs < 0 ||
      this.options.pairingApprovalPollIntervalMs < 1 ||
      this.options.pairingApprovalMaxWaitMs < 1
    )
      throw new RangeError("Player API timing options are out of range");
    if (
      credentials?.authMode === "development-bearer" &&
      !developmentBearerAllowed(apiBaseUrl)
    )
      throw new PlayerApiFailure(
        "Development bearer credentials require an explicit localhost build",
        "protocol",
        false,
      );
  }

  private async attempt<T>(
    path: string,
    init: RequestInit,
    options: PlayerRequestOptions,
  ): Promise<PlayerApiResult<T>> {
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
    if (this.credentials) {
      headers.set("X-Screen-Id", this.credentials.screenId);
      if (this.credentials.authMode === "development-bearer")
        headers.set("X-Device-Token", this.credentials.deviceToken);
      else headers.set("X-Device-Key-Id", this.credentials.keyId);
    }

    try {
      const response = await Promise.race([
        fetch(`${trim(this.apiBaseUrl)}${path}`, {
          ...init,
          headers,
          redirect: "error",
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
      if (response.status === 204)
        return { status: response.status, payload: undefined as T };
      try {
        return {
          status: response.status,
          payload: (await response.json()) as T,
        };
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

  private async pause(
    milliseconds: number,
    options: PlayerRequestOptions,
  ): Promise<void> {
    if (options.signal?.aborted)
      throw new PlayerApiFailure(
        "Player API request was cancelled",
        "aborted",
        false,
      );
    let abort: (() => void) | undefined;
    try {
      await Promise.race([
        this.options.sleep(milliseconds),
        new Promise<never>((_, reject) => {
          abort = () =>
            reject(
              new PlayerApiFailure(
                "Player API request was cancelled",
                "aborted",
                false,
              ),
            );
          options.signal?.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } finally {
      if (abort) options.signal?.removeEventListener("abort", abort);
    }
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    options: PlayerRequestOptions = {},
    maxAttempts = 1,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return (await this.attempt<T>(path, init, options)).payload;
      } catch (cause) {
        if (
          !(cause instanceof PlayerApiFailure) ||
          !cause.retryable ||
          attempt >= maxAttempts ||
          options.signal?.aborted
        )
          throw cause;
        await this.pause(this.retryDelay(cause, attempt), options);
      }
    }
  }

  private async withRetries<T>(
    operation: () => Promise<T>,
    options: PlayerRequestOptions,
    maxAttempts: number,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await operation();
      } catch (cause) {
        if (
          !(cause instanceof PlayerApiFailure) ||
          !cause.retryable ||
          attempt >= maxAttempts ||
          options.signal?.aborted
        )
          throw cause;
        await this.pause(this.retryDelay(cause, attempt), options);
      }
    }
  }

  private async proofHeaders(
    operation: DeviceAuthChallengeRequest["operation"],
    bodySha256: string,
    options: PlayerRequestOptions,
  ): Promise<Headers> {
    if (!this.credentials || this.credentials.authMode !== "proof-v1")
      throw new PlayerApiFailure(
        "Device proof credentials are unavailable",
        "protocol",
        false,
      );
    const challenge = validateChallenge(
      await this.request<unknown>(
        "/challenges",
        {
          method: "POST",
          body: canonicalJson({ operation, bodySha256 }),
        },
        options,
      ),
    );
    const signature = await signDeviceChallenge(
      challenge.challenge,
      this.credentials.keyId,
    );
    const headers = new Headers();
    headers.set("X-Device-Key-Id", signature.keyId);
    headers.set("X-Device-Challenge-Id", challenge.id);
    headers.set("X-Device-Challenge", challenge.challenge);
    headers.set("X-Device-Signature", signature.signature);
    headers.set("X-Device-Signature-Format", signature.signatureFormat);
    return headers;
  }

  private async protectedRequestWithContext<T>(
    operation: DeviceAuthChallengeRequest["operation"],
    path: string,
    body: string | undefined,
    init: RequestInit,
    options: PlayerRequestOptions,
  ): Promise<ProtectedPlayerApiResult<T>> {
    if (!this.credentials)
      throw new PlayerApiFailure(
        "Device credentials are unavailable",
        "protocol",
        false,
      );
    if (this.credentials.authMode === "development-bearer")
      return {
        payload: await this.request<T>(
          path,
          { ...init, ...(body === undefined ? {} : { body }) },
          options,
        ),
      };
    const bodySha256 = await sha256Hex(
      body === undefined ? new ArrayBuffer(0) : utf8(body),
    );
    const headers = await this.proofHeaders(operation, bodySha256, options);
    const requestChallengeId = headers.get("X-Device-Challenge-Id");
    if (!requestChallengeId)
      throw new PlayerApiFailure(
        "Device proof challenge context is unavailable",
        "protocol",
        false,
      );
    return {
      payload: await this.request<T>(
        path,
        { ...init, headers, ...(body === undefined ? {} : { body }) },
        options,
      ),
      requestChallengeId,
    };
  }

  private async protectedRequest<T>(
    operation: DeviceAuthChallengeRequest["operation"],
    path: string,
    body: string | undefined,
    init: RequestInit,
    options: PlayerRequestOptions,
  ): Promise<T> {
    return (
      await this.protectedRequestWithContext<T>(
        operation,
        path,
        body,
        init,
        options,
      )
    ).payload;
  }

  async pair(
    code: string,
    installationId: string,
    options: PlayerPairingOptions = {},
  ): Promise<Credentials> {
    const device: DeviceMetadata = {
      installationId,
      model: "Android TV",
      osVersion: navigator.userAgent,
      playerVersion: __APP_VERSION__,
    };
    if (!hasNativeDeviceIdentity()) {
      if (!developmentBearerAllowed(this.apiBaseUrl))
        throw new PlayerApiFailure(
          "Device proof is required outside local development",
          "protocol",
          false,
        );
      const result = await this.request<{
        screenId: string;
        deviceToken: string;
        apiBaseUrl: string;
        heartbeatIntervalSeconds: number;
        manifestVerificationKey: string;
      }>(
        "/api/v1/device/pair",
        {
          method: "POST",
          body: JSON.stringify({ code, device }),
        },
        options,
      );
      return { ...result, installationId, authMode: "development-bearer" };
    }

    const identity = await getDeviceIdentity();
    if (!identity)
      throw new PlayerApiFailure(
        "Android device identity is unavailable",
        "protocol",
        false,
      );
    if (installationId !== identity.keyId)
      throw new PlayerApiFailure(
        "Android installation ID does not match its device identity",
        "protocol",
        false,
      );
    const pairing: PairingChallengeRequest = { code, device, identity };
    // Evaluate the shared canonicalizer before enrollment. This fails closed on
    // unsupported metadata and guarantees the repeated final fields are hashable.
    canonicalPairingTranscript(pairing);
    const challenge = validateChallenge(
      await this.request<unknown>(
        "/api/v1/device/pair/challenge",
        { method: "POST", body: canonicalJson(pairing) },
        options,
      ),
    );
    const signature = await signDeviceChallenge(
      challenge.challenge,
      identity.keyId,
    );
    const body = canonicalJson({
      ...pairing,
      pairingProof: {
        challengeId: challenge.id,
        challenge: challenge.challenge,
        ...signature,
      },
    });
    const recovery: PendingProofPairing = {
      version: 1,
      stage: "prepared",
      apiBaseUrl: trim(this.apiBaseUrl),
      finalBody: body,
      expectedKeyId: identity.keyId,
      installationId,
      expiresAt: new Date(
        Date.now() + this.options.pairingApprovalMaxWaitMs,
      ).toISOString(),
    };
    if (!options.onProofPrepared)
      throw new PlayerApiFailure(
        "Durable pairing recovery storage is required",
        "protocol",
        false,
      );
    await options.onProofPrepared?.(recovery);
    return this.resumePairing(recovery, options);
  }

  /** Resumes only the exact durably stored final proof; no new code or signature. */
  async resumePairing(
    recovery: PendingProofPairing,
    options: PlayerPairingOptions = {},
  ): Promise<Credentials> {
    const body = validatePendingProofPairing(recovery, this.apiBaseUrl);
    const identity = await getDeviceIdentity();
    if (
      !identity ||
      identity.keyId !== recovery.expectedKeyId ||
      identity.publicKeySpki !==
        (body.identity as Record<string, unknown>).publicKeySpki
    )
      throw new PlayerApiFailure(
        "Pending pairing does not match the active Android identity",
        "protocol",
        false,
      );
    const pollingDeadline =
      recovery.stage === "prepared"
        ? Date.now() + this.options.pairingApprovalMaxWaitMs
        : Math.min(
            Date.parse(recovery.expiresAt),
            Date.now() + this.options.pairingApprovalMaxWaitMs,
          );
    for (;;) {
      let result: PlayerApiResult<unknown>;
      try {
        result = await this.attempt<unknown>(
          "/api/v1/device/pair",
          { method: "POST", body: recovery.finalBody },
          options,
        );
      } catch (cause) {
        if (!(cause instanceof PlayerApiFailure) || !cause.retryable)
          throw cause;
        const remaining = pollingDeadline - Date.now();
        if (remaining <= 0)
          throw new PlayerApiFailure(
            "Replacement approval expired before activation",
            "timeout",
            false,
          );
        const requestedDelay =
          cause.status === 429 && cause.retryAfterMs !== undefined
            ? cause.retryAfterMs
            : this.options.pairingApprovalPollIntervalMs;
        await this.pause(Math.min(requestedDelay, remaining), options);
        continue;
      }
      const response = result.payload;
      if (
        response &&
        typeof response === "object" &&
        (response as Record<string, unknown>).status === "pending-approval"
      ) {
        if (result.status !== 202)
          throw new PlayerApiFailure(
            "Pending pairing response used an invalid HTTP status",
            "protocol",
            false,
          );
        const pending = validatePendingPairingResponse(
          response,
          recovery.expectedKeyId,
        );
        const boundedRecovery = {
          ...recovery,
          stage: "pending" as const,
          approval: pending,
          expiresAt: new Date(
            Math.min(Date.parse(pending.expiresAt), pollingDeadline),
          ).toISOString(),
        };
        await options.onPending?.(pending, boundedRecovery);
        const remaining = Date.parse(boundedRecovery.expiresAt) - Date.now();
        if (remaining <= 0)
          throw new PlayerApiFailure(
            "Replacement approval expired before activation",
            "timeout",
            false,
          );
        await this.pause(
          Math.min(this.options.pairingApprovalPollIntervalMs, remaining),
          options,
        );
        continue;
      }
      if (result.status !== 201)
        throw new PlayerApiFailure(
          "Activated pairing response used an invalid HTTP status",
          "protocol",
          false,
        );
      const credentials = validatePairingResponse(
        response,
        recovery.expectedKeyId,
      );
      return { ...credentials, installationId: recovery.installationId };
    }
  }

  async manifest(
    options: PlayerRequestOptions = {},
  ): Promise<SignedPlayerManifest> {
    // GET is safe to retry. Every attempt retains its own hard deadline.
    const fetchManifest = () =>
      this.protectedRequestWithContext<{
        version: string;
        generatedAt: string;
        validUntil: string;
        playbackEndsAt?: string;
        screenId: string;
        requestChallengeId?: string;
        priority: PlayerManifest["priority"];
        withdrawn: boolean;
        items: Array<{
          asset: Omit<PlayerManifest["items"][number], "durationSeconds">;
          durationSeconds: number;
        }>;
        signatureAlgorithm: "Ed25519";
        signature: string;
      }>("manifest", "/manifest", undefined, { cache: "no-store" }, options);
    // A proof is one-use, so every safe GET retry obtains and signs a new one.
    const { payload: response, requestChallengeId } = await this.withRetries(
      fetchManifest,
      options,
      this.options.manifestMaxAttempts,
    );
    const { signature, signatureAlgorithm, ...unsigned } = response;
    if (
      !this.credentials ||
      response.screenId !== this.credentials.screenId ||
      signatureAlgorithm !== "Ed25519" ||
      !this.credentials.manifestVerificationKey ||
      !(await verifyManifestSignature(
        unsigned,
        signature,
        this.credentials.manifestVerificationKey,
      ))
    )
      throw new PlayerApiFailure(
        "Manifest signature or screen binding is invalid",
        "protocol",
        false,
      );
    if (
      this.credentials.authMode === "proof-v1" &&
      response.requestChallengeId !== requestChallengeId
    )
      throw new PlayerApiFailure(
        "Manifest response is not bound to its request challenge",
        "protocol",
        false,
      );
    return createSignedPlayerManifest(unsigned, signatureAlgorithm, signature);
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
    const body = canonicalJson(wireValue);
    return this.protectedRequest(
      "heartbeat",
      "/heartbeat",
      body,
      {
        method: "POST",
      },
      options,
    );
  }
}

export function developmentBearerAllowed(apiBaseUrl: string): boolean {
  if (import.meta.env.VITE_DEVICE_AUTH_DEVELOPMENT_BEARER !== "true")
    return false;
  try {
    return ["localhost", "127.0.0.1", "::1"].includes(
      new URL(apiBaseUrl).hostname,
    );
  } catch {
    return false;
  }
}

declare const __APP_VERSION__: string;
