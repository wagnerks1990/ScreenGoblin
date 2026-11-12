import { randomBytes, randomUUID } from "node:crypto";
import { compare, hash } from "bcryptjs";
import type {
  Prisma,
  PrismaClient,
  MailKind,
  MailJob,
  MailStatus,
} from "@prisma/client";
import { ApiError } from "../utils/http.js";
import {
  decryptPayload,
  digest,
  encryptPayload,
  type MailPayload,
} from "./crypto.js";
import type { MailConfig } from "./config.js";
import type { MailTransport } from "./transport.js";
import type { MailEvent } from "./webhook.js";

export interface MailPrincipal {
  userId: string;
  organizationId: string;
  tokenHash: string;
}
export interface MailOverview {
  configured: boolean;
  receivingConfigured: boolean;
  workerHealthy: boolean;
  offlineMinutes: number;
  from?: string;
  inbox?: { address: string; enabled: boolean } | null;
  offlineAlertsEnabled: boolean;
  jobs: Array<{ id: string; kind: string; status: string; createdAt: string }>;
  received: Array<{ id: string; providerEmailId: string; receivedAt: string }>;
}
export interface MailApi {
  requestReset(email: string): Promise<void>;
  confirmReset(token: string, password: string): Promise<void>;
  overview(principal: MailPrincipal): Promise<MailOverview>;
  preferences(principal: MailPrincipal, enabled: boolean): Promise<void>;
  inbox(
    principal: MailPrincipal,
    localPart: string,
    enabled: boolean,
  ): Promise<void>;
  test(principal: MailPrincipal, key: string): Promise<{ id: string }>;
  webhook(id: string, event: MailEvent): Promise<void>;
  webhookSecret: string;
  close?(): Promise<void>;
}
type Target = {
  userId: string;
  organizationId: string;
  email: string;
  authenticationEpoch: number;
  databaseNow: Date;
};
type Tx = Prisma.TransactionClient;
const unavailable = () =>
  new ApiError(503, "MAIL_UNAVAILABLE", "Email is temporarily unavailable");
const invalidLink = () =>
  new ApiError(
    400,
    "INVALID_RESET_LINK",
    "The reset link is invalid, expired, or already used",
  );
