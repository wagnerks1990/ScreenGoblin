import type { MailPayload } from "./crypto.js";
export type SendResult =
  | { accepted: true; providerId: string }
  | {
      accepted: false;
      retryable: boolean;
      code: string;
      retryAfterSeconds?: number;
      retryAt?: string;
    };
export interface MailTransport {
  send(payload: MailPayload, idempotencyKey: string): Promise<SendResult>;
}
export class ResendTransport implements MailTransport {
  constructor(
    private readonly key: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async send(
    payload: MailPayload,
    idempotencyKey: string,
  ): Promise<SendResult> {
    try {
      const response = await this.fetcher("https://api.resend.com/emails", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: "Bearer " + this.key,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const raw = response.headers.get("retry-after");
        const seconds = raw === null ? NaN : Number(raw);
        const date = raw === null ? NaN : Date.parse(raw);
        const retryAfterSeconds =
          Number.isFinite(seconds) && seconds >= 0
            ? Math.ceil(seconds)
            : Number.isFinite(date)
              ? Math.max(1, Math.ceil((date - Date.now()) / 1000))
              : undefined;
        await response.body?.cancel();
        return {
          accepted: false,
          retryable,
          code:
            response.status === 401 || response.status === 403
              ? "PROVIDER_AUTH"
              : retryable
                ? "PROVIDER_TRANSIENT"
                : "PROVIDER_REJECTED",
          ...(Number.isFinite(date) && !Number.isFinite(seconds)
            ? { retryAt: new Date(date).toISOString() }
            : retryAfterSeconds !== undefined
              ? { retryAfterSeconds }
              : {}),
        };
      }
      if (Number(response.headers.get("content-length")) > 4096) {
        await response.body?.cancel();
        return { accepted: false, retryable: false, code: "PROVIDER_RESPONSE" };
      }
      const reader = response.body?.getReader();
      if (!reader)
        return { accepted: false, retryable: false, code: "PROVIDER_RESPONSE" };
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 4096) {
          await reader.cancel();
          return {
            accepted: false,
            retryable: false,
            code: "PROVIDER_RESPONSE",
          };
        }
        chunks.push(part.value);
      }
      const result: unknown = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      );
      if (
        !result ||
        typeof result !== "object" ||
        !("id" in result) ||
        typeof result.id !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
          result.id,
        )
      )
        return { accepted: false, retryable: false, code: "PROVIDER_RESPONSE" };
      return { accepted: true, providerId: result.id };
    } catch {
      return { accepted: false, retryable: true, code: "NETWORK" };
    }
  }
}
