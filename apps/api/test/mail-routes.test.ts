import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "standardwebhooks";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { MemoryStore } from "../src/store/memory.js";
import { sha256 } from "../src/utils/crypto.js";
import type { MailApi } from "../src/mail/service.js";
let app: FastifyInstance, store: MemoryStore;
const secret = "whsec_" + randomBytes(32).toString("base64");
const mail = {
  webhookSecret: secret,
  requestReset: vi.fn(),
  confirmReset: vi.fn(),
  overview: vi.fn(),
  preferences: vi.fn(),
  inbox: vi.fn(),
  test: vi.fn(),
  webhook: vi.fn(),
};
function token(role: "OWNER" | "VIEWER" = "OWNER") {
  const id = randomUUID(),
    sessionId = randomUUID();
  store.users.push({
    id,
    email: "owner@example.test",
    name: "Owner",
    passwordHash: "test-only",
    organizationId: "org-a",
    role,
    authenticationEpoch: 0,
    authorizationEpoch: 0,
  });
  store.userSessions.push({
    id: randomUUID(),
    userId: id,
    organizationId: "org-a",
    tokenHash: sha256(sessionId),
    authenticationEpoch: 0,
    authorizationEpoch: 0,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    createdAt: new Date().toISOString(),
  });
  return app.jwt.sign(
    {
      sub: id,
      email: "owner@example.test",
      organizationId: "org-a",
      role,
      sessionId,
    },
    { expiresIn: "1h" },
  );
}
beforeEach(async () => {
  vi.clearAllMocks();
  for (const method of [
    mail.requestReset,
    mail.confirmReset,
    mail.preferences,
    mail.inbox,
    mail.webhook,
  ])
    method.mockResolvedValue(undefined);
  mail.overview.mockResolvedValue({ configured: true });
  mail.test.mockResolvedValue({ id: randomUUID() });
  store = new MemoryStore();
  app = await buildApp({
    store,
    mail: mail as MailApi,
    jwtSecret: "test-secret-long-enough-for-unit-checks",
    pairingCodePepper: "test-pepper-long-enough-for-unit-checks",
    manifestSigningPrivateKey: randomBytes(32).toString("base64url"),
    deviceAuthMode: "development-bearer",
  });
});
afterEach(async () => {
  await app.close();
});
describe("mail HTTP authorization and recovery", () => {
  it("publishes only a recovery availability boolean", async () => {
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/auth/recovery-options",
        })
      ).json(),
    ).toEqual({ passwordResetEnabled: true });
  });
  it.each([
    "/api/v1/mail",
    "/api/v1/mail/preferences",
    "/api/v1/mail/inbox",
    "/api/v1/mail/test",
  ])("requires authentication for %s", async (url) => {
    const method =
      url.endsWith("preferences") || url.endsWith("inbox")
        ? "PATCH"
        : url.endsWith("test")
          ? "POST"
          : "GET";
    expect((await app.inject({ method, url, payload: {} })).statusCode).toBe(
      401,
    );
    expect(mail.overview).not.toHaveBeenCalled();
  });
  it("denies viewers and binds management operations to server-validated principal identity", async () => {
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/mail",
          headers: { authorization: "Bearer " + token("VIEWER") },
        })
      ).statusCode,
    ).toBe(403);
    const bearer = token();
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/v1/mail/preferences",
          headers: { authorization: "Bearer " + bearer },
          payload: { offlineAlertsEnabled: true, organizationId: "org-b" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/v1/mail/preferences",
          headers: { authorization: "Bearer " + bearer },
          payload: { offlineAlertsEnabled: true },
        })
      ).statusCode,
    ).toBe(204);
    expect(mail.preferences).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-a",
        tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      true,
    );
  });
  it("returns the same reset-request response for eligible, unknown, and queue-failure outcomes", async () => {
    const request = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/password-reset/request",
        payload: { email: "owner@example.test" },
      });
    const first = await request();
    mail.requestReset.mockRejectedValueOnce(
      new Error("private provider credential"),
    );
    const failed = await request();
    expect(first.statusCode).toBe(202);
    expect(failed.json()).toEqual(first.json());
    expect(JSON.stringify(first.json())).not.toContain("owner@example.test");
  });
  it("limits reset requests without revealing account eligibility", async () => {
    const request = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/password-reset/request",
        payload: { email: "unknown@example.test" },
      });
    for (let i = 0; i < 3; i++) expect((await request()).statusCode).toBe(202);
    expect((await request()).statusCode).toBe(429);
  });
  it("accepts only a token and strong replacement password, with sanitized failures", async () => {
    const request = (newPassword: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/password-reset/confirm",
        payload: { token: "a".repeat(43), newPassword },
      });
    expect((await request("too-short")).statusCode).toBe(400);
    expect(mail.confirmReset).not.toHaveBeenCalled();
    mail.confirmReset.mockRejectedValueOnce(
      new Error("private database record"),
    );
    const failure = await request("new-password-with-sixteen-characters");
    expect(failure.statusCode).toBe(503);
    expect(failure.body).not.toContain("private database record");
  });
  it("requires UUIDv4 idempotency for self-addressed mail tests", async () => {
    const headers = { authorization: "Bearer " + token() };
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/mail/test", headers }))
        .statusCode,
    ).toBe(400);
    const key = randomUUID();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/mail/test",
          headers: { ...headers, "idempotency-key": key },
        })
      ).statusCode,
    ).toBe(202);
    expect(mail.test).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-a" }),
      key,
    );
  });
  it("verifies webhook bytes before passing bounded metadata to the service", async () => {
    const body = JSON.stringify({
      type: "email.received",
      data: {
        email_id: randomUUID(),
        to: ["support@example.test"],
        html: "<script>activate emergency</script>",
      },
    });
    const id = "msg_" + randomUUID(),
      date = new Date();
    const headers = {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": String(Math.floor(date.getTime() / 1000)),
      "svix-signature": new Webhook(secret).sign(id, date, body),
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/webhooks/resend",
          payload: body,
          headers,
        })
      ).statusCode,
    ).toBe(204);
    expect(mail.webhook.mock.calls[0]?.[1].data).not.toHaveProperty("html");
    expect(store.emergencies).toHaveLength(0);
    mail.webhook.mockClear();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/webhooks/resend",
          payload: body + " ",
          headers,
        })
      ).statusCode,
    ).toBe(401);
    expect(mail.webhook).not.toHaveBeenCalled();
  });
  it("rejects oversized webhook requests", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/webhooks/resend",
          headers: { "content-type": "application/json" },
          payload: "x".repeat(65537),
        })
      ).statusCode,
    ).toBe(413);
    expect(mail.webhook).not.toHaveBeenCalled();
  });
});