const clock = async (tx: Tx) =>
  (
    await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`
  )[0]!.now;
const deliveryRank: Partial<Record<MailStatus, number>> = {
  ACCEPTED: 0,
  DELIVERED: 1,
  FAILED: 2,
  BOUNCED: 3,
  COMPLAINED: 4,
};

export class MailService implements MailApi {
  readonly webhookSecret: string;
  private timer: NodeJS.Timeout | undefined;
  private work: Promise<void> | undefined;
  private healthy = true;
  constructor(
    readonly prisma: PrismaClient,
    readonly config: MailConfig,
    readonly transport: MailTransport,
  ) {
    this.webhookSecret = config.webhookSecret;
  }
  private async principal(tx: Tx, p: MailPrincipal): Promise<Target> {
    const rows = await tx.$queryRaw<Target[]>`
      SELECT actor.id AS "userId", membership."organizationId", actor.email,
             actor."authenticationEpoch", CURRENT_TIMESTAMP AS "databaseNow"
      FROM "User" actor JOIN "Membership" membership ON membership."userId"=actor.id
      JOIN "UserSession" session ON session."userId"=actor.id AND session."organizationId"=membership."organizationId"
      WHERE actor.id=${p.userId} AND membership."organizationId"=${p.organizationId}
        AND membership.role::text IN ('OWNER','ADMIN') AND actor."disabledAt" IS NULL
        AND session."tokenHash"=${p.tokenHash} AND session."revokedAt" IS NULL
        AND session."expiresAt">CURRENT_TIMESTAMP AND session.purpose::text='FULL'
        AND session."authenticationEpoch"=actor."authenticationEpoch"
        AND session."authorizationEpoch"=membership."authorizationEpoch"
      FOR UPDATE OF actor,membership,session`;
    if (rows.length !== 1)
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Your current account cannot manage email",
      );
    return rows[0]!;
  }
  private async enqueue(
    tx: Tx,
    target: Target,
    kind: MailKind,
    eventKey: string,
    text: string,
    resetTokenHash?: string,
    screen?: { id: string; incidentId: string },
  ): Promise<{ id: string }> {
    const dedupeKey = digest(eventKey);
    const previous = await tx.mailJob.findUnique({
      where: { dedupeKey },
      select: { id: true },
    });
    if (previous) return previous;
    if (
      (await tx.mailJob.count({
        where: { organizationId: target.organizationId },
      })) >= 5000
    ) {
      const completed = await tx.mailJob.findMany({
        where: {
          organizationId: target.organizationId,
          status: { notIn: ["PENDING", "SENDING"] },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 100,
        select: { id: true },
      });
      if (!completed.length) throw unavailable();
      await tx.mailJob.deleteMany({
        where: { id: { in: completed.map((row) => row.id) } },
      });
    }
    const id = randomUUID();
    const subject = {
      PASSWORD_RESET: "Reset your ScreenGoblin password",
      PASSWORD_CHANGED: "Your ScreenGoblin password changed",
      SCREEN_OFFLINE: "ScreenGoblin: a screen is offline",
      SCREEN_RECOVERED: "ScreenGoblin: a screen recovered",
      TEST: "ScreenGoblin email delivery test",
    }[kind];
    const payload: MailPayload = {
      from: this.config.from,
      reply_to: this.config.replyTo,
      to: [target.email],
      subject,
      text,
    };
    return tx.mailJob.create({
      data: {
        id,
        organizationId: target.organizationId,
        userId: target.userId,
        authenticationEpoch: target.authenticationEpoch,
        kind,
        dedupeKey,
        payloadEncrypted: encryptPayload(
          payload,
          this.config.encryptionKey,
          id,
        ),
        ...(resetTokenHash ? { resetTokenHash } : {}),
        ...(screen
          ? { screenId: screen.id, incidentId: screen.incidentId }
          : {}),
        expiresAt: new Date(
          target.databaseNow.getTime() +
            (kind === "PASSWORD_RESET" ? 10 * 60_000 : 60 * 60_000),
        ),
      },
      select: { id: true },
    });
  }
  async requestReset(email: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Target[]>`
        SELECT actor.id AS "userId", membership."organizationId", actor.email,
               actor."authenticationEpoch", CURRENT_TIMESTAMP AS "databaseNow"
        FROM "User" actor JOIN "Membership" membership ON membership."userId"=actor.id
        WHERE actor.email=${email} AND actor."disabledAt" IS NULL
        ORDER BY membership."organizationId" ASC FOR UPDATE OF actor,membership`;
      const target = rows[0];
      if (!target) return;
      const count = await tx.passwordResetRequest.count({
        where: {
          userId: target.userId,
          consumedAt: null,
          expiresAt: { gt: target.databaseNow },
        },
      });
      if (count >= 5) return;
      const token = randomBytes(32).toString("base64url"),
        tokenHash = digest(token);
      const expiresAt = new Date(target.databaseNow.getTime() + 15 * 60_000);
      await tx.passwordResetRequest.create({
        data: {
          userId: target.userId,
          tokenHash,
          authenticationEpoch: target.authenticationEpoch,
          expiresAt,
        },
      });
      await this.enqueue(
        tx,
        target,
        "PASSWORD_RESET",
        "reset:" + tokenHash,
        "A password reset was requested for your ScreenGoblin account.\n\n" +
          this.config.publicOrigin +
          "/reset-password#token=" +
          token +
          "\n\nThis one-use link expires in 15 minutes. If you did not request this, ignore this email. Your password has not changed.",
        tokenHash,
      );
      await tx.auditEvent.createMany({
        data: rows.map((row) => ({
          organizationId: row.organizationId,
          actorType: "system",
          action: "auth.password_reset_requested",
          entityType: "user",
          entityId: target.userId,
          metadata: { source: "email-recovery" },
        })),
      });
    });
  }
  async confirmReset(token: string, password: string): Promise<void> {
    const passwordHash = await hash(password, 12);
    await this.prisma.$transaction(async (tx) => {
      const candidate = await tx.passwordResetRequest.findUnique({
        where: { tokenHash: digest(token) },
        select: { userId: true },
      });
      if (!candidate) throw invalidLink();
      const rows = await tx.$queryRaw<Array<Target & { passwordHash: string }>>`
        SELECT actor.id AS "userId",membership."organizationId",actor.email,actor."authenticationEpoch",
               actor."passwordHash",CURRENT_TIMESTAMP AS "databaseNow"
        FROM "User" actor JOIN "Membership" membership ON membership."userId"=actor.id
        WHERE actor.id=${candidate.userId} AND actor."disabledAt" IS NULL
        ORDER BY membership."organizationId" ASC FOR UPDATE OF actor,membership`;
      const target = rows[0];
      if (!target) throw invalidLink();
      const [reset] = await tx.$queryRaw<
        Array<{ id: string; authenticationEpoch: number }>
      >`
        SELECT id,"authenticationEpoch" FROM "PasswordResetRequest"
        WHERE "tokenHash"=${digest(token)} AND "consumedAt" IS NULL AND "expiresAt">CURRENT_TIMESTAMP
        FOR UPDATE`;
      if (!reset || reset.authenticationEpoch !== target.authenticationEpoch)
        throw invalidLink();
      if (await compare(password, target.passwordHash))
        throw new ApiError(
          400,
          "PASSWORD_REUSED",
          "Choose a different password from your current password",
        );
      const organizationIds = rows.map((row) => row.organizationId);
      const grants = await tx.pairingCode.findMany({
        where: {
          organizationId: { in: organizationIds },
          authorizedByUserId: target.userId,
          status: "PENDING",
        },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      await tx.pairingAttempt.updateMany({
        where: {
          pairingCodeId: { in: grants.map((g) => g.id) },
          boundCredentialId: null,
          cancelledAt: null,
        },
        data: { cancelledAt: target.databaseNow },
      });
      await tx.pairingCode.updateMany({
        where: { id: { in: grants.map((g) => g.id) }, status: "PENDING" },
        data: { status: "REVOKED" },
      });
      await tx.user.update({
        where: { id: target.userId },
        data: {
          passwordHash,
          bootstrapPasswordExpiresAt: null,
          authenticationEpoch: { increment: 1 },
        },
      });
      await tx.userSession.updateMany({
        where: { userId: target.userId, revokedAt: null },
        data: { revokedAt: target.databaseNow },
      });
      await tx.passwordResetRequest.updateMany({
        where: { userId: target.userId, consumedAt: null },
        data: { consumedAt: target.databaseNow },
      });
      await tx.mailJob.updateMany({
        where: {
          userId: target.userId,
          status: { in: ["PENDING", "SENDING"] },
        },
        data: {
          status: "CANCELLED",
          payloadEncrypted: null,
          leaseToken: null,
          lockedUntil: null,
        },
      });
      await this.enqueue(
        tx,
        { ...target, authenticationEpoch: target.authenticationEpoch + 1 },
        "PASSWORD_CHANGED",
        "changed:" + target.userId + ":" + (target.authenticationEpoch + 1),
        "Your ScreenGoblin password was changed using email recovery. All existing sessions and pending enrollment grants were revoked.\n\n" +
          "If this was not you, contact your administrator immediately.\n\nSign in: " +
          this.config.publicOrigin,
      );
      await tx.auditEvent.createMany({
        data: rows.map((row) => ({
          organizationId: row.organizationId,
          actorType: "system",
          action: "auth.password_reset_completed",
          entityType: "user",
          entityId: target.userId,
          metadata: {
            sessionsRevoked: true,
            pendingIssuerAuthorityRevoked: true,
            source: "email-recovery",
          },
        })),
      });
    });
  }
  async overview(p: MailPrincipal): Promise<MailOverview> {
    return this.prisma.$transaction(async (tx) => {
      await this.principal(tx, p);
      const [preference, inbox, jobs, received] = await Promise.all([
        tx.mailPreference.findUnique({
          where: {
            organizationId_userId: {
              organizationId: p.organizationId,
              userId: p.userId,
            },
          },
        }),
        tx.mailInbox.findUnique({
          where: { organizationId: p.organizationId },
          select: { address: true, enabled: true },
        }),
        tx.mailJob.findMany({
          where: { organizationId: p.organizationId },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 30,
          select: { id: true, kind: true, status: true, createdAt: true },
        }),
        tx.inboundMailReceipt.findMany({
          where: { organizationId: p.organizationId },
          orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
          take: 30,
          select: { id: true, providerEmailId: true, receivedAt: true },
        }),
      ]);
      return {
        configured: true,
        receivingConfigured: true,
        workerHealthy: this.healthy,
        offlineMinutes: this.config.offlineMinutes,
        from: this.config.from,
        inbox,
        offlineAlertsEnabled: preference?.offlineAlertsEnabled ?? false,
        jobs: jobs.map((j) => ({ ...j, createdAt: j.createdAt.toISOString() })),
        received: received.map((m) => ({
          ...m,
          receivedAt: m.receivedAt.toISOString(),
        })),
      };
    });
  }
  async preferences(p: MailPrincipal, enabled: boolean) {
    await this.prisma.$transaction(async (tx) => {
      await this.principal(tx, p);
      await tx.mailPreference.upsert({
        where: {
          organizationId_userId: {
            organizationId: p.organizationId,
            userId: p.userId,
          },
        },
        create: {
          organizationId: p.organizationId,
          userId: p.userId,
          offlineAlertsEnabled: enabled,
        },
        update: { offlineAlertsEnabled: enabled },
      });
      await tx.auditEvent.create({
        data: {
          organizationId: p.organizationId,
          actorUserId: p.userId,
          actorType: "user",
          action: "mail.preferences_changed",
          entityType: "user",
          entityId: p.userId,
          metadata: { offlineAlertsEnabled: enabled },
        },
      });
    });
  }
  async inbox(p: MailPrincipal, localPart: string, enabled: boolean) {
    await this.prisma.$transaction(async (tx) => {
      await this.principal(tx, p);
      const address = localPart + "@" + this.config.receivingDomain;
      const other = await tx.mailInbox.findUnique({ where: { address } });
      if (other && other.organizationId !== p.organizationId)
        throw new ApiError(
          409,
          "MAILBOX_UNAVAILABLE",
          "That mailbox is unavailable",
        );
      await tx.mailInbox.upsert({
        where: { organizationId: p.organizationId },
        create: { organizationId: p.organizationId, address, enabled },
        update: { address, enabled },
      });
      await tx.auditEvent.create({
        data: {
          organizationId: p.organizationId,
          actorUserId: p.userId,
          actorType: "user",
          action: "mail.inbox_configured",
          entityType: "organization",
          entityId: p.organizationId,
          metadata: { enabled },
        },
      });
    });
  }
  async test(p: MailPrincipal, key: string) {
    return this.prisma.$transaction(async (tx) => {
      const target = await this.principal(tx, p);
      const job = await this.enqueue(
        tx,
        target,
        "TEST",
        "test:" + p.organizationId + ":" + p.userId + ":" + key,
        "This is a delivery test requested from your ScreenGoblin account. No screen content or student information is included.\n\n" +
          this.config.publicOrigin,
      );
      // Idempotent retries share the same job and audit identity.
      const action = "mail.test_requested";
      if (
        !(await tx.auditEvent.findFirst({
          where: { organizationId: p.organizationId, action, entityId: job.id },
          select: { id: true },
        }))
      )
        await tx.auditEvent.create({
          data: {
            organizationId: p.organizationId,
            actorUserId: p.userId,
            actorType: "user",
            action,
            entityType: "mail",
            entityId: job.id,
            metadata: {},
          },
        });
      return job;
    });
  }
  async webhook(id: string, event: MailEvent) {
    if (event.type === "email.received") {
      const addresses = [
        ...new Set(
          (event.data.to ?? [])
            .map((v) => v.trim().toLowerCase())
            .filter((v) => v.endsWith("@" + this.config.receivingDomain)),
        ),
      ];
      for (const address of addresses)
        await this.prisma.$transaction(async (tx) => {
          const [inbox] = await tx.$queryRaw<
            Array<{ organizationId: string }>
          >`SELECT "organizationId" FROM "MailInbox" WHERE address=${address} AND enabled=true FOR UPDATE`;
          if (!inbox) return;
          if (
            await tx.inboundMailReceipt.findFirst({
              where: {
                organizationId: inbox.organizationId,
                OR: [
                  { eventHash: digest(id) },
                  { providerEmailId: event.data.email_id },
                ],
              },
            })
          )
            return;
          const stale = await tx.inboundMailReceipt.findMany({
            where: {
              organizationId: inbox.organizationId,
              receivedAt: { lt: new Date(Date.now() - 7 * 86400_000) },
            },
            select: { id: true },
            take: 100,
          });
          await tx.inboundMailReceipt.deleteMany({
            where: { id: { in: stale.map((r) => r.id) } },
          });
          if (
            (await tx.inboundMailReceipt.count({
              where: { organizationId: inbox.organizationId },
            })) >= 1000
          )
            return;
          await tx.inboundMailReceipt.create({
            data: {
              organizationId: inbox.organizationId,
              providerEmailId: event.data.email_id,
              eventHash: digest(id),
            },
          });
          await tx.auditEvent.create({
            data: {
              organizationId: inbox.organizationId,
              actorType: "system",
              action: "mail.inbound_received",
              entityType: "mail",
              entityId: event.data.email_id,
              metadata: { contentImported: false },
            },
          });
        });
      return;
    }
    const statuses: Record<string, MailStatus | undefined> = {
      "email.delivered": "DELIVERED",
      "email.bounced": "BOUNCED",
      "email.complained": "COMPLAINED",
      "email.failed": "FAILED",
    };
    const status = statuses[event.type];
    if (!status) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended('mail-delivery-receipts',0))`;
      if (
        await tx.mailDeliveryReceipt.findUnique({
          where: { eventHash: digest(id) },
        })
      )
        return;
      if ((await tx.mailDeliveryReceipt.count()) < 5000)
        await tx.mailDeliveryReceipt.create({
          data: {
            eventHash: digest(id),
            providerEmailId: event.data.email_id,
            status,
          },
        });
      const [job] = await tx.$queryRaw<
        Array<{ id: string; organizationId: string; status: MailStatus }>
      >`SELECT id,"organizationId",status FROM "MailJob" WHERE "providerEmailId"=${event.data.email_id} FOR UPDATE`;
      if (
        !job ||
        (deliveryRank[status] ?? 0) <= (deliveryRank[job.status] ?? 0)
      )
        return;
      await tx.mailJob.update({ where: { id: job.id }, data: { status } });
      if (status === "COMPLAINED") {
        const target = await tx.mailJob.findUniqueOrThrow({
          where: { id: job.id },
          select: { userId: true },
        });
        await tx.mailPreference.updateMany({
          where: { organizationId: job.organizationId, userId: target.userId },
          data: { offlineAlertsEnabled: false },
        });
      }
      await tx.auditEvent.create({
        data: {
          organizationId: job.organizationId,
          actorType: "system",
          action: "mail.delivery_updated",
          entityType: "mail",
          entityId: job.id,
          metadata: { status },
        },
      });
    });
  }
  private async fleet() {
    const screens = await this.prisma.$queryRaw<
      Array<{ id: string; organizationId: string }>
    >`
      SELECT screen.id,screen."organizationId" FROM "Screen" screen
      LEFT JOIN "FleetMailState" state ON state."screenId"=screen.id
      WHERE screen."lastSeenAt" IS NOT NULL
      ORDER BY state."checkedAt" ASC NULLS FIRST,screen.id ASC LIMIT 100`;
    for (const candidate of screens)
      await this.prisma.$transaction(async (tx) => {
        const [screen] = await tx.$queryRaw<
          Array<{ lastSeenAt: Date; now: Date }>
        >`SELECT "lastSeenAt",CURRENT_TIMESTAMP AS now FROM "Screen" WHERE id=${candidate.id} AND "organizationId"=${candidate.organizationId} FOR UPDATE`;
        if (!screen?.lastSeenAt) return;
        const before = await tx.fleetMailState.findUnique({
          where: { screenId: candidate.id },
        });
        const age = screen.now.getTime() - screen.lastSeenAt.getTime();
        const offline = before?.offline
          ? age > 120_000
          : age > this.config.offlineMinutes * 60_000;
        const incidentId =
          offline && !before?.offline
            ? randomUUID()
            : (before?.incidentId ?? randomUUID());
        await tx.fleetMailState.upsert({
          where: { screenId: candidate.id },
          create: {
            screenId: candidate.id,
            organizationId: candidate.organizationId,
            offline,
            incidentId,
            checkedAt: screen.now,
          },
          update: { offline, incidentId, checkedAt: screen.now },
        });
        if ((!before && !offline) || (before && before.offline === offline))
          return;
        const recipients = await tx.mailPreference.findMany({
          where: {
            organizationId: candidate.organizationId,
            offlineAlertsEnabled: true,
            membership: {
              role: { in: ["OWNER", "ADMIN"] },
              user: { disabledAt: null },
            },
          },
          include: { membership: { include: { user: true } } },
          take: 100,
        });
        for (const recipient of recipients) {
          const member = recipient.membership,
            actor = member.user;
          if (!offline) {
            const initial = await tx.mailJob.findUnique({
              where: {
                dedupeKey: digest(
                  "fleet:" + incidentId + ":SCREEN_OFFLINE:" + actor.id,
                ),
              },
            });
            if (!initial || initial.attempts === 0) continue;
          }
          const kind = offline ? "SCREEN_OFFLINE" : "SCREEN_RECOVERED";
          await this.enqueue(
            tx,
            {
              userId: actor.id,
              organizationId: candidate.organizationId,
              email: actor.email,
              authenticationEpoch: actor.authenticationEpoch,
              databaseNow: screen.now,
            },
            kind,
            "fleet:" + incidentId + ":" + kind + ":" + actor.id,
            (offline
              ? "A screen has stopped reporting its heartbeat."
              : "A screen is reporting again.") +
              "\n\nSign in to review the screen fleet: " +
              this.config.publicOrigin +
              "/screens" +
              "\n\nThese operational notifications are not emergency or life-safety messages.",
            undefined,
            { id: candidate.id, incidentId },
          );
        }
      });
  }
  private async claim(): Promise<MailJob | null> {
    const lease = randomUUID();
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      WITH candidate AS (
        SELECT id FROM "MailJob"
        WHERE "expiresAt">CURRENT_TIMESTAMP AND attempts<5
          AND ((status='PENDING'::"MailStatus" AND "availableAt"<=CURRENT_TIMESTAMP)
            OR (status='SENDING'::"MailStatus" AND "lockedUntil"<=CURRENT_TIMESTAMP))
        ORDER BY "createdAt",id FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE "MailJob" job SET status='SENDING'::"MailStatus","leaseToken"=${lease},
        "lockedUntil"=CURRENT_TIMESTAMP+INTERVAL '30 seconds',attempts=attempts+1,"updatedAt"=CURRENT_TIMESTAMP
      FROM candidate WHERE job.id=candidate.id RETURNING job.id`;
    return rows[0]
      ? this.prisma.mailJob.findUnique({ where: { id: rows[0].id } })
      : null;
  }
  private async dispatch(job: MailJob) {
    const finish = (data: Prisma.MailJobUpdateManyMutationInput) =>
      this.prisma.mailJob.updateMany({
        where: { id: job.id, leaseToken: job.leaseToken, status: "SENDING" },
        data: { leaseToken: null, lockedUntil: null, ...data },
      });
    const member = await this.prisma.membership.findUnique({
      where: {
        organizationId_userId: {
          organizationId: job.organizationId,
          userId: job.userId,
        },
      },
      select: {
        role: true,
        user: {
          select: {
            id: true,
            email: true,
            disabledAt: true,
            authenticationEpoch: true,
          },
        },
        mailPreference: true,
      },
    });
    if (
      !member ||
      member.user.disabledAt ||
      member.user.authenticationEpoch !== job.authenticationEpoch ||
      !job.payloadEncrypted
    ) {
      await finish({ status: "CANCELLED", payloadEncrypted: null });
      return;
    }
    if (job.kind === "SCREEN_OFFLINE" || job.kind === "SCREEN_RECOVERED") {
      if (
        !["OWNER", "ADMIN"].includes(member.role) ||
        !member.mailPreference?.offlineAlertsEnabled
      ) {
        await finish({ status: "CANCELLED", payloadEncrypted: null });
        return;
      }
      const state = job.screenId
        ? await this.prisma.fleetMailState.findUnique({
            where: { screenId: job.screenId },
          })
        : null;
      if (
        !state ||
        state.incidentId !== job.incidentId ||
        state.offline !== (job.kind === "SCREEN_OFFLINE")
      ) {
        await finish({ status: "CANCELLED", payloadEncrypted: null });
        return;
      }
    }
    if (job.kind === "PASSWORD_RESET") {
      const reset = await this.prisma.passwordResetRequest.findUnique({
        where: { tokenHash: job.resetTokenHash ?? "" },
      });
      if (
        !reset ||
        reset.consumedAt ||
        reset.authenticationEpoch !== member.user.authenticationEpoch ||
        reset.expiresAt <= new Date()
      ) {
        await finish({ status: "CANCELLED", payloadEncrypted: null });
        return;
      }
    }
    let payload: MailPayload;
    try {
      payload = decryptPayload(
        job.payloadEncrypted,
        this.config.encryptionKey,
        job.id,
      );
    } catch {
      await finish({
        status: "FAILED",
        payloadEncrypted: null,
        failureCode: "PAYLOAD_INVALID",
      });
      return;
    }
    if (
      payload.to[0] !== member.user.email ||
      payload.from !== this.config.from
    ) {
      await finish({ status: "CANCELLED", payloadEncrypted: null });
      return;
    }
    const result = await this.transport.send(
      payload,
      "screengoblin-mail/" + job.id,
    );
    if (result.accepted) {
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended('mail-delivery-receipts',0))`;
        const receipts = await tx.mailDeliveryReceipt.findMany({
          where: { providerEmailId: result.providerId },
          select: { status: true },
        });
        const status = receipts.reduce<MailStatus>(
          (current, receipt) =>
            (deliveryRank[receipt.status] ?? 0) > (deliveryRank[current] ?? 0)
              ? receipt.status
              : current,
          "ACCEPTED",
        );
        const updated = await tx.mailJob.updateMany({
          where: { id: job.id, leaseToken: job.leaseToken, status: "SENDING" },
          data: {
            status,
            providerEmailId: result.providerId,
            payloadEncrypted: null,
            failureCode: null,
            leaseToken: null,
            lockedUntil: null,
          },
        });
        if (updated.count && status !== "ACCEPTED") {
          if (status === "COMPLAINED")
            await tx.mailPreference.updateMany({
              where: { organizationId: job.organizationId, userId: job.userId },
              data: { offlineAlertsEnabled: false },
            });
          await tx.auditEvent.create({
            data: {
              organizationId: job.organizationId,
              actorType: "system",
              action: "mail.delivery_updated",
              entityType: "mail",
              entityId: job.id,
              metadata: { status },
            },
          });
        }
      });
      return;
    }
    const delay = Math.max(
      60 * Math.pow(2, job.attempts - 1),
      result.retryAfterSeconds ?? 0,
    );
    const retryClock = await clock(this.prisma);
    const availableAt = new Date(
      Math.max(
        retryClock.getTime() + delay * 1000,
        Date.parse(result.retryAt ?? "") || 0,
      ),
    );
    if (
      !result.retryable ||
      job.attempts >= 5 ||
      availableAt >= job.expiresAt
    ) {
      await finish({
        status: "FAILED",
        payloadEncrypted: null,
        failureCode: result.code,
      });
      return;
    }
    await finish({ status: "PENDING", availableAt, failureCode: result.code });
  }
  private async prune() {
    const now = await clock(this.prisma);
    await this.prisma.mailJob.updateMany({
      where: {
        status: { in: ["PENDING", "SENDING"] },
        OR: [
          { expiresAt: { lte: now } },
          { attempts: { gte: 5 }, lockedUntil: { lte: now } },
        ],
      },
      data: {
        status: "FAILED",
        payloadEncrypted: null,
        leaseToken: null,
        lockedUntil: null,
        failureCode: "EXPIRED_OR_ATTEMPTS",
      },
    });
    const cutoff = new Date(now.getTime() - 7 * 86400_000);
    const old = await this.prisma.mailJob.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      take: 100,
    });
    await this.prisma.mailJob.deleteMany({
      where: { id: { in: old.map((row) => row.id) } },
    });
    const resets = await this.prisma.passwordResetRequest.findMany({
      where: { expiresAt: { lt: cutoff } },
      select: { id: true },
      take: 100,
    });
    await this.prisma.passwordResetRequest.deleteMany({
      where: { id: { in: resets.map((row) => row.id) } },
    });
    const receipts = await this.prisma.mailDeliveryReceipt.findMany({
      where: { receivedAt: { lt: new Date(now.getTime() - 86400_000) } },
      select: { eventHash: true },
      take: 100,
    });
    await this.prisma.mailDeliveryReceipt.deleteMany({
      where: { eventHash: { in: receipts.map((row) => row.eventHash) } },
    });
    const incoming = await this.prisma.inboundMailReceipt.findMany({
      where: { receivedAt: { lt: cutoff } },
      select: { id: true },
      take: 100,
    });
    await this.prisma.inboundMailReceipt.deleteMany({
      where: { id: { in: incoming.map((row) => row.id) } },
    });
  }
  tick(): Promise<void> {
    if (this.work) return this.work;
    this.work = (async () => {
      try {
        await this.prune();
        let fleetFailed = false;
        try {
          await this.fleet();
        } catch {
          fleetFailed = true;
        }
        for (let i = 0; i < 10; i++) {
          const job = await this.claim();
          if (!job) break;
          await this.dispatch(job);
        }
        if (fleetFailed)
          throw new Error("Fleet notification generation failed");
        this.healthy = true;
      } catch {
        this.healthy = false;
        throw new Error("Mail background processing failed");
      }
    })().finally(() => {
      this.work = undefined;
    });
    return this.work;
  }
  start(onFailure: () => void) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(onFailure), 15_000);
    this.timer.unref();
    void this.tick().catch(onFailure);
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.work?.catch(() => undefined);
  }
}
