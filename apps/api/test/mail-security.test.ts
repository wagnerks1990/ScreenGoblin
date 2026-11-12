import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Webhook } from "standardwebhooks";
import { loadMailConfig } from "../src/mail/config.js";
import {
  encryptPayload,
  decryptPayload,
  type MailPayload,
} from "../src/mail/crypto.js";
import { verifyMailWebhook } from "../src/mail/webhook.js";
import { ResendTransport } from "../src/mail/transport.js";
const secret = "whsec_" + randomBytes(32).toString("base64");
const key = randomBytes(32).toString("base64url");
const payload: MailPayload = {
  from: "no-reply@example.test",
  reply_to: "support@example.test",
  to: ["member@example.test"],
  subject: "Account test",
  text: "An opaque account-recovery link",
};
const signed = (body: Buffer, timestamp = new Date()) => {
  const id = "msg_test_" + randomUUID().replaceAll("-", "");
  return {
    "svix-id": id,
    "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "svix-signature": new Webhook(secret).sign(id, timestamp, body),
  };
};
describe("mail capabilities and webhook boundary", () => {
  it("keeps mail disabled by default and rejects unsafe active configuration without echoing secrets", () => {
    expect(loadMailConfig({}, "https://example.test")).toBeUndefined();
    const settings = {
      MAIL_ENABLED: "true",
      MAIL_RECEIVING_DOMAIN: "example.test",
      MAIL_FROM: payload.from,
      MAIL_REPLY_TO: payload.reply_to,
      RESEND_API_KEY: "re_test_only_never_live_key",
      RESEND_WEBHOOK_SECRET: secret,
      MAIL_ENCRYPTION_KEY: key,
    };
    expect(
      loadMailConfig(settings, "https://example.test")?.offlineMinutes,
    ).toBe(10);
    expect(() =>
      loadMailConfig(
        { ...settings, MAIL_FROM: "evil@example.invalid" },
        "https://example.test",
      ),
    ).toThrow("Mail configuration is invalid");
    expect(() =>
      loadMailConfig(
        { ...settings, NODE_ENV: "production" },
        "https://example.test",
      ),
    ).toThrow("Mail configuration is invalid");
    expect(() =>
      loadMailConfig(
        {
          ...settings,
          MAIL_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64url"),
          NODE_ENV: "production",
          RESEND_API_KEY: "re_runtime_not_a_real_secret",
        },
        "https://example.test",
      ),
    ).toThrow();
  });
  it("accepts provider-issued 192-bit webhook keys and still rejects short or malformed keys", () => {
    const providerSecret = "whsec_" + randomBytes(24).toString("base64");
    const settings = {
      NODE_ENV: "production",
      MAIL_ENABLED: "true",
      MAIL_RECEIVING_DOMAIN: "example.test",
      MAIL_FROM: payload.from,
      MAIL_REPLY_TO: payload.reply_to,
      RESEND_API_KEY: "re_runtime_not_a_real_secret",
      RESEND_WEBHOOK_SECRET: providerSecret,
      MAIL_ENCRYPTION_KEY: key,
    };
    expect(
      loadMailConfig(settings, "https://example.test")?.webhookSecret,
    ).toBe(providerSecret);
    for (const invalid of [
      "whsec_" + randomBytes(23).toString("base64"),
      providerSecret + "!",
      "whsec_" + Buffer.alloc(24).toString("base64"),
    ])
      expect(() =>
        loadMailConfig(
          { ...settings, RESEND_WEBHOOK_SECRET: invalid },
          "https://example.test",
        ),
      ).toThrow("Mail configuration is invalid");
    const body = Buffer.from(
      JSON.stringify({
        type: "email.delivered",
        data: { email_id: randomUUID() },
      }),
    );
    const id = "msg_provider_key_test",
      timestamp = new Date();
    const headers = {
      "svix-id": id,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": new Webhook(providerSecret).sign(id, timestamp, body),
    };
    expect(verifyMailWebhook(body, headers, providerSecret).event.type).toBe(
      "email.delivered",
    );
    expect(() =>
      verifyMailWebhook(
        Buffer.concat([body, Buffer.from(" ")]),
        headers,
        providerSecret,
      ),
    ).toThrow("verification failed");
  });
  it("encrypts queued recipients and content with random nonces and job-bound authentication", () => {
    const job = randomUUID(),
      encrypted = encryptPayload(payload, key, job);
    expect(encrypted).not.toContain(payload.to[0]);
    expect(encrypted).not.toContain(payload.text);
    expect(encrypted).not.toEqual(encryptPayload(payload, key, job));
    expect(decryptPayload(encrypted, key, job)).toEqual(payload);
    expect(() => decryptPayload(encrypted, key, randomUUID())).toThrow();
    expect(() =>
      decryptPayload(encrypted, randomBytes(32).toString("base64url"), job),
    ).toThrow();
    const tampered = Buffer.from(encrypted, "base64url");
    tampered[30] = tampered[30]! ^ 1;
    expect(() =>
      decryptPayload(tampered.toString("base64url"), key, job),
    ).toThrow();
  });
  it("verifies exact signed bytes and drops unneeded mail content", () => {
    const body = Buffer.from(
      JSON.stringify({
        type: "email.received",
        data: {
          email_id: randomUUID(),
          to: ["support@example.test"],
          subject: "untrusted",
          html: "<script>publish()</script>",
          attachments: ["ignored"],
        },
      }),
    );
    const headers = signed(body);
    const event = verifyMailWebhook(body, headers, secret);
    expect(event.id).toBe(headers["svix-id"]);
    expect(Object.keys(event.event.data).sort()).toEqual(["email_id", "to"]);
    expect(() =>
      verifyMailWebhook(
        Buffer.from(body.toString().replace("untrusted", "modified")),
        headers,
        secret,
      ),
    ).toThrow("verification failed");
  });
  it.each([
    "missing",
    "expired",
    "future",
    "timestamp-junk",
    "duplicate-header",
    "invalid-utf8",
    "oversize",
  ])("rejects %s webhook input before trusting it", (scenario) => {
    let body = Buffer.from(
      JSON.stringify({
        type: "email.received",
        data: { email_id: randomUUID(), to: ["support@example.test"] },
      }),
    );
    const headers: Record<string, string | string[] | undefined> = signed(
      body,
      scenario === "expired"
        ? new Date(Date.now() - 301_000)
        : scenario === "future"
          ? new Date(Date.now() + 301_000)
          : new Date(),
    );
    if (scenario === "missing") delete headers["svix-signature"];
    if (scenario === "timestamp-junk") headers["svix-timestamp"] += "junk";
    if (scenario === "duplicate-header") headers["svix-id"] = ["one", "two"];
    if (scenario === "invalid-utf8") {
      body = Buffer.from([255, 254]);
      Object.assign(headers, signed(body));
    }
    if (scenario === "oversize") body = Buffer.alloc(65537, 65);
    expect(() => verifyMailWebhook(body, headers, secret)).toThrow(
      "verification failed",
    );
  });
  it("accepts rotated signature lists but rejects a wrong signing key", () => {
    const body = Buffer.from(
        JSON.stringify({
          type: "email.delivered",
          data: { email_id: randomUUID() },
        }),
      ),
      headers = signed(body);
    expect(
      verifyMailWebhook(
        body,
        {
          ...headers,
          "svix-signature": "v1,invalid " + headers["svix-signature"],
        },
        secret,
      ).event.type,
    ).toBe("email.delivered");
    expect(() =>
      verifyMailWebhook(
        body,
        headers,
        "whsec_" + randomBytes(32).toString("base64"),
      ),
    ).toThrow();
  });
});
describe("fixed-endpoint Resend delivery", () => {
  it("uses a stable idempotency key, a deadline and no redirect following", async () => {
    const providerId = randomUUID();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: providerId }), { status: 200 }),
      );
    const sender = new ResendTransport("re_test_only_never_live_key", fetcher);
    expect(await sender.send(payload, "job-key")).toEqual({
      accepted: true,
      providerId,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: expect.objectContaining({ "Idempotency-Key": "job-key" }),
        body: JSON.stringify(payload),
        signal: expect.any(AbortSignal),
      }),
    );
  });
  it.each([401, 403, 422, 429, 500])(
    "classifies provider status %i without returning provider content",
    async (status) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response("private provider response", {
          status,
          headers: { "retry-after": "120" },
        }),
      );
      const result = await new ResendTransport(
        "re_test_only_never_live_key",
        fetcher,
      ).send(payload, "job-key");
      expect(result).toMatchObject({
        accepted: false,
        retryable: status === 429 || status >= 500,
      });
      expect(JSON.stringify(result)).not.toContain("private provider response");
    },
  );
  it("preserves absolute Retry-After deadlines", async () => {
    const deadline = new Date(Date.now() + 120_000);
    deadline.setMilliseconds(0);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 429,
        headers: { "retry-after": deadline.toUTCString() },
      }),
    );
    expect(
      await new ResendTransport("re_test_only_never_live_key", fetcher).send(
        payload,
        "job",
      ),
    ).toMatchObject({
      accepted: false,
      retryable: true,
      retryAt: deadline.toISOString(),
    });
  });
  it("bounds provider response bodies and treats network ambiguity as retryable", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("x".repeat(4097), { status: 200 }))
      .mockRejectedValueOnce(new Error("private credential"));
    const sender = new ResendTransport("re_test_only_never_live_key", fetcher);
    expect(await sender.send(payload, "same-job")).toMatchObject({
      accepted: false,
      code: "PROVIDER_RESPONSE",
      retryable: false,
    });
    expect(await sender.send(payload, "same-job")).toEqual({
      accepted: false,
      code: "NETWORK",
      retryable: true,
    });
  });
});
