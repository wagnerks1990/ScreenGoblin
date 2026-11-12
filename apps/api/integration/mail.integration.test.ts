import { randomBytes, randomUUID } from "node:crypto";
import { hash, compare } from "bcryptjs";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { PrismaStore } from "../src/store/prisma.js";
import { MailService, type MailPrincipal } from "../src/mail/service.js";
import {
  decryptPayload,
  digest,
  type MailPayload,
} from "../src/mail/crypto.js";
import type { MailConfig } from "../src/mail/config.js";
import type { MailTransport, SendResult } from "../src/mail/transport.js";
const url = new URL(process.env.DATABASE_URL ?? "http://invalid");
if (
  process.env.SCREEN_GOBLIN_ALLOW_TEST_DATABASE_RESET !== "true" ||
  url.pathname !== "/screengoblin_test" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
)
  throw new Error(
    "Mail integration tests require the isolated loopback screengoblin_test database and reset acknowledgement",
  );
const store = new PrismaStore(),
  prisma = store.prisma;
const config: MailConfig = {
  apiKey: "re_test_only_never_live_key",
  webhookSecret: "whsec_" + randomBytes(32).toString("base64"),
  encryptionKey: randomBytes(32).toString("base64url"),
  from: "no-reply@example.test",
  replyTo: "support@example.test",
  receivingDomain: "example.test",
  publicOrigin: "https://signage.example.test",
  offlineMinutes: 10,
};
class Provider implements MailTransport {
  calls: Array<{ payload: MailPayload; key: string }> = [];
  ids = new Map<string, string>();
  results: SendResult[] = [];
  beforeAccept: ((id: string) => Promise<void>) | undefined;
  async send(payload: MailPayload, key: string): Promise<SendResult> {
    this.calls.push({ payload, key });
    const id = this.ids.get(key) ?? randomUUID();
    this.ids.set(key, id);
    if (this.beforeAccept) await this.beforeAccept(id);
    return this.results.shift() ?? { accepted: true, providerId: id };
  }
}
let provider: Provider, mail: MailService, originalHash: string;
let ownerId: string,
  foreignId: string,
  first: MailPrincipal,
  foreign: MailPrincipal;
beforeAll(async () => {
  originalHash = await hash("original-account-password", 12);
});
beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Organization","User","DeviceKeyTombstone","LoginFailureEvent","MailDeliveryReceipt" RESTART IDENTITY CASCADE',
  );
  for (const id of ["mail-org-a", "mail-org-b", "mail-org-c"])
    await prisma.organization.create({ data: { id, name: id, slug: id } });
  ownerId = (
    await prisma.user.create({
      data: {
        email: "owner@example.test",
        name: "Test owner",
        passwordHash: originalHash,
      },
    })
  ).id;
  foreignId = (
    await prisma.user.create({
      data: {
        email: "foreign@example.test",
        name: "Foreign owner",
        passwordHash: originalHash,
      },
    })
  ).id;
  await prisma.membership.createMany({
    data: [
      { organizationId: "mail-org-a", userId: ownerId, role: "OWNER" },
      { organizationId: "mail-org-b", userId: ownerId, role: "OWNER" },
      { organizationId: "mail-org-c", userId: foreignId, role: "OWNER" },
    ],
  });
  async function principal(userId: string, organizationId: string) {
    const tokenHash = digest(randomUUID());
    await prisma.userSession.create({
      data: {
        userId,
        organizationId,
        tokenHash,
        authenticationEpoch: 0,
        authorizationEpoch: 0,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    return { userId, organizationId, tokenHash };
  }
  first = await principal(ownerId, "mail-org-a");
  await principal(ownerId, "mail-org-b");
  foreign = await principal(foreignId, "mail-org-c");
  provider = new Provider();
  mail = new MailService(prisma, config, provider);
});
afterAll(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Organization","User","DeviceKeyTombstone","LoginFailureEvent","MailDeliveryReceipt" RESTART IDENTITY CASCADE',
  );
  await store.close();
});
async function resetToken() {
  await mail.requestReset("owner@example.test");
  const job = await prisma.mailJob.findFirstOrThrow({
    where: { kind: "PASSWORD_RESET" },
    orderBy: { createdAt: "desc" },
  });
  const payload = decryptPayload(
    job.payloadEncrypted!,
    config.encryptionKey,
    job.id,
  );
  return { job, token: payload.text.match(/#token=([A-Za-z0-9_-]{43})/)![1]! };
}
async function pendingGrant() {
  const screen = await prisma.screen.create({
    data: { organizationId: first.organizationId, name: "Enrollment fixture" },
  });
  const member = await prisma.membership.findUniqueOrThrow({
    where: {
      organizationId_userId: {
        organizationId: first.organizationId,
        userId: ownerId,
      },
    },
  });
  const grant = await prisma.pairingCode.create({
    data: {
      id: randomBytes(32).toString("base64url"),
      organizationId: first.organizationId,
      purpose: "NEW_SCREEN",
      targetScreenId: screen.id,
      targetScreenReferenceId: screen.id,
      targetOrganizationId: first.organizationId,
      expectedGeneration: 0,
      authorizedByUserId: ownerId,
      authorizedByMembershipId: member.id,
      authorizedByAuthenticationEpoch: 0,
      authorizedByAuthorizationEpoch: 0,
      requestReason: "Integration fixture",
      codeHash: digest(randomUUID()),
      status: "PENDING",
      expiresAt: new Date(Date.now() + 1800_000),
    },
  });
  const attempt = await prisma.pairingAttempt.create({
    data: {
      id: randomBytes(32).toString("base64url"),
      organizationId: first.organizationId,
      pairingCodeId: grant.id,
      keyId: randomBytes(32).toString("base64url"),
      publicKeySpki: Buffer.alloc(91, 7),
      algorithm: "ES256",
      securityLevel: "software",
      challengeHashSha256: digest(randomUUID()),
      transcriptDigestSha256: digest(randomUUID()),
      expiresAt: new Date(Date.now() + 30_000),
    },
  });
  return { grant, attempt };
}
describe("Resend communications PostgreSQL integration", () => {
  it("stores only token hashes and encrypted queued mail, with nondestructive requests", async () => {
    const { token, job } = await resetToken();
    expect(job.payloadEncrypted).not.toContain(token);
    expect(job.payloadEncrypted).not.toContain("owner@example.test");
    const reset = await prisma.passwordResetRequest.findUniqueOrThrow({
      where: { tokenHash: digest(token) },
    });
    expect(reset.tokenHash).not.toEqual(token);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: ownerId } }))
        .passwordHash,
    ).toBe(originalHash);
    expect(
      await prisma.userSession.count({
        where: { userId: ownerId, revokedAt: null },
      }),
    ).toBe(2);
    expect(JSON.stringify(await prisma.auditEvent.findMany())).not.toContain(
      token,
    );
  });
  it("consumes reset links exactly once and atomically revokes all tenant authority", async () => {
    const { grant, attempt } = await pendingGrant();
    const { token } = await resetToken();
    await mail.confirmReset(token, "replacement-password-for-account");
    const owner = await prisma.user.findUniqueOrThrow({
      where: { id: ownerId },
    });
    expect(
      await compare("replacement-password-for-account", owner.passwordHash),
    ).toBe(true);
    expect(owner.authenticationEpoch).toBe(1);
    expect(owner.bootstrapPasswordExpiresAt).toBeNull();
    expect(
      await prisma.userSession.count({
        where: { userId: ownerId, revokedAt: null },
      }),
    ).toBe(0);
    expect(
      await prisma.userSession.count({
        where: { userId: foreignId, revokedAt: null },
      }),
    ).toBe(1);
    expect(
      (await prisma.pairingCode.findUniqueOrThrow({ where: { id: grant.id } }))
        .status,
    ).toBe("REVOKED");
    expect(
      (
        await prisma.pairingAttempt.findUniqueOrThrow({
          where: { id: attempt.id },
        })
      ).cancelledAt,
    ).not.toBeNull();
    expect(
      await prisma.auditEvent.count({
        where: { action: "auth.password_reset_completed" },
      }),
    ).toBe(2);
    await expect(
      mail.confirmReset(token, "another-replacement-password"),
    ).rejects.toThrow("invalid");
    expect(
      await prisma.mailJob.count({
        where: { kind: "PASSWORD_CHANGED", status: "PENDING" },
      }),
    ).toBe(1);
  });
  it("allows earlier unexpired links but invalidates every sibling after a successful reset", async () => {
    const one = await resetToken(),
      two = await resetToken();
    expect(one.token).not.toBe(two.token);
    await mail.confirmReset(one.token, "a-new-password-for-this-account");
    await expect(
      mail.confirmReset(two.token, "different-new-password-value"),
    ).rejects.toThrow("invalid");
  });
  it("serializes competing token consumption", async () => {
    const { token } = await resetToken();
    const values = ["first-competing-password", "second-competing-password"];
    const results = await Promise.allSettled(
      values.map((value) => mail.confirmReset(token, value)),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const index = results.findIndex((result) => result.status === "fulfilled");
    expect(
      await compare(
        values[index]!,
        (await prisma.user.findUniqueOrThrow({ where: { id: ownerId } }))
          .passwordHash,
      ),
    ).toBe(true);
    expect(
      await prisma.auditEvent.count({
        where: { action: "auth.password_reset_completed" },
      }),
    ).toBe(2);
  });
  it("rejects expired, reused-password and stale-epoch reset attempts", async () => {
    const { token } = await resetToken();
    await expect(
      mail.confirmReset(token, "original-account-password"),
    ).rejects.toThrow("different password");
    await store.rotateUserPasswordAndAudit(
      ownerId,
      await hash("operator-rotated-password", 12),
      { reason: "Integration rotation" },
    );
    await expect(
      mail.confirmReset(token, "another-account-password"),
    ).rejects.toThrow("invalid");
    const fresh = await resetToken();
    await prisma.passwordResetRequest.update({
      where: { tokenHash: digest(fresh.token) },
      data: {
        createdAt: new Date(Date.now() - 16 * 60_000),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    await expect(
      mail.confirmReset(fresh.token, "another-account-password"),
    ).rejects.toThrow("invalid");
  });
  it("does not queue mail for unknown or disabled identities", async () => {
    await mail.requestReset("missing@example.test");
    await prisma.user.update({
      where: { id: ownerId },
      data: { disabledAt: new Date() },
    });
    await mail.requestReset("owner@example.test");
    expect(await prisma.mailJob.count()).toBe(0);
    expect(await prisma.passwordResetRequest.count()).toBe(0);
  });
  it("bounds concurrently live reset tokens without revoking existing links on requests", async () => {
    for (let i = 0; i < 7; i++) await mail.requestReset("owner@example.test");
    expect(await prisma.passwordResetRequest.count()).toBe(5);
    expect(await prisma.mailJob.count()).toBe(5);
  });
  it("rolls back password, sessions, grants and token consumption when audit persistence fails", async () => {
    const { grant } = await pendingGrant(),
      { token } = await resetToken();
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "AuditEvent" ADD CONSTRAINT "mail_test_reject_reset" CHECK (action <> \'auth.password_reset_completed\')',
    );
    try {
      await expect(
        mail.confirmReset(token, "replacement-password-value"),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" DROP CONSTRAINT "mail_test_reject_reset"',
      );
    }
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: ownerId } }),
    ).toMatchObject({ passwordHash: originalHash, authenticationEpoch: 0 });
    expect(
      await prisma.userSession.count({
        where: { userId: ownerId, revokedAt: null },
      }),
    ).toBe(2);
    expect(
      (
        await prisma.passwordResetRequest.findUniqueOrThrow({
          where: { tokenHash: digest(token) },
        })
      ).consumedAt,
    ).toBeNull();
    expect(
      (await prisma.pairingCode.findUniqueOrThrow({ where: { id: grant.id } }))
        .status,
    ).toBe("PENDING");
  });
  it("binds mail settings and history to an exact active tenant session", async () => {
    const key = randomUUID(),
      one = await mail.test(first, key),
      again = await mail.test(first, key);
    expect(one).toEqual(again);
    expect(await prisma.mailJob.count()).toBe(1);
    await mail.test(foreign, key);
    const own = await mail.overview(first);
    expect(own.jobs.map((job) => job.id)).toEqual([one.id]);
    await expect(
      mail.overview({ ...first, organizationId: foreign.organizationId }),
    ).rejects.toThrow("cannot manage");
    await prisma.userSession.updateMany({
      where: { tokenHash: first.tokenHash },
      data: { revokedAt: new Date() },
    });
    await expect(mail.preferences(first, true)).rejects.toThrow(
      "cannot manage",
    );
  });
  it("deduplicates signed receipts and never imports mail content or targets another tenant", async () => {
    await mail.inbox(first, "support", true);
    await mail.inbox(foreign, "other", true);
    await expect(mail.inbox(foreign, "support", true)).rejects.toThrow(
      "unavailable",
    );
    const event = {
      type: "email.received",
      data: { email_id: randomUUID(), to: ["support@example.test"] },
    };
    await mail.webhook("event_inbound_one", event);
    await mail.webhook("event_inbound_one", event);
    expect((await mail.overview(first)).received).toHaveLength(1);
    expect((await mail.overview(foreign)).received).toHaveLength(0);
    expect(await prisma.inboundMailReceipt.count()).toBe(1);
    expect(
      await prisma.auditEvent.count({
        where: { action: "mail.inbound_received" },
      }),
    ).toBe(1);
    await mail.webhook("event_unmapped", {
      type: "email.received",
      data: { email_id: randomUUID(), to: ["unknown@example.test"] },
    });
    expect(await prisma.inboundMailReceipt.count()).toBe(1);
  });
  it("does not acknowledge persisted receipt success without its audit", async () => {
    await mail.inbox(first, "support", true);
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "AuditEvent" ADD CONSTRAINT "mail_test_reject_inbound" CHECK (action <> \'mail.inbound_received\')',
    );
    const event = {
      type: "email.received",
      data: { email_id: randomUUID(), to: ["support@example.test"] },
    };
    try {
      await expect(mail.webhook("event_rollback", event)).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" DROP CONSTRAINT "mail_test_reject_inbound"',
      );
    }
    expect(await prisma.inboundMailReceipt.count()).toBe(0);
    await mail.webhook("event_rollback", event);
    expect(await prisma.inboundMailReceipt.count()).toBe(1);
  });
  it("recovers a leased job and preserves provider idempotency across ambiguous retries", async () => {
    const job = await mail.test(first, randomUUID());
    provider.results.push({
      accepted: false,
      retryable: true,
      code: "NETWORK",
    });
    await mail.tick();
    const queued = await prisma.mailJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(queued).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(queued.availableAt.getTime()).toBeGreaterThan(Date.now() + 50_000);
    await prisma.mailJob.update({
      where: { id: job.id },
      data: {
        status: "SENDING",
        leaseToken: randomUUID(),
        lockedUntil: new Date(Date.now() - 1000),
      },
    });
    await new MailService(prisma, config, provider).tick();
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]!.key).toBe(provider.calls[1]!.key);
    expect(provider.ids.size).toBe(1);
    const final = await prisma.mailJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(final).toMatchObject({
      status: "ACCEPTED",
      attempts: 2,
      payloadEncrypted: null,
    });
  });
  it("prevents two workers from sending the same eligible job concurrently", async () => {
    await mail.test(first, randomUUID());
    await Promise.all([
      mail.tick(),
      new MailService(prisma, config, provider).tick(),
    ]);
    expect(provider.calls).toHaveLength(1);
    expect((await prisma.mailJob.findFirstOrThrow()).status).toBe("ACCEPTED");
  });
  it("reconciles delivery webhooks that arrive before the provider acknowledgement", async () => {
    const job = await mail.test(first, randomUUID());
    provider.beforeAccept = async (id) => {
      await mail.webhook("early_delivery", {
        type: "email.delivered",
        data: { email_id: id },
      });
    };
    await mail.tick();
    expect(
      (await prisma.mailJob.findUniqueOrThrow({ where: { id: job.id } }))
        .status,
    ).toBe("DELIVERED");
    const id = provider.ids.values().next().value!;
    await mail.webhook("duplicate_delivery", {
      type: "email.delivered",
      data: { email_id: id },
    });
    await mail.preferences(first, true);
    await mail.webhook("complaint", {
      type: "email.complained",
      data: { email_id: id },
    });
    expect((await mail.overview(first)).offlineAlertsEnabled).toBe(false);
    await mail.webhook("late_delivery", {
      type: "email.delivered",
      data: { email_id: id },
    });
    expect(
      (await prisma.mailJob.findUniqueOrThrow({ where: { id: job.id } }))
        .status,
    ).toBe("COMPLAINED");
  });
  it("deduplicates offline and recovery alerts, excluding unenrolled screens and unsubscribed tenants", async () => {
    await mail.preferences(first, true);
    const screen = await prisma.screen.create({
      data: {
        organizationId: first.organizationId,
        name: "Heartbeat fixture",
        lastSeenAt: new Date(Date.now() - 20 * 60_000),
      },
    });
    await prisma.screen.create({
      data: {
        organizationId: first.organizationId,
        name: "Never connected fixture",
      },
    });
    await prisma.screen.create({
      data: {
        organizationId: foreign.organizationId,
        name: "Foreign fixture",
        lastSeenAt: new Date(Date.now() - 20 * 60_000),
      },
    });
    await mail.tick();
    await mail.tick();
    expect(provider.calls).toHaveLength(1);
    expect((await prisma.mailJob.findFirstOrThrow()).kind).toBe(
      "SCREEN_OFFLINE",
    );
    expect(provider.calls[0]!.payload.text).not.toContain("Heartbeat fixture");
    await prisma.screen.update({
      where: { id: screen.id },
      data: { lastSeenAt: new Date() },
    });
    await mail.tick();
    await mail.tick();
    expect(provider.calls).toHaveLength(2);
    expect(
      await prisma.mailJob.count({ where: { kind: "SCREEN_RECOVERED" } }),
    ).toBe(1);
  });
  it("cancels queued alerts when a user opts out before a retry", async () => {
    await mail.preferences(first, true);
    await prisma.screen.create({
      data: {
        organizationId: first.organizationId,
        name: "Offline fixture",
        lastSeenAt: new Date(Date.now() - 20 * 60_000),
      },
    });
    provider.results.push({
      accepted: false,
      retryable: true,
      code: "NETWORK",
    });
    await mail.tick();
    await mail.preferences(first, false);
    await prisma.mailJob.updateMany({
      where: { status: "PENDING" },
      data: { availableAt: new Date(Date.now() - 1) },
    });
    await mail.tick();
    expect(provider.calls).toHaveLength(1);
    expect((await prisma.mailJob.findFirstOrThrow()).status).toBe("CANCELLED");
  });
});
