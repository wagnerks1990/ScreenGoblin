import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Prisma } from "@prisma/client";
import { compare, hash } from "bcryptjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mediaStorageKey } from "../src/media/delivery.js";
import { PrismaStore } from "../src/store/prisma.js";
import {
  DATABASE_MAINTENANCE_BATCH_SIZE,
  DEVICE_AUTH_CHALLENGE_RETENTION_MS,
  LOGIN_FAILURE_MAX_RECORDS,
} from "../src/domain/types.js";
import { opaqueSecurityEventKey } from "../src/utils/rate-limit.js";
import {
  assignmentSnapshotDigest,
  canonicalAssignmentSnapshot,
  hasValidStoredAssignmentDigest,
  hasValidStoredReleaseDigest,
} from "../src/releases/canonical.js";
import { randomToken } from "../src/utils/crypto.js";
import {
  BOOTSTRAP_RECOVERY_ACKNOWLEDGEMENT,
  recoverBootstrapPassword,
} from "../src/recovery/bootstrap-password.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required for PostgreSQL integration tests; run migrations before this suite",
  );
}
if (process.env.SCREEN_GOBLIN_ALLOW_TEST_DATABASE_RESET !== "true") {
  throw new Error(
    "SCREEN_GOBLIN_ALLOW_TEST_DATABASE_RESET=true is required because this suite truncates its database",
  );
}
const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
const databaseHost = new URL(databaseUrl).hostname;
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
if (databaseName !== "screengoblin_test" || !loopbackHosts.has(databaseHost)) {
  throw new Error(
    "Refusing to truncate PostgreSQL: integration tests require the exact " +
      'database name "screengoblin_test" on a loopback host',
  );
}

const store = new PrismaStore();
const prisma = store.prisma;
const proofHash = () => randomUUID().replaceAll("-", "").repeat(2);
const publicationIdempotency = () => ({
  keyHash: proofHash(),
  requestDigestSha256: proofHash(),
});
const expectPrismaTriggerRejected = async (
  operation: Promise<unknown>,
  databaseMessage: string,
) => {
  const error = await operation.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(databaseMessage);
  const prismaError = error as {
    code?: unknown;
    meta?: { code?: unknown };
    name?: unknown;
  };
  if (prismaError.code === "P2010") {
    expect(prismaError.meta?.code).toBe("55000");
  } else {
    // Deferred constraint failures surface at interactive-transaction commit.
    // Prisma may omit the SQLSTATE from this wrapper, but preserves the exact
    // server message asserted above.
    expect(prismaError.name).toBe("PrismaClientUnknownRequestError");
  }
};
const approvedPasswordHash =
  "$2b$12$C6UzMDM.H6dfI/f/IKcEe.82jG7y4g4AY8I8HibLFSWafVkx8S4hS";
const deferred = () => {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};
const waitForOwnerContinuityWaiters = async (minimum: number) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [activity] = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::integer AS "count"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query LIKE '%FOR NO KEY UPDATE OF organization%'`;
    if ((activity?.count ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for ${minimum} owner-continuity transaction(s)`,
  );
};
const waitForBlockedStatement = async (queryFragment: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [activity] = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::integer AS "count"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query LIKE ${`%${queryFragment}%`}`;
    if ((activity?.count ?? 0) >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for blocked query: ${queryFragment}`);
};
const queueMembershipRowOperations = async (
  organizationId: string,
  userId: string,
  operations: ReadonlyArray<{
    waitFor: string;
    run: () => Promise<unknown>;
  }>,
) => {
  const acquired = deferred();
  const release = deferred();
  const holder = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT held_membership."id"
      FROM "Membership" held_membership
      WHERE held_membership."organizationId" = ${organizationId}
        AND held_membership."userId" = ${userId}
      FOR UPDATE OF held_membership`;
    acquired.resolve();
    await release.promise;
  });
  const holderSettled = holder.then(
    () => ({ succeeded: true as const }),
    (error: unknown) => {
      acquired.reject(error);
      return { succeeded: false as const, error };
    },
  );
  const operationSettled: Array<
    Promise<
      | { succeeded: true; result: unknown }
      | { succeeded: false; error: unknown }
    >
  > = [];
  let barrierError: unknown;
  try {
    await acquired.promise;
    for (const operation of operations) {
      let settled = false;
      const pending = operation.run().then(
        (result) => {
          settled = true;
          return { succeeded: true as const, result };
        },
        (error: unknown) => {
          settled = true;
          return { succeeded: false as const, error };
        },
      );
      operationSettled.push(pending);
      await waitForBlockedStatement(operation.waitFor);
      if (settled)
        throw new Error("Membership operation completed before lock release");
    }
  } catch (error) {
    barrierError = error;
  } finally {
    release.resolve();
  }
  const [holderResult, operationResults] = await Promise.all([
    holderSettled,
    Promise.all(operationSettled),
  ]);
  if (barrierError) throw barrierError;
  if (!holderResult.succeeded) throw holderResult.error;
  return operationResults.map((result) => {
    if (!result.succeeded) throw result.error;
    return result.result;
  });
};
const queueOwnerContinuityOperations = async <T>(
  organizationId: string,
  operations: ReadonlyArray<() => Promise<T>>,
) => {
  const acquired = deferred();
  const release = deferred();
  const holder = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT organization."id"
      FROM "Organization" organization
      WHERE organization."id" = ${organizationId}
      FOR NO KEY UPDATE OF organization`;
    acquired.resolve();
    await release.promise;
  });
  const holderSettled = holder.then(
    () => ({ succeeded: true as const }),
    (error: unknown) => {
      acquired.reject(error);
      return { succeeded: false as const, error };
    },
  );
  try {
    await acquired.promise;
  } catch (error) {
    release.resolve();
    await holderSettled;
    throw error;
  }
  const resultsSettled = Promise.all(
    operations.map((operation) => operation()),
  ).then(
    (results) => ({ succeeded: true as const, results }),
    (error: unknown) => ({ succeeded: false as const, error }),
  );
  let barrierError: unknown;
  try {
    await waitForOwnerContinuityWaiters(operations.length);
  } catch (error) {
    barrierError = error;
  } finally {
    release.resolve();
    await holderSettled;
  }
  const [holderResult, operationResult] = await Promise.all([
    holderSettled,
    resultsSettled,
  ]);
  if (barrierError) throw barrierError;
  if (!holderResult.succeeded) throw holderResult.error;
  if (!operationResult.succeeded) throw operationResult.error;
  return operationResult.results;
};
const proofEnrollment = (byte: number) => ({
  keyId: Buffer.alloc(32, byte).toString("base64url"),
  publicKeySpki: Buffer.alloc(91, byte).toString("base64url"),
  algorithm: "ES256" as const,
  securityLevel: "trusted-environment" as const,
});

const createOrganization = (label: string) =>
  prisma.organization.create({
    data: {
      name: `Integration ${label}`,
      slug: `integration-${label}-${randomUUID()}`,
    },
  });

const createUser = (email: string) =>
  prisma.user.create({
    data: {
      email,
      name: "Integration User",
      passwordHash: "integration-test-hash",
    },
  });

const createMember = async (
  organizationId: string,
  role: "OWNER" | "ADMIN" | "PUBLISHER" | "VIEWER",
  label: string,
  disabled = false,
) => {
  const user = await prisma.user.create({
    data: {
      email: `${label}-${randomUUID()}@example.test`,
      name: `Integration ${role}`,
      passwordHash: "integration-test-hash",
      ...(disabled ? { disabledAt: new Date() } : {}),
    },
  });
  await prisma.membership.create({
    data: { organizationId, userId: user.id, role },
  });
  return user;
};

const createBootstrapRecoveryFixture = async (
  label: string,
  currentPassword = `${label}-current-owner-password`,
  includeSecondMembership = false,
) => {
  const organization = await createOrganization(label);
  const actor = await createMember(organization.id, "OWNER", label);
  const currentPasswordHash = await hash(currentPassword, 4);
  await prisma.user.update({
    where: { id: actor.id },
    data: { passwordHash: currentPasswordHash },
  });
  const membership = await prisma.membership.findUniqueOrThrow({
    where: {
      organizationId_userId: {
        organizationId: organization.id,
        userId: actor.id,
      },
    },
  });
  const organizations = [organization];
  if (includeSecondMembership) {
    const otherOrganization = await createOrganization(`${label}-other`);
    await prisma.membership.create({
      data: {
        organizationId: otherOrganization.id,
        userId: actor.id,
        role: "VIEWER",
      },
    });
    organizations.push(otherOrganization);
  }
  const sessions = await Promise.all(
    organizations.map((candidate) =>
      prisma.userSession.create({
        data: {
          organizationId: candidate.id,
          userId: actor.id,
          tokenHash: proofHash(),
          authenticationEpoch: 0,
          authorizationEpoch: 0,
          expiresAt: new Date(Date.now() + 30 * 60_000),
        },
      }),
    ),
  );
  const screen = await prisma.screen.create({
    data: { organizationId: organization.id, name: `${label} screen` },
  });
  const grant = await prisma.pairingCode.create({
    data: {
      id: randomToken(),
      organizationId: organization.id,
      purpose: "NEW_SCREEN",
      targetScreenId: screen.id,
      targetScreenReferenceId: screen.id,
      targetOrganizationId: organization.id,
      expectedGeneration: 0,
      authorizedByUserId: actor.id,
      authorizedByMembershipId: membership.id,
      authorizedByAuthenticationEpoch: 0,
      authorizedByAuthorizationEpoch: 0,
      requestReason: "Bootstrap recovery integration fixture",
      codeHash: proofHash(),
      status: "PENDING",
      expiresAt: new Date(Date.now() + 30 * 60_000),
    },
  });
  const attempt = await prisma.pairingAttempt.create({
    data: {
      id: randomToken(),
      organizationId: organization.id,
      pairingCodeId: grant.id,
      keyId: randomToken(),
      publicKeySpki: Buffer.alloc(91, 7),
      algorithm: "ES256",
      securityLevel: "software",
      challengeHashSha256: proofHash(),
      transcriptDigestSha256: proofHash(),
      expiresAt: new Date(Date.now() + 30_000),
    },
  });
  return {
    actor: { ...actor, passwordHash: currentPasswordHash },
    organizations,
    sessions,
    grant,
    attempt,
  };
};

const publishApprovedSchedule = async (
  organizationId: string,
  data: Omit<
    Parameters<PrismaStore["createReleaseCandidateAndAudit"]>[1],
    "expiresAt"
  >,
  audit: Parameters<PrismaStore["createReleaseCandidateAndAudit"]>[2],
  policy: Parameters<PrismaStore["createReleaseCandidateAndAudit"]>[3],
  publishIdempotency: Parameters<
    PrismaStore["publishReleaseCandidateAndAudit"]
  >[5],
) => {
  const created = await store.createReleaseCandidateAndAudit(
    organizationId,
    {
      ...data,
      expiresAt: new Date(Date.now() + 6 * 24 * 60 * 60_000).toISOString(),
    },
    audit,
    policy,
    publicationIdempotency(),
  );
  if (!created.completed)
    return { published: false as const, reason: created.reason };
  const submitted = await store.submitReleaseCandidateAndAudit(
    organizationId,
    created.candidate.id,
    created.candidate.digestSha256,
    audit,
    publicationIdempotency(),
  );
  if (!submitted.completed)
    return { published: false as const, reason: submitted.reason };
  const approver = await createMember(
    organizationId,
    "ADMIN",
    "fixture-release-approver",
  );
  const approved = await store.approveReleaseCandidateAndAudit(
    organizationId,
    created.candidate.id,
    created.candidate.digestSha256,
    { actorUserId: approver.id },
    publicationIdempotency(),
  );
  if (!approved.completed)
    return { published: false as const, reason: approved.reason };
  const published = await store.publishReleaseCandidateAndAudit(
    organizationId,
    created.candidate.id,
    created.candidate.digestSha256,
    audit,
    policy,
    publishIdempotency,
  );
  if (!published.completed)
    return { published: false as const, reason: published.reason };
  const schedule = (await store.listSchedules(organizationId)).find(
    ({ id }) => id === published.candidate.scheduleId,
  );
  const active = await store.activeOrdinaryReleases(
    organizationId,
    published.candidate.screenIds[0]!,
    published.candidate.schedule.startsAt,
  );
  const match = active.find(
    ({ release }) => release.id === published.candidate.releaseId,
  );
  if (!schedule || !match)
    throw new Error("Approved publication fixture is incomplete");
  return {
    published: true as const,
    schedule,
    release: match.release,
    assignment: match.assignment,
    ...(published.replayed ? { replayed: true as const } : {}),
  };
};

const createPublicationFixture = async (
  organizationId: string,
  actorUserId: string,
  label: string,
) => {
  const screen = await store.createScreen(organizationId, {
    name: `${label} screen`,
    location: "",
    orientation: "landscape",
    resolution: "1920x1080",
    tags: [],
  });
  const media = await store.createMedia(organizationId, {
    name: `${label} asset`,
    kind: "image",
    mimeType: "image/png",
    url: `https://media.example.test/${label}.png`,
    checksumSha256: "d".repeat(64),
    sizeBytes: 100,
  });
  const playlist = await store.createPlaylist(organizationId, {
    name: `${label} playlist`,
    description: "",
    items: [
      {
        id: "ignored",
        assetId: media.id,
        position: 0,
        durationSeconds: 10,
      },
    ],
  });
  const publication = await publishApprovedSchedule(
    organizationId,
    {
      playlistId: playlist.id,
      name: `${label} schedule`,
      priority: "normal",
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      timezone: "UTC",
      daysOfWeek: [],
      enabled: true,
      screenIds: [screen.id],
    },
    { actorUserId },
    { mediaAllowedOrigins: ["https://media.example.test"] },
    publicationIdempotency(),
  );
  if (!publication.published) throw new Error("publication fixture failed");
  return { screen, media, playlist, publication };
};

const pairProofDevice = async (label: string, byte: number) => {
  const organization = await createOrganization(label);
  const credential = proofEnrollment(byte);
  const screen = await prisma.screen.create({
    data: {
      organizationId: organization.id,
      name: `Fixture ${label}`,
      location: "Fixture",
      orientation: "LANDSCAPE",
      resolution: "1920x1080",
      tags: [],
      installationId: credential.keyId,
      model: "Proof player",
      osVersion: "test",
      playerVersion: "0.1.0",
      credentialGeneration: 1,
      status: "OFFLINE",
    },
  });
  await prisma.deviceKeyTombstone.create({ data: { keyId: credential.keyId } });
  const storedCredential = await prisma.deviceCredential.create({
    data: {
      organizationId: organization.id,
      screenId: screen.id,
      liveScreenId: screen.id,
      liveScreenOrganizationId: organization.id,
      keyId: credential.keyId,
      publicKeySpki: Buffer.from(credential.publicKeySpki, "base64url"),
      algorithm: "ES256",
      securityLevel: credential.securityLevel,
    },
  });
  return { organization, screen, credential: storedCredential };
};

const stageReenrollmentCandidate = async (
  label: string,
  oldKeyByte: number,
  newKeyByte: number,
) => {
  const paired = await pairProofDevice(label, oldKeyByte);
  const actor = await createUser(`${label}-${randomUUID()}@example.test`);
  await prisma.membership.create({
    data: {
      organizationId: paired.organization.id,
      userId: actor.id,
      role: "OWNER",
    },
  });
  const heartbeatChallengeHash = proofHash();
  const heartbeatRequestDigest = proofHash();
  const heartbeatChallenge = await store.issueDeviceAuthChallenge({
    screenId: paired.screen.id,
    keyId: paired.credential.keyId,
    challengeHashSha256: heartbeatChallengeHash,
    operation: "heartbeat",
    requestDigestSha256: heartbeatRequestDigest,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  });
  if (!heartbeatChallenge) throw new Error("old heartbeat challenge failed");
  const oldHeartbeat = await store.heartbeatWithDeviceProof(
    {
      credentialId: paired.credential.id,
      challengeId: heartbeatChallenge.id,
      challengeHashSha256: heartbeatChallengeHash,
      operation: "heartbeat",
      requestDigestSha256: heartbeatRequestDigest,
    },
    {
      playerVersion: "old-player",
      manifestVersion: "old-manifest",
      nowPlayingAssetId: "old-asset",
      uptimeSeconds: 900,
      freeStorageBytes: 123_456,
      networkType: "old-network",
    },
    () => true,
  );
  if (!oldHeartbeat.authenticated) throw new Error("old heartbeat failed");
  const grant = await store.requestScreenReenrollmentAndAudit(
    paired.organization.id,
    paired.screen.id,
    `reenroll-${randomUUID()}`,
    new Date(Date.now() + 60_000).toISOString(),
    "Replace failed player hardware",
    { actorUserId: actor.id },
  );
  if (!grant.created) throw new Error("re-enrollment grant was not created");
  const credential = proofEnrollment(newKeyByte);
  const challengeHashSha256 = proofHash();
  const transcriptDigestSha256 = proofHash();
  const attempt = await store.issuePairingChallenge({
    codeHash: grant.pairing.codeHash,
    credential,
    challengeHashSha256,
    transcriptDigestSha256,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  });
  if (!attempt) throw new Error("re-enrollment challenge was not issued");
  const candidate = await store.claimPairingWithCredentialAndAudit(
    {
      codeHash: grant.pairing.codeHash,
      pairingAttemptId: attempt.id,
      challengeHashSha256,
      transcriptDigestSha256,
      keyId: credential.keyId,
      device: {
        installationId: credential.keyId,
        model: "Replacement player",
        osVersion: "15",
        playerVersion: "0.2.0",
      },
    },
    () => true,
    { requestId: `proof-reenroll-${label}` },
  );
  if (candidate.paired || candidate.reason !== "PENDING_APPROVAL")
    throw new Error("re-enrollment candidate was not staged");
  return { paired, actor, grant: grant.pairing, credential, candidate };
};

beforeAll(async () => {
  await store.ping();
});

beforeEach(async () => {
  // This job owns an isolated CI database. CASCADE keeps cleanup compatible
  // with new tenant-owned tables while retaining the migrated schema itself.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Organization", "User", "DeviceKeyTombstone", "LoginFailureEvent" RESTART IDENTITY CASCADE',
  );
});

afterAll(async () => {
  await store.close();
});

describe("PrismaStore PostgreSQL integration", () => {
  it("keeps the scoped-authorization foundation tenant-bound and latched to legacy", async () => {
    const organization = await createOrganization("scoped-foundation");
    const foreignOrganization = await createOrganization(
      "scoped-foundation-foreign",
    );
    const actor = await createUser(
      `scoped-foundation-${randomUUID()}@example.test`,
    );
    const membership = await prisma.membership.create({
      data: {
        organizationId: organization.id,
        userId: actor.id,
        role: "PUBLISHER",
      },
    });
    const foreignMembership = await prisma.membership.create({
      data: {
        organizationId: foreignOrganization.id,
        userId: actor.id,
        role: "PUBLISHER",
      },
    });
    const [screen, foreignScreen] = await Promise.all([
      prisma.screen.create({
        data: { organizationId: organization.id, name: "Scoped screen" },
      }),
      prisma.screen.create({
        data: {
          organizationId: foreignOrganization.id,
          name: "Foreign screen",
        },
      }),
    ]);
    const group = await prisma.screenGroup.create({
      data: { organizationId: organization.id, name: "Lobby group" },
    });
    await prisma.screenGroupMember.create({
      data: {
        organizationId: organization.id,
        groupId: group.id,
        screenId: screen.id,
      },
    });
    await expect(
      prisma.accessGrant.create({
        data: {
          organizationId: organization.id,
          subjectUserId: actor.id,
          createdByUserId: actor.id,
          capability: "release.publish",
          scopeType: "SCREEN_GROUP",
          screenGroupId: group.id,
        },
      }),
    ).rejects.toBeInstanceOf(Error);
    const grant = await prisma.accessGrant.create({
      data: {
        organizationId: organization.id,
        subjectUserId: actor.id,
        subjectMembershipId: membership.id,
        createdByUserId: actor.id,
        capability: "release.publish",
        scopeType: "SCREEN_GROUP",
        screenGroupId: group.id,
      },
    });
    const systemGrant = await prisma.accessGrant.create({
      data: {
        organizationId: organization.id,
        subjectUserId: actor.id,
        subjectMembershipId: membership.id,
        creatorKind: "SYSTEM",
        createdBySystemKey: "legacy-role-backfill-v1",
        capability: "release.withdraw",
        scopeType: "SCREEN",
        screenId: screen.id,
      },
    });
    await expect(
      prisma.accessGrant.create({
        data: {
          organizationId: organization.id,
          subjectUserId: actor.id,
          subjectMembershipId: membership.id,
          creatorKind: "SYSTEM",
          capability: "release.approve",
          scopeType: "ORGANIZATION",
        },
      }),
    ).rejects.toThrow(/AccessGrant_creator_shape/);
    await expect(
      prisma.accessGrant.create({
        data: {
          organizationId: organization.id,
          subjectUserId: actor.id,
          subjectMembershipId: membership.id,
          creatorKind: "USER",
          createdByUserId: actor.id,
          createdBySystemKey: "legacy-role-backfill-v1",
          capability: "release.approve",
          scopeType: "ORGANIZATION",
        },
      }),
    ).rejects.toThrow(/AccessGrant_creator_shape/);
    await expect(
      prisma.accessGrant.update({
        where: { id: systemGrant.id },
        data: { createdBySystemKey: "changed-system" },
      }),
    ).rejects.toBeInstanceOf(Error);

    expect(
      await prisma.organization.findUniqueOrThrow({
        where: { id: organization.id },
        select: { authorizationMode: true },
      }),
    ).toEqual({ authorizationMode: "LEGACY" });
    await expect(
      prisma.organization.update({
        where: { id: organization.id },
        data: { authorizationMode: "SHADOW" },
      }),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      prisma.screenGroupMember.create({
        data: {
          organizationId: organization.id,
          groupId: group.id,
          screenId: foreignScreen.id,
        },
      }),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      prisma.accessGrant.create({
        data: {
          organizationId: organization.id,
          subjectUserId: actor.id,
          subjectMembershipId: membership.id,
          createdByUserId: actor.id,
          capability: "emergency.activate",
          scopeType: "ORGANIZATION",
        },
      }),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      prisma.accessGrant.create({
        data: {
          organizationId: organization.id,
          subjectUserId: actor.id,
          subjectMembershipId: foreignMembership.id,
          createdByUserId: actor.id,
          capability: "release.withdraw",
          scopeType: "ORGANIZATION",
        },
      }),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      prisma.accessGrant.create({
        data: {
          organizationId: organization.id,
          subjectUserId: actor.id,
          subjectMembershipId: membership.id,
          createdByUserId: actor.id,
          capability: "release.publish",
          scopeType: "SCREEN",
        },
      }),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      prisma.accessGrant.create({
        data: {
          organizationId: organization.id,
          subjectUserId: actor.id,
          subjectMembershipId: membership.id,
          createdByUserId: actor.id,
          capability: grant.capability,
          scopeType: grant.scopeType,
          screenGroupId: group.id,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      prisma.accessGrant.update({
        where: { id: grant.id },
        data: { capability: "release.withdraw" },
      }),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      prisma.accessGrant.update({
        where: { id: grant.id },
        data: { scopeType: "ORGANIZATION", screenGroupId: null },
      }),
    ).rejects.toBeInstanceOf(Error);

    await prisma.membership.delete({
      where: {
        organizationId_userId: {
          organizationId: organization.id,
          userId: actor.id,
        },
      },
    });
    await expect(
      prisma.accessGrant.findUniqueOrThrow({ where: { id: grant.id } }),
    ).resolves.toMatchObject({
      subjectMembershipId: null,
      revokedAt: expect.any(Date),
    });
    const replacementMembership = await prisma.membership.create({
      data: {
        organizationId: organization.id,
        userId: actor.id,
        role: "PUBLISHER",
      },
    });
    await expect(
      prisma.accessGrant.update({
        where: { id: grant.id },
        data: { subjectMembershipId: replacementMembership.id },
      }),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      prisma.accessGrant.update({
        where: { id: grant.id },
        data: { revokedAt: null },
      }),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      prisma.accessGrant.create({
        data: {
          organizationId: organization.id,
          subjectUserId: actor.id,
          subjectMembershipId: replacementMembership.id,
          createdByUserId: actor.id,
          capability: grant.capability,
          scopeType: grant.scopeType,
          screenGroupId: group.id,
        },
      }),
    ).resolves.toMatchObject({
      subjectMembershipId: replacementMembership.id,
    });
    await expect(
      prisma.screenGroup.delete({ where: { id: group.id } }),
    ).rejects.toBeInstanceOf(Error);

    await prisma.organization.delete({ where: { id: organization.id } });
    await expect(
      Promise.all([
        prisma.screenGroup.count({
          where: { organizationId: organization.id },
        }),
        prisma.screenGroupMember.count({
          where: { organizationId: organization.id },
        }),
        prisma.accessGrant.count({
          where: { organizationId: organization.id },
        }),
      ]),
    ).resolves.toEqual([0, 0, 0]);
  });

  it("keeps candidate-create shadow denial and loader failure non-authoritative", async () => {
    const organization = await createOrganization("candidate-create-shadow");
    const actor = await createMember(
      organization.id,
      "PUBLISHER",
      "candidate-create-shadow",
    );
    const screen = await store.createScreen(organization.id, {
      name: "Shadow screen",
      location: "",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const media = await store.createMedia(organization.id, {
      name: "Shadow asset",
      kind: "image",
      mimeType: "image/png",
      url: "https://media.example.test/shadow.png",
      checksumSha256: "e".repeat(64),
      sizeBytes: 100,
    });
    const playlist = await store.createPlaylist(organization.id, {
      name: "Shadow playlist",
      description: "",
      items: [
        {
          id: "ignored",
          assetId: media.id,
          position: 0,
          durationSeconds: 10,
        },
      ],
    });
    const createCandidate = () =>
      store.createReleaseCandidateAndAudit(
        organization.id,
        {
          playlistId: playlist.id,
          name: "Shadow candidate",
          priority: "normal",
          startsAt: new Date(Date.now() + 60_000).toISOString(),
          timezone: "UTC",
          daysOfWeek: [],
          enabled: true,
          screenIds: [screen.id],
          expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        },
        { actorUserId: actor.id },
        { mediaAllowedOrigins: ["https://media.example.test"] },
        publicationIdempotency(),
      );

    const deniedShadow = await createCandidate();
    expect(deniedShadow.completed).toBe(true);
    if (!deniedShadow.completed) throw new Error(deniedShadow.reason);
    await expect(
      prisma.auditEvent.findFirstOrThrow({
        where: {
          organizationId: organization.id,
          action: "release.candidate.created",
          entityId: deniedShadow.candidate.id,
        },
        select: { metadata: true },
      }),
    ).resolves.toMatchObject({
      metadata: {
        authorizationShadow: {
          status: "EVALUATED",
          legacyAllowed: true,
          scopedAllowed: false,
          mismatchKind: "LEGACY_ALLOW_SCOPED_DENY",
          reason: "SCOPE_DENIED",
          targetCount: 1,
        },
      },
    });

    const membership = await prisma.membership.findUniqueOrThrow({
      where: {
        organizationId_userId: {
          organizationId: organization.id,
          userId: actor.id,
        },
      },
    });
    const coveringGrant = await prisma.accessGrant.create({
      data: {
        organizationId: organization.id,
        subjectUserId: actor.id,
        subjectMembershipId: membership.id,
        capability: "release.candidate.create",
        scopeType: "ORGANIZATION",
        createdByUserId: actor.id,
      },
    });
    const allowedShadow = await createCandidate();
    expect(allowedShadow.completed).toBe(true);
    if (!allowedShadow.completed) throw new Error(allowedShadow.reason);
    await expect(
      prisma.auditEvent.findFirstOrThrow({
        where: {
          organizationId: organization.id,
          action: "release.candidate.created",
          entityId: allowedShadow.candidate.id,
        },
        select: { metadata: true },
      }),
    ).resolves.toMatchObject({
      metadata: {
        authorizationShadow: {
          status: "EVALUATED",
          legacyAllowed: true,
          scopedAllowed: true,
          mismatchKind: "NONE",
          reason: "ALLOWED",
          targetCount: 1,
        },
      },
    });

    const blockerStore = new PrismaStore();
    const acquired = deferred();
    const release = deferred();
    const blocker = blockerStore.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT grant_row."id"
        FROM "AccessGrant" grant_row
        WHERE grant_row."id" = ${coveringGrant.id}
        FOR UPDATE OF grant_row`;
      acquired.resolve();
      await release.promise;
    });
    try {
      await acquired.promise;
      const startedAt = Date.now();
      const contendedShadow = await createCandidate();
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(contendedShadow.completed).toBe(true);
      if (!contendedShadow.completed) throw new Error(contendedShadow.reason);
      await expect(
        prisma.auditEvent.findFirstOrThrow({
          where: {
            organizationId: organization.id,
            action: "release.candidate.created",
            entityId: contendedShadow.candidate.id,
          },
          select: { metadata: true },
        }),
      ).resolves.toMatchObject({
        metadata: {
          authorizationShadow: {
            status: "UNAVAILABLE",
            legacyAllowed: true,
            failureClass: "LOAD_FAILED",
          },
        },
      });
    } finally {
      release.resolve();
      await blocker;
      await blockerStore.close();
    }

    await prisma.$executeRawUnsafe(
      'ALTER TABLE "AccessGrant" RENAME TO "AccessGrant_shadow_fault"',
    );
    try {
      const unavailableShadow = await createCandidate();
      expect(unavailableShadow.completed).toBe(true);
      if (!unavailableShadow.completed)
        throw new Error(unavailableShadow.reason);
      await expect(
        prisma.auditEvent.findFirstOrThrow({
          where: {
            organizationId: organization.id,
            action: "release.candidate.created",
            entityId: unavailableShadow.candidate.id,
          },
          select: { metadata: true },
        }),
      ).resolves.toMatchObject({
        metadata: {
          authorizationShadow: {
            status: "UNAVAILABLE",
            legacyAllowed: true,
            failureClass: "LOAD_FAILED",
            targetCount: 1,
          },
        },
      });
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "AccessGrant_shadow_fault" RENAME TO "AccessGrant"',
      );
    }
  });

  it("bounds audit rows and preserves deterministic equal-time reads", async () => {
    const organization = await createOrganization("audit-bounds");
    const createdAt = new Date("2026-09-12T12:00:00.000Z");
    await prisma.auditEvent.createMany({
      data: [
        {
          id: "audit-order-a",
          organizationId: organization.id,
          actorType: "system",
          action: "integration.first",
          entityType: "test",
          metadata: {},
          createdAt,
        },
        {
          id: "audit-order-b",
          organizationId: organization.id,
          actorType: "system",
          action: "integration.second",
          entityType: "test",
          metadata: { nested: { values: [1, true, null, "ok"] } },
          createdAt,
        },
      ],
    });
    expect(
      (await store.listAudits(organization.id, 10)).map(({ id }) => id),
    ).toEqual(["audit-order-b", "audit-order-a"]);

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "AuditEvent" ("id", "organizationId", "actorType", "action", "entityType", "metadata")
         VALUES ($1, $2, 'system', 'integration.valid-scalars', 'test', $3::jsonb)`,
        "audit-valid-scalar-metadata",
        organization.id,
        JSON.stringify({ number: 1, boolean: true, null: null, string: "ok" }),
      ),
    ).resolves.toBe(1);

    const invalidMetadata = [
      "[]",
      JSON.stringify({ value: "x".repeat(2_049) }),
      JSON.stringify({ values: Array(257).fill(0) }),
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`key-${index}`, index]),
        ),
      ),
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 20 }, (_, index) => [
            `key-${index}`,
            "x".repeat(2_000),
          ]),
        ),
      ),
    ];
    let nested: Record<string, unknown> = { value: true };
    for (let depth = 0; depth < 9; depth++) nested = { nested };
    invalidMetadata.push(JSON.stringify(nested));

    for (const [index, metadata] of invalidMetadata.entries()) {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "AuditEvent" ("id", "organizationId", "actorType", "action", "entityType", "metadata")
           VALUES ($1, $2, 'system', 'integration.invalid', 'test', $3::jsonb)`,
          `audit-invalid-metadata-${index}`,
          organization.id,
          metadata,
        ),
      ).rejects.toMatchObject({
        code: "P2010",
        meta: expect.objectContaining({ code: "23514" }),
      });
    }
    const invalidScalars = [
      { actorType: "x".repeat(33) },
      { action: "x".repeat(97) },
      { entityType: "x".repeat(65) },
      { entityId: "x".repeat(257) },
      { ipAddress: "x".repeat(65) },
      { requestId: "x".repeat(129) },
    ];
    for (const [index, invalid] of invalidScalars.entries()) {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "AuditEvent" ("id", "organizationId", "actorType", "action", "entityType", "entityId", "ipAddress", "requestId", "metadata")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb)`,
          `audit-invalid-scalar-${index}`,
          organization.id,
          invalid.actorType ?? "system",
          invalid.action ?? "integration.invalid",
          invalid.entityType ?? "test",
          invalid.entityId ?? null,
          invalid.ipAddress ?? null,
          invalid.requestId ?? null,
        ),
      ).rejects.toMatchObject({
        code: "P2010",
        meta: expect.objectContaining({ code: "23514" }),
      });
    }
  });

  it("enforces the logical metadata bound inside Prisma mutations", async () => {
    const organization = await createOrganization("audit-logical-size");
    const metadata = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `key-${index}`,
          "x".repeat(1_900),
        ]),
      );
    const device = (label: string) => ({
      installationId: `audit-size-${label}-${randomUUID()}`,
      model: "CI player",
      osVersion: "test",
      playerVersion: "0.1.0",
    });
    const below = await store.createPairing(
      organization.id,
      `audit-size-below-${randomUUID()}`,
      new Date(Date.now() + 60_000).toISOString(),
    );
    await expect(
      store.claimPairingAndAudit(
        below.codeHash,
        device("below"),
        "audit-size-below-token",
        { metadata: metadata(8) },
      ),
    ).resolves.toMatchObject({ organizationId: organization.id });

    const above = await store.createPairing(
      organization.id,
      `audit-size-above-${randomUUID()}`,
      new Date(Date.now() + 60_000).toISOString(),
    );
    const aboveDevice = device("above");
    await expect(
      store.claimPairingAndAudit(
        above.codeHash,
        aboveDevice,
        "audit-size-above-token",
        { metadata: metadata(9) },
      ),
    ).rejects.toThrow();
    await expect(
      prisma.pairingCode.findUniqueOrThrow({ where: { id: above.id } }),
    ).resolves.toMatchObject({ status: "PENDING", claimedAt: null });
    expect(
      await prisma.screen.count({
        where: { installationId: aboveDevice.installationId },
      }),
    ).toBe(0);
  });

  it("refuses compressible oversized legacy audit metadata during migration validation", async () => {
    const organization = await createOrganization("audit-size-preflight");
    const migration = await readFile(
      new URL(
        "../prisma/migrations/20260912160000_audit_event_local_integrity/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const addConstraint = migration.match(
      /ALTER TABLE "AuditEvent"\s+ADD CONSTRAINT "AuditEvent_metadata_logical_size"[\s\S]*?NOT VALID;/,
    )?.[0];
    const validateConstraint = migration.match(
      /ALTER TABLE "AuditEvent" VALIDATE CONSTRAINT "AuditEvent_metadata_logical_size";/,
    )?.[0];
    expect(addConstraint).toBeTruthy();
    expect(validateConstraint).toBeTruthy();

    await prisma.$executeRawUnsafe(
      'ALTER TABLE "AuditEvent" DROP CONSTRAINT "AuditEvent_metadata_logical_size"',
    );
    try {
      const metadata = Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [
          `key-${index}`,
          "x".repeat(2_000),
        ]),
      );
      await prisma.auditEvent.create({
        data: {
          organizationId: organization.id,
          actorType: "system",
          action: "integration.legacy-oversized",
          entityType: "test",
          metadata,
        },
      });
      await prisma.$executeRawUnsafe(addConstraint!);
      await expect(
        prisma.$executeRawUnsafe(validateConstraint!),
      ).rejects.toMatchObject({
        code: "P2010",
        meta: expect.objectContaining({ code: "23514" }),
      });
    } finally {
      await prisma.organization.delete({ where: { id: organization.id } });
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" DROP CONSTRAINT IF EXISTS "AuditEvent_metadata_logical_size"',
      );
      await prisma.$executeRawUnsafe(addConstraint!);
      await prisma.$executeRawUnsafe(validateConstraint!);
    }
  });

  it("rejects ordinary audit mutation while preserving User and Organization deletion semantics", async () => {
    const [authority] = await prisma.$queryRaw<
      Array<{ tableOwner: boolean; canTruncate: boolean }>
    >`
      SELECT
        table_class.relowner = current_user::regrole::oid AS "tableOwner",
        has_table_privilege(current_user, '"AuditEvent"', 'TRUNCATE') AS "canTruncate"
      FROM pg_class AS table_class
      WHERE table_class.oid = '"AuditEvent"'::regclass`;
    // Ordinary row triggers still fire for the owner. These facts deliberately
    // record why the trigger is not a hostile-database security boundary.
    expect(authority).toEqual({ tableOwner: true, canTruncate: true });

    const organization = await createOrganization("audit-mutation");
    const actor = await createUser(`audit-actor-${randomUUID()}@example.test`);
    const audit = await prisma.auditEvent.create({
      data: {
        organizationId: organization.id,
        actorUserId: actor.id,
        actorType: "user",
        action: "integration.recorded",
        entityType: "test",
        metadata: {},
      },
    });
    const rejected = {
      code: "P2010",
      meta: expect.objectContaining({ code: "55000" }),
    };

    await expect(
      prisma.$executeRaw`UPDATE "AuditEvent" SET "action" = 'integration.changed' WHERE "id" = ${audit.id}`,
    ).rejects.toMatchObject(rejected);
    await expect(
      prisma.$executeRaw`UPDATE "AuditEvent" SET "actorUserId" = NULL WHERE "id" = ${audit.id}`,
    ).rejects.toMatchObject(rejected);
    await expect(
      prisma.$executeRaw`DELETE FROM "AuditEvent" WHERE "id" = ${audit.id}`,
    ).rejects.toMatchObject(rejected);

    await prisma.user.delete({ where: { id: actor.id } });
    expect(
      await prisma.auditEvent.findUnique({ where: { id: audit.id } }),
    ).toMatchObject({ actorUserId: null, action: "integration.recorded" });

    await prisma.organization.delete({ where: { id: organization.id } });
    expect(
      await prisma.auditEvent.findUnique({ where: { id: audit.id } }),
    ).toBeNull();
  });

  it("keeps tenant-owned reads, lookups, updates, and deletes within the requested organization", async () => {
    const [alpha, beta] = await Promise.all([
      createOrganization("alpha"),
      createOrganization("beta"),
    ]);
    const alphaScreen = await store.createScreen(alpha.id, {
      name: "Alpha display",
      location: "Alpha lobby",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: ["alpha"],
    });
    const betaScreen = await store.createScreen(beta.id, {
      name: "Beta display",
      location: "Beta lobby",
      orientation: "portrait",
      resolution: "1080x1920",
      tags: ["beta"],
    });
    const alphaMedia = await store.createMedia(alpha.id, {
      name: "Alpha image",
      kind: "image",
      mimeType: "image/png",
      url: "https://media.example.test/alpha.png",
      checksumSha256: "a".repeat(64),
      sizeBytes: 1_024,
    });
    const betaMedia = await store.createMedia(beta.id, {
      name: "Beta image",
      kind: "image",
      mimeType: "image/png",
      url: "https://media.example.test/beta.png",
      checksumSha256: "b".repeat(64),
      sizeBytes: 2_048,
    });
    expect(alphaMedia.storageKey).toBe(
      mediaStorageKey(alpha.id, alphaMedia.id, alphaMedia.checksumSha256),
    );
    expect(betaMedia.storageKey).toBe(
      mediaStorageKey(beta.id, betaMedia.id, betaMedia.checksumSha256),
    );
    expect(alphaMedia.storageKey).not.toBe(betaMedia.storageKey);

    const alphaPlaylist = await store.createPlaylist(alpha.id, {
      name: "Alpha playlist",
      description: "Tenant-isolation fixture",
      items: [
        {
          id: "ignored-by-create",
          assetId: alphaMedia.id,
          position: 0,
          durationSeconds: 15,
        },
      ],
    });
    const betaPlaylist = await store.createPlaylist(beta.id, {
      name: "Beta playlist",
      description: "Tenant-isolation fixture",
      items: [
        {
          id: "ignored-by-create",
          assetId: betaMedia.id,
          position: 0,
          durationSeconds: 20,
        },
      ],
    });
    const startsAt = new Date(Date.now() - 60_000).toISOString();
    await store.createSchedule(alpha.id, {
      playlistId: alphaPlaylist.id,
      name: "Alpha schedule",
      priority: "normal",
      startsAt,
      timezone: "UTC",
      daysOfWeek: [],
      enabled: true,
      screenIds: [alphaScreen.id],
    });
    await store.createSchedule(beta.id, {
      playlistId: betaPlaylist.id,
      name: "Beta schedule",
      priority: "normal",
      startsAt,
      timezone: "UTC",
      daysOfWeek: [],
      enabled: true,
      screenIds: [betaScreen.id],
    });
    await store.audit({
      organizationId: alpha.id,
      actorType: "system",
      action: "integration.alpha",
      entityType: "test",
      metadata: {},
    });
    await store.audit({
      organizationId: beta.id,
      actorType: "system",
      action: "integration.beta",
      entityType: "test",
      metadata: {},
    });

    expect((await store.listScreens(alpha.id)).map((x) => x.id)).toEqual([
      alphaScreen.id,
    ]);
    expect((await store.listMedia(alpha.id)).map((x) => x.id)).toEqual([
      alphaMedia.id,
    ]);
    expect((await store.listPlaylists(alpha.id)).map((x) => x.id)).toEqual([
      alphaPlaylist.id,
    ]);
    expect((await store.listSchedules(alpha.id)).map((x) => x.name)).toEqual([
      "Alpha schedule",
    ]);
    expect((await store.listSchedules(alpha.id))[0]?.withdrawable).toBe(false);
    expect((await store.listAudits(alpha.id, 10)).map((x) => x.action)).toEqual(
      ["integration.alpha"],
    );
    await expect(store.getScreen(alpha.id, betaScreen.id)).resolves.toBeNull();
    await expect(store.getMedia(alpha.id, betaMedia.id)).resolves.toBeNull();
    await expect(
      store.getPlaylist(alpha.id, betaPlaylist.id),
    ).resolves.toBeNull();
    await expect(
      store.updateScreen(alpha.id, betaScreen.id, { name: "Cross tenant" }),
    ).resolves.toBeNull();
    await expect(store.deleteScreen(alpha.id, betaScreen.id)).resolves.toBe(
      false,
    );
    await expect(store.deleteMedia(alpha.id, betaMedia.id)).resolves.toBe(
      "NOT_FOUND",
    );
    await expect(store.deletePlaylist(alpha.id, betaPlaylist.id)).resolves.toBe(
      "NOT_FOUND",
    );
  });

  it("rolls back ordinary content mutations when their required audit insert fails", async () => {
    const organization = await createOrganization("ordinary-audit-rollback");
    const actor = await createMember(organization.id, "ADMIN", "rollback");
    const screen = await store.createScreen(organization.id, {
      name: "Original screen",
      location: "Lobby",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const media = await store.createMedia(organization.id, {
      name: "Existing media",
      kind: "image",
      mimeType: "image/png",
      url: "https://media.example.test/existing.png",
      checksumSha256: "8".repeat(64),
      sizeBytes: 100,
    });
    const playlist = await store.createPlaylist(organization.id, {
      name: "Existing playlist",
      description: "Rollback fixture",
      items: [],
    });
    const audit = {
      actorUserId: actor.id,
      ipAddress: "127.0.0.1",
      requestId: "ordinary-audit-rollback",
    };

    await prisma.$executeRawUnsafe(
      "ALTER TABLE \"AuditEvent\" ADD CONSTRAINT \"integration_reject_ordinary_audits\" CHECK (\"action\" NOT IN ('screen.created', 'screen.updated', 'media.created', 'media.deleted', 'playlist.created', 'playlist.deleted'))",
    );
    try {
      await expect(
        store.createScreenAndAudit(
          organization.id,
          {
            name: "Rolled-back screen",
            location: "Hall",
            orientation: "portrait",
            resolution: "1080x1920",
            tags: ["rollback"],
          },
          audit,
        ),
      ).rejects.toThrow();
      await expect(
        store.updateScreenAndAudit(
          organization.id,
          screen.id,
          { name: "Rolled-back update" },
          audit,
        ),
      ).rejects.toThrow();
      await expect(
        store.createMediaAndAudit(
          organization.id,
          {
            name: "Rolled-back media",
            kind: "image",
            mimeType: "image/png",
            url: "https://media.example.test/rolled-back.png",
            checksumSha256: "9".repeat(64),
            sizeBytes: 200,
          },
          audit,
        ),
      ).rejects.toThrow();
      await expect(
        store.deleteMediaAndAudit(organization.id, media.id, audit),
      ).rejects.toThrow();
      await expect(
        store.createPlaylistAndAudit(
          organization.id,
          {
            name: "Rolled-back playlist",
            description: "Must not persist",
            items: [],
          },
          audit,
        ),
      ).rejects.toThrow();
      await expect(
        store.deletePlaylistAndAudit(organization.id, playlist.id, audit),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" DROP CONSTRAINT "integration_reject_ordinary_audits"',
      );
    }

    await expect(
      prisma.screen.findUniqueOrThrow({ where: { id: screen.id } }),
    ).resolves.toMatchObject({ name: "Original screen" });
    expect(
      await prisma.screen.count({ where: { name: "Rolled-back screen" } }),
    ).toBe(0);
    await expect(
      prisma.mediaAsset.findUnique({ where: { id: media.id } }),
    ).resolves.not.toBeNull();
    expect(
      await prisma.mediaAsset.count({ where: { name: "Rolled-back media" } }),
    ).toBe(0);
    await expect(
      prisma.playlist.findUnique({ where: { id: playlist.id } }),
    ).resolves.not.toBeNull();
    expect(
      await prisma.playlist.count({ where: { name: "Rolled-back playlist" } }),
    ).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("denies every legacy role before emergency state or audit writes", async () => {
    const organization = await createOrganization("emergency-role-denial");
    const actors = await Promise.all(
      (["OWNER", "ADMIN", "PUBLISHER", "VIEWER"] as const).map((role) =>
        createMember(organization.id, role, `emergency-${role.toLowerCase()}`),
      ),
    );
    const screen = await store.createScreen(organization.id, {
      name: "Emergency contained screen",
      location: "Lobby",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const existing = await prisma.emergencyOverride.create({
      data: {
        organizationId: organization.id,
        title: "Existing emergency",
        message: "Must remain uncleared",
        targetScreenIds: [screen.id],
        expiresAt: new Date(Date.now() + 60_000),
        createdById: actors[0]!.id,
      },
    });

    for (const actor of actors) {
      await expect(
        store.activateEmergencyAndAudit(
          organization.id,
          {
            title: "Contained emergency",
            message: "Must not persist",
            backgroundColor: "#C1121F",
            targetScreenIds: [screen.id],
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          { actorUserId: actor.id },
        ),
      ).resolves.toEqual({ activated: false, reason: "FORBIDDEN" });
      await expect(
        store.clearEmergencyAndAudit(organization.id, existing.id, {
          actorUserId: actor.id,
        }),
      ).resolves.toEqual({ cleared: false, reason: "FORBIDDEN" });
    }

    expect(
      await prisma.emergencyOverride.count({
        where: {
          organizationId: organization.id,
          title: "Contained emergency",
        },
      }),
    ).toBe(0);
    await expect(
      prisma.emergencyOverride.findUniqueOrThrow({
        where: { id: existing.id },
      }),
    ).resolves.toMatchObject({ clearedAt: null });
    expect(
      await prisma.auditEvent.count({
        where: { organizationId: organization.id },
      }),
    ).toBe(0);
  });

  it("revalidates unavailable emergency actors before target or audit writes", async () => {
    const [organization, otherOrganization] = await Promise.all([
      createOrganization("emergency-revalidation"),
      createOrganization("emergency-revalidation-other"),
    ]);
    const [disabledAdmin, foreignAdmin] = await Promise.all([
      createMember(organization.id, "ADMIN", "emergency-disabled-admin", true),
      createMember(otherOrganization.id, "ADMIN", "emergency-foreign-admin"),
    ]);
    const [local, foreign] = await Promise.all([
      store.createScreen(organization.id, {
        name: "Local emergency screen",
        location: "Lobby",
        orientation: "landscape",
        resolution: "1920x1080",
        tags: [],
      }),
      store.createScreen(otherOrganization.id, {
        name: "Foreign emergency screen",
        location: "Lobby",
        orientation: "landscape",
        resolution: "1920x1080",
        tags: [],
      }),
    ]);
    const input = {
      title: "Denied emergency",
      message: "Must fail closed",
      backgroundColor: "#C1121F",
      targetScreenIds: [local.id],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };

    for (const actorUserId of [disabledAdmin.id, foreignAdmin.id, randomUUID()])
      await expect(
        store.activateEmergencyAndAudit(
          organization.id,
          { ...input, targetScreenIds: [local.id, foreign.id] },
          { actorUserId },
        ),
      ).resolves.toEqual({ activated: false, reason: "FORBIDDEN" });
    expect(
      await prisma.emergencyOverride.count({
        where: { organizationId: organization.id },
      }),
    ).toBe(0);
    expect(
      await prisma.auditEvent.count({
        where: { organizationId: organization.id },
      }),
    ).toBe(0);
  });

  it("revalidates ordinary mutation actors and playlist assets inside the transaction", async () => {
    const [organization, otherOrganization] = await Promise.all([
      createOrganization("ordinary-revalidation"),
      createOrganization("ordinary-revalidation-other"),
    ]);
    const [viewer, publisher, disabledAdmin, otherAdmin] = await Promise.all([
      createMember(organization.id, "VIEWER", "viewer"),
      createMember(organization.id, "PUBLISHER", "publisher"),
      createMember(organization.id, "ADMIN", "disabled-admin", true),
      createMember(otherOrganization.id, "ADMIN", "other-admin"),
    ]);
    const screenInput = {
      name: "Denied screen",
      location: "Lobby",
      orientation: "landscape" as const,
      resolution: "1920x1080",
      tags: [],
    };
    const mediaInput = {
      name: "Denied media",
      kind: "image" as const,
      mimeType: "image/png",
      url: "https://media.example.test/denied.png",
      checksumSha256: "a".repeat(64),
      sizeBytes: 100,
    };

    await expect(
      store.createScreenAndAudit(organization.id, screenInput, {
        actorUserId: publisher.id,
      }),
    ).resolves.toEqual({ created: false, reason: "FORBIDDEN" });
    await expect(
      store.createMediaAndAudit(organization.id, mediaInput, {
        actorUserId: viewer.id,
      }),
    ).resolves.toEqual({ created: false, reason: "FORBIDDEN" });
    await expect(
      store.createPlaylistAndAudit(
        organization.id,
        { name: "Denied playlist", description: "", items: [] },
        { actorUserId: disabledAdmin.id },
      ),
    ).resolves.toEqual({ created: false, reason: "FORBIDDEN" });
    await expect(
      store.createMediaAndAudit(organization.id, mediaInput, {
        actorUserId: otherAdmin.id,
      }),
    ).resolves.toEqual({ created: false, reason: "FORBIDDEN" });
    await expect(
      store.createPlaylistAndAudit(
        organization.id,
        {
          name: "Invalid asset playlist",
          description: "",
          items: [
            {
              id: "ignored",
              assetId: randomUUID(),
              position: 0,
              durationSeconds: 10,
            },
          ],
        },
        { actorUserId: publisher.id },
      ),
    ).resolves.toEqual({ created: false, reason: "INVALID_ASSET" });

    expect(await prisma.screen.count()).toBe(0);
    expect(await prisma.mediaAsset.count()).toBe(0);
    expect(await prisma.playlist.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("enforces location tenant integrity and rolls back location audit failures", async () => {
    const [organization, otherOrganization] = await Promise.all([
      createOrganization("location-foundation"),
      createOrganization("location-foundation-other"),
    ]);
    const actor = await createMember(
      organization.id,
      "ADMIN",
      "location-admin",
    );
    const location = await prisma.location.create({
      data: { organizationId: organization.id, name: "Main campus" },
    });
    const foreignLocation = await prisma.location.create({
      data: { organizationId: otherOrganization.id, name: "Foreign campus" },
    });

    await expect(
      store.createScreenAndAudit(
        organization.id,
        {
          name: "Cross-tenant classification",
          location: "Legacy label",
          locationId: foreignLocation.id,
          orientation: "landscape",
          resolution: "1920x1080",
          tags: [],
        },
        { actorUserId: actor.id },
      ),
    ).resolves.toEqual({ created: false, reason: "INVALID_LOCATION" });
    await expect(
      store.createScreen(organization.id, {
        name: "Internal cross-tenant classification",
        location: "Legacy label",
        locationId: foreignLocation.id,
        orientation: "landscape",
        resolution: "1920x1080",
        tags: [],
      }),
    ).rejects.toMatchObject({ code: "INVALID_LOCATION" });
    const internalScreen = await store.createScreen(organization.id, {
      name: "Internal update fixture",
      location: "Legacy label",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    await expect(
      store.updateScreen(organization.id, internalScreen.id, {
        locationId: foreignLocation.id,
      }),
    ).resolves.toBeNull();
    await prisma.screen.delete({ where: { id: internalScreen.id } });
    await expect(
      prisma.screen.create({
        data: {
          organizationId: organization.id,
          name: "Direct cross-tenant classification",
          location: "Legacy label",
          locationId: foreignLocation.id,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });

    await prisma.$executeRawUnsafe(
      `ALTER TABLE "AuditEvent" ADD CONSTRAINT "integration_reject_location_audits" CHECK ("action" NOT IN ('location.created', 'location.updated', 'location.deleted'))`,
    );
    try {
      await expect(
        store.createLocationAndAudit(organization.id, "Rolled back", {
          actorUserId: actor.id,
        }),
      ).rejects.toThrow();
      await expect(
        store.updateLocationAndAudit(organization.id, location.id, "Changed", {
          actorUserId: actor.id,
        }),
      ).rejects.toThrow();
      const deletable = await prisma.location.create({
        data: { organizationId: organization.id, name: "Delete rollback" },
      });
      await expect(
        store.deleteLocationAndAudit(organization.id, deletable.id, {
          actorUserId: actor.id,
        }),
      ).rejects.toThrow();
      await expect(
        prisma.location.findUniqueOrThrow({ where: { id: deletable.id } }),
      ).resolves.toBeDefined();
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" DROP CONSTRAINT "integration_reject_location_audits"',
      );
    }
    await expect(
      prisma.location.findUniqueOrThrow({ where: { id: location.id } }),
    ).resolves.toMatchObject({ name: "Main campus" });
    expect(
      await prisma.location.count({
        where: { organizationId: organization.id, name: "Rolled back" },
      }),
    ).toBe(0);
    expect(
      await prisma.screen.count({ where: { organizationId: organization.id } }),
    ).toBe(0);
  });

  it("serializes screen classification against concurrent location deletion", async () => {
    const organization = await createOrganization("location-lock-order");
    const [screenActor, locationActor] = await Promise.all([
      createMember(organization.id, "ADMIN", "location-screen-actor"),
      createMember(organization.id, "ADMIN", "location-delete-actor"),
    ]);
    const createTarget = await prisma.location.create({
      data: { organizationId: organization.id, name: "Create race" },
    });
    const screenInput = {
      name: "Concurrent classification",
      location: "Legacy label",
      locationId: createTarget.id,
      orientation: "landscape" as const,
      resolution: "1920x1080",
      tags: [],
    };

    const [createResult, createDeleteResult] = await Promise.all([
      store.createScreenAndAudit(organization.id, screenInput, {
        actorUserId: screenActor.id,
      }),
      store.deleteLocationAndAudit(organization.id, createTarget.id, {
        actorUserId: locationActor.id,
      }),
    ]);
    if (createResult.created) {
      expect(createDeleteResult).toEqual({
        deleted: false,
        reason: "IN_USE",
      });
      await expect(
        prisma.location.findUniqueOrThrow({ where: { id: createTarget.id } }),
      ).resolves.toBeDefined();
    } else {
      expect(createResult).toEqual({
        created: false,
        reason: "INVALID_LOCATION",
      });
      expect(createDeleteResult).toEqual({ deleted: true });
      expect(
        await prisma.screen.count({
          where: { organizationId: organization.id, name: screenInput.name },
        }),
      ).toBe(0);
    }

    const screen = await prisma.screen.create({
      data: {
        organizationId: organization.id,
        name: "Update classification",
        location: "Unclassified legacy label",
      },
    });
    const updateTarget = await prisma.location.create({
      data: { organizationId: organization.id, name: "Update race" },
    });
    const [updateResult, updateDeleteResult] = await Promise.all([
      store.updateScreenAndAudit(
        organization.id,
        screen.id,
        { locationId: updateTarget.id },
        { actorUserId: screenActor.id },
      ),
      store.deleteLocationAndAudit(organization.id, updateTarget.id, {
        actorUserId: locationActor.id,
      }),
    ]);
    if (updateResult.updated) {
      expect(updateDeleteResult).toEqual({
        deleted: false,
        reason: "IN_USE",
      });
      await expect(
        prisma.screen.findUniqueOrThrow({ where: { id: screen.id } }),
      ).resolves.toMatchObject({ locationId: updateTarget.id });
    } else {
      expect(updateResult).toEqual({
        updated: false,
        reason: "INVALID_LOCATION",
      });
      expect(updateDeleteResult).toEqual({ deleted: true });
      await expect(
        prisma.screen.findUniqueOrThrow({ where: { id: screen.id } }),
      ).resolves.toMatchObject({ locationId: null });
    }

    const orphanRows = await prisma.$queryRaw<Array<{ orphanCount: bigint }>>`
      SELECT COUNT(*) AS "orphanCount"
      FROM "Screen" screen
      LEFT JOIN "Location" location
        ON location."id" = screen."locationId"
       AND location."organizationId" = screen."organizationId"
      WHERE screen."organizationId" = ${organization.id}
        AND screen."locationId" IS NOT NULL
        AND location."id" IS NULL`;
    expect(orphanRows[0]!.orphanCount).toBe(0n);
  });

  it("writes the established ordinary mutation audit actions and metadata", async () => {
    const organization = await createOrganization("ordinary-audit-shape");
    const actor = await createMember(organization.id, "ADMIN", "audit-shape");
    const audit = (requestId: string) => ({
      actorUserId: actor.id,
      ipAddress: "127.0.0.1",
      requestId,
    });

    const createdScreen = await store.createScreenAndAudit(
      organization.id,
      {
        name: "Audited screen",
        location: "Lobby",
        orientation: "landscape",
        resolution: "1920x1080",
        tags: [],
      },
      audit("screen-create"),
    );
    if (!createdScreen.created) throw new Error("screen was not created");
    await expect(
      store.updateScreenAndAudit(
        organization.id,
        createdScreen.value.id,
        { location: "Library" },
        audit("screen-update"),
      ),
    ).resolves.toMatchObject({ updated: true });

    const createdMedia = await store.createMediaAndAudit(
      organization.id,
      {
        name: "Audited media",
        kind: "image",
        mimeType: "image/png",
        url: "https://media.example.test/audited.png",
        checksumSha256: "b".repeat(64),
        sizeBytes: 100,
      },
      audit("media-create"),
    );
    if (!createdMedia.created) throw new Error("media was not created");
    const createdPlaylist = await store.createPlaylistAndAudit(
      organization.id,
      {
        name: "Audited playlist",
        description: "Audit fixture",
        items: [
          {
            id: "ignored-one",
            assetId: createdMedia.value.id,
            position: 0,
            durationSeconds: 10,
          },
          {
            id: "ignored-two",
            assetId: createdMedia.value.id,
            position: 1,
            durationSeconds: 20,
          },
        ],
      },
      audit("playlist-create"),
    );
    if (!createdPlaylist.created) throw new Error("playlist was not created");

    await expect(
      store.deleteMediaAndAudit(
        organization.id,
        createdMedia.value.id,
        audit("media-delete-in-use"),
      ),
    ).resolves.toEqual({ deleted: false, reason: "IN_USE" });
    await expect(
      store.deletePlaylistAndAudit(
        organization.id,
        createdPlaylist.value.id,
        audit("playlist-delete"),
      ),
    ).resolves.toEqual({ deleted: true });
    await expect(
      store.deleteMediaAndAudit(
        organization.id,
        createdMedia.value.id,
        audit("media-delete"),
      ),
    ).resolves.toEqual({ deleted: true });

    await expect(
      prisma.auditEvent.findMany({
        where: { organizationId: organization.id },
        orderBy: { requestId: "asc" },
        select: {
          actorUserId: true,
          actorType: true,
          action: true,
          entityType: true,
          entityId: true,
          ipAddress: true,
          requestId: true,
          metadata: true,
        },
      }),
    ).resolves.toEqual([
      {
        actorUserId: actor.id,
        actorType: "user",
        action: "media.created",
        entityType: "media",
        entityId: createdMedia.value.id,
        ipAddress: "127.0.0.1",
        requestId: "media-create",
        metadata: { name: "Audited media" },
      },
      {
        actorUserId: actor.id,
        actorType: "user",
        action: "media.deleted",
        entityType: "media",
        entityId: createdMedia.value.id,
        ipAddress: "127.0.0.1",
        requestId: "media-delete",
        metadata: {},
      },
      {
        actorUserId: actor.id,
        actorType: "user",
        action: "playlist.created",
        entityType: "playlist",
        entityId: createdPlaylist.value.id,
        ipAddress: "127.0.0.1",
        requestId: "playlist-create",
        metadata: { itemCount: 2 },
      },
      {
        actorUserId: actor.id,
        actorType: "user",
        action: "playlist.deleted",
        entityType: "playlist",
        entityId: createdPlaylist.value.id,
        ipAddress: "127.0.0.1",
        requestId: "playlist-delete",
        metadata: {},
      },
      {
        actorUserId: actor.id,
        actorType: "user",
        action: "screen.created",
        entityType: "screen",
        entityId: createdScreen.value.id,
        ipAddress: "127.0.0.1",
        requestId: "screen-create",
        metadata: { name: "Audited screen" },
      },
      {
        actorUserId: actor.id,
        actorType: "user",
        action: "screen.updated",
        entityType: "screen",
        entityId: createdScreen.value.id,
        ipAddress: "127.0.0.1",
        requestId: "screen-update",
        metadata: {},
      },
    ]);
  });

  it("enforces composite tenant ownership for nested relations and preserves safe delete semantics", async () => {
    const [alpha, beta] = await Promise.all([
      createOrganization("constraints-alpha"),
      createOrganization("constraints-beta"),
    ]);
    const alphaMediaId = randomUUID();
    const betaMediaId = randomUUID();
    const [alphaMedia, betaMedia] = await Promise.all([
      prisma.mediaAsset.create({
        data: {
          id: alphaMediaId,
          organizationId: alpha.id,
          storageKey: mediaStorageKey(alpha.id, alphaMediaId, "d".repeat(64)),
          name: "Alpha asset",
          kind: "IMAGE",
          mimeType: "image/png",
          url: "https://media.example.test/constraint-alpha.png",
          checksumSha256: "d".repeat(64),
          sizeBytes: 100n,
        },
      }),
      prisma.mediaAsset.create({
        data: {
          id: betaMediaId,
          organizationId: beta.id,
          storageKey: mediaStorageKey(beta.id, betaMediaId, "e".repeat(64)),
          name: "Beta asset",
          kind: "IMAGE",
          mimeType: "image/png",
          url: "https://media.example.test/constraint-beta.png",
          checksumSha256: "e".repeat(64),
          sizeBytes: 200n,
        },
      }),
    ]);
    const [alphaPlaylist, betaPlaylist] = await Promise.all([
      prisma.playlist.create({
        data: { organizationId: alpha.id, name: "Constraint alpha" },
      }),
      prisma.playlist.create({
        data: { organizationId: beta.id, name: "Constraint beta" },
      }),
    ]);
    const [alphaScreen, betaScreen] = await Promise.all([
      prisma.screen.create({
        data: { organizationId: alpha.id, name: "Constraint alpha screen" },
      }),
      prisma.screen.create({
        data: { organizationId: beta.id, name: "Constraint beta screen" },
      }),
    ]);

    const alphaItem = await prisma.playlistItem.create({
      data: {
        organizationId: alpha.id,
        playlistId: alphaPlaylist.id,
        assetId: alphaMedia.id,
        position: 0,
        durationSeconds: 10,
      },
    });
    const alphaSchedule = await prisma.schedule.create({
      data: {
        organizationId: alpha.id,
        playlistId: alphaPlaylist.id,
        name: "Constraint schedule",
        startsAt: new Date(),
      },
    });
    await prisma.scheduleTarget.create({
      data: {
        organizationId: alpha.id,
        scheduleId: alphaSchedule.id,
        screenId: alphaScreen.id,
      },
    });
    const pairing = await prisma.pairingCode.create({
      data: {
        organizationId: alpha.id,
        codeHash: `constraint-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
        screenId: alphaScreen.id,
        screenOrganizationId: alpha.id,
      },
    });

    await expect(
      prisma.playlistItem.create({
        data: {
          organizationId: alpha.id,
          playlistId: alphaPlaylist.id,
          assetId: betaMedia.id,
          position: 1,
          durationSeconds: 10,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      prisma.schedule.create({
        data: {
          organizationId: alpha.id,
          playlistId: betaPlaylist.id,
          name: "Cross-tenant playlist",
          startsAt: new Date(),
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      prisma.scheduleTarget.create({
        data: {
          organizationId: alpha.id,
          scheduleId: alphaSchedule.id,
          screenId: betaScreen.id,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      prisma.pairingCode.update({
        where: { id: pairing.id },
        data: {
          screenId: betaScreen.id,
          screenOrganizationId: alpha.id,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    const checkConstraintError = await prisma.pairingCode
      .update({
        where: { id: pairing.id },
        data: {
          screenId: betaScreen.id,
          screenOrganizationId: beta.id,
        },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(checkConstraintError).toBeInstanceOf(Error);
    expect(checkConstraintError).toHaveProperty(
      "name",
      "PrismaClientUnknownRequestError",
    );
    expect((checkConstraintError as Error).message).toContain('code: "23514"');
    expect((checkConstraintError as Error).message).toContain(
      "PairingCode_screen_organization_check",
    );

    await prisma.screen.delete({ where: { id: alphaScreen.id } });
    await expect(
      prisma.pairingCode.findUniqueOrThrow({ where: { id: pairing.id } }),
    ).resolves.toMatchObject({
      screenId: null,
      screenOrganizationId: null,
    });
    expect(
      await prisma.scheduleTarget.count({
        where: { scheduleId: alphaSchedule.id },
      }),
    ).toBe(0);

    await prisma.playlist.delete({ where: { id: alphaPlaylist.id } });
    expect(
      await prisma.playlistItem.count({ where: { id: alphaItem.id } }),
    ).toBe(0);
    expect(
      await prisma.schedule.count({ where: { id: alphaSchedule.id } }),
    ).toBe(0);
    await expect(
      prisma.mediaAsset.delete({ where: { id: alphaMedia.id } }),
    ).resolves.toMatchObject({ id: alphaMedia.id });
  });

  it("rolls back pairing creation when its required audit cannot be written", async () => {
    const organization = await createOrganization("pairing-create-rollback");
    const actor = await createMember(
      organization.id,
      "OWNER",
      "pairing-create-rollback-owner",
    );
    const codeHash = `failed-audit-${randomUUID()}`;

    await prisma.$executeRawUnsafe(
      `ALTER TABLE "AuditEvent" ADD CONSTRAINT "integration_reject_pairing_create_audit" CHECK ("action" <> 'pairing.created')`,
    );
    try {
      await expect(
        store.tryCreatePairingAndAudit(
          organization.id,
          codeHash,
          new Date(Date.now() + 60_000).toISOString(),
          { actorUserId: actor.id },
        ),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" DROP CONSTRAINT "integration_reject_pairing_create_audit"',
      );
    }
    expect(await prisma.pairingCode.count({ where: { codeHash } })).toBe(0);
    expect(
      await prisma.auditEvent.count({
        where: { organizationId: organization.id, action: "pairing.created" },
      }),
    ).toBe(0);
  });

  it("revalidates current pairing-code authority inside the transaction", async () => {
    const [organization, otherOrganization] = await Promise.all([
      createOrganization("pairing-create-authorization"),
      createOrganization("pairing-create-authorization-other"),
    ]);
    const [viewer, disabledAdmin, otherAdmin] = await Promise.all([
      createMember(organization.id, "VIEWER", "pairing-create-viewer"),
      createMember(
        organization.id,
        "ADMIN",
        "pairing-create-disabled-admin",
        true,
      ),
      createMember(otherOrganization.id, "ADMIN", "pairing-create-other-admin"),
    ]);

    for (const actorUserId of [viewer.id, disabledAdmin.id, otherAdmin.id]) {
      const codeHash = `forbidden-pairing-${randomUUID()}`;
      await expect(
        store.tryCreatePairingAndAudit(
          organization.id,
          codeHash,
          new Date(Date.now() + 60_000).toISOString(),
          { actorUserId },
        ),
      ).resolves.toEqual({ created: false, reason: "FORBIDDEN" });
      expect(await prisma.pairingCode.count({ where: { codeHash } })).toBe(0);
    }
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("claims a pairing code and records its audit exactly once under concurrent requests", async () => {
    const organization = await createOrganization("pairing-race");
    const pairing = await store.createPairing(
      organization.id,
      `code-${randomUUID()}`,
      new Date(Date.now() + 60_000).toISOString(),
    );
    const device = {
      installationId: `installation-${randomUUID()}`,
      model: "CI player",
      osVersion: "test",
      playerVersion: "0.1.0",
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.claimPairingAndAudit(pairing.codeHash, device, `token-${index}`, {
          ipAddress: "127.0.0.1",
          requestId: `pairing-race-${index}`,
        }),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      await prisma.screen.count({ where: { organizationId: organization.id } }),
    ).toBe(1);
    await expect(
      prisma.pairingCode.findUniqueOrThrow({ where: { id: pairing.id } }),
    ).resolves.toMatchObject({ status: "CLAIMED" });
    await expect(
      prisma.auditEvent.findMany({
        where: {
          organizationId: organization.id,
          action: "device.paired",
        },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        actorType: "device",
        entityType: "screen",
        entityId: results.find(Boolean)?.id,
        ipAddress: "127.0.0.1",
        metadata: { installationId: device.installationId },
      }),
    ]);
  });

  it("rolls back the pairing claim and screen when its required audit cannot be written", async () => {
    const organization = await createOrganization("pairing-audit-rollback");
    const installationId = `installation-${randomUUID()}`;
    const pairing = await store.createPairing(
      organization.id,
      `code-${randomUUID()}`,
      new Date(Date.now() + 60_000).toISOString(),
    );

    // Install a test-only database constraint so the final audit insert fails
    // after the claim and screen statements have executed. The suite is
    // single-worker and owns this isolated database.
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "AuditEvent" ADD CONSTRAINT "integration_reject_device_paired" CHECK ("action" <> \'device.paired\')',
    );
    try {
      await expect(
        store.claimPairingAndAudit(
          pairing.codeHash,
          {
            installationId,
            model: "Rollback player",
            osVersion: "test",
            playerVersion: "0.1.0",
          },
          "rollback-token",
          { requestId: "pairing-audit-rollback" },
        ),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" DROP CONSTRAINT "integration_reject_device_paired"',
      );
    }
    await expect(
      prisma.pairingCode.findUniqueOrThrow({ where: { id: pairing.id } }),
    ).resolves.toMatchObject({ status: "PENDING", claimedAt: null });
    expect(await prisma.screen.count({ where: { installationId } })).toBe(0);
    expect(
      await prisma.auditEvent.count({
        where: {
          organizationId: organization.id,
          action: "device.paired",
        },
      }),
    ).toBe(0);
  });

  it("never lets an unbound proof mint initial device authority", async () => {
    const organization = await createOrganization("proof-pair-race");
    const pairing = await store.createPairing(
      organization.id,
      `proof-code-${randomUUID()}`,
      new Date(Date.now() + 60_000).toISOString(),
    );
    const enrollment = proofEnrollment(11);
    const challengeHashSha256 = proofHash();
    const transcriptDigestSha256 = proofHash();
    const attempt = await store.issuePairingChallenge({
      codeHash: pairing.codeHash,
      credential: enrollment,
      challengeHashSha256,
      transcriptDigestSha256,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    if (!attempt) throw new Error("pairing challenge was not issued");
    const input = {
      codeHash: pairing.codeHash,
      pairingAttemptId: attempt.id,
      challengeHashSha256,
      transcriptDigestSha256,
      keyId: enrollment.keyId,
      device: {
        installationId: `proof-installation-${randomUUID()}`,
        model: "Proof race player",
        osVersion: "test",
        playerVersion: "0.1.0",
      },
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.claimPairingWithCredentialAndAudit(input, () => true, {
          requestId: `proof-pair-race-${index}`,
        }),
      ),
    );
    expect(results).toEqual(
      Array.from({ length: 8 }, () => ({ paired: false, reason: "INVALID" })),
    );
    expect(await prisma.screen.count()).toBe(0);
    expect(await prisma.deviceCredential.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
    await expect(
      store.claimPairingWithCredentialAndAudit(
        { ...input, transcriptDigestSha256: proofHash() },
        () => true,
        {},
      ),
    ).resolves.toEqual({ paired: false, reason: "INVALID" });
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("rolls back proof enrollment when its required audit fails", async () => {
    const organization = await createOrganization("proof-pair-rollback");
    const pairing = await store.createPairing(
      organization.id,
      `proof-code-${randomUUID()}`,
      new Date(Date.now() + 60_000).toISOString(),
    );
    const enrollment = proofEnrollment(12);
    const challengeHashSha256 = proofHash();
    const transcriptDigestSha256 = proofHash();
    const attempt = await store.issuePairingChallenge({
      codeHash: pairing.codeHash,
      credential: enrollment,
      challengeHashSha256,
      transcriptDigestSha256,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    if (!attempt) throw new Error("pairing challenge was not issued");
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "AuditEvent" ADD CONSTRAINT "integration_reject_proof_paired" CHECK ("action" <> \'device.paired\')',
    );
    try {
      await expect(
        store.claimPairingWithCredentialAndAudit(
          {
            codeHash: pairing.codeHash,
            pairingAttemptId: attempt.id,
            challengeHashSha256,
            transcriptDigestSha256,
            keyId: enrollment.keyId,
            device: {
              installationId: `proof-rollback-${randomUUID()}`,
              model: "Proof rollback player",
              osVersion: "test",
              playerVersion: "0.1.0",
            },
          },
          () => true,
          {},
        ),
      ).resolves.toEqual({ paired: false, reason: "INVALID" });
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" DROP CONSTRAINT "integration_reject_proof_paired"',
      );
    }
    await expect(
      prisma.pairingCode.findUniqueOrThrow({ where: { id: pairing.id } }),
    ).resolves.toMatchObject({ status: "PENDING", screenId: null });
    await expect(
      prisma.pairingAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
    ).resolves.toMatchObject({ consumedAt: null, boundCredentialId: null });
    expect(await prisma.screen.count()).toBe(0);
    expect(await prisma.deviceCredential.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("consumes a bound proof once with heartbeat and serializes credential revocation", async () => {
    const paired = await pairProofDevice("proof-consume", 13);
    const requestDigestSha256 = proofHash();
    const challengeHashSha256 = proofHash();
    const challenge = await store.issueDeviceAuthChallenge({
      screenId: paired.screen.id,
      keyId: paired.credential.keyId,
      challengeHashSha256,
      operation: "heartbeat",
      requestDigestSha256,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    if (!challenge) throw new Error("device challenge was not issued");
    const proof = {
      credentialId: paired.credential.id,
      challengeId: challenge.id,
      challengeHashSha256,
      operation: "heartbeat" as const,
      requestDigestSha256,
    };
    await expect(
      store.consumeDeviceAuthChallenge(
        { ...proof, requestDigestSha256: proofHash() },
        () => true,
      ),
    ).resolves.toEqual({ authenticated: false, reason: "INVALID_PROOF" });
    await expect(
      store.consumeDeviceAuthChallenge(proof, () => false),
    ).resolves.toEqual({ authenticated: false, reason: "INVALID_PROOF" });
    await expect(
      prisma.deviceAuthChallenge.findUniqueOrThrow({
        where: { id: challenge.id },
      }),
    ).resolves.toMatchObject({ consumedAt: null });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.heartbeatWithDeviceProof(
          proof,
          {
            playerVersion: `proof-${index}`,
            manifestVersion: null,
            nowPlayingAssetId: null,
            uptimeSeconds: index,
            freeStorageBytes: 1_000_000,
            networkType: "integration",
          },
          () => true,
        ),
      ),
    );
    expect(results.filter((result) => result.authenticated)).toHaveLength(1);
    expect(
      await prisma.deviceAuthChallenge.count({
        where: { id: challenge.id, consumedAt: { not: null } },
      }),
    ).toBe(1);

    const revokeChallengeHash = proofHash();
    const revokeDigest = proofHash();
    const revokeChallenge = await store.issueDeviceAuthChallenge({
      screenId: paired.screen.id,
      keyId: paired.credential.keyId,
      challengeHashSha256: revokeChallengeHash,
      operation: "heartbeat",
      requestDigestSha256: revokeDigest,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    if (!revokeChallenge) throw new Error("revoke-race challenge missing");
    const actor = await createUser("proof-revoke-owner@example.test");
    await prisma.membership.create({
      data: {
        organizationId: paired.organization.id,
        userId: actor.id,
        role: "OWNER",
      },
    });
    const [heartbeatResult, revokeResult] = await Promise.all([
      store.heartbeatWithDeviceProof(
        {
          credentialId: paired.credential.id,
          challengeId: revokeChallenge.id,
          challengeHashSha256: revokeChallengeHash,
          operation: "heartbeat",
          requestDigestSha256: revokeDigest,
        },
        {
          playerVersion: "revoke-race",
          manifestVersion: null,
          nowPlayingAssetId: null,
          uptimeSeconds: 1,
          freeStorageBytes: 1_000_000,
          networkType: "integration",
        },
        () => true,
      ),
      store.revokeDeviceCredentialAndAudit(
        paired.organization.id,
        paired.screen.id,
        { actorUserId: actor.id },
      ),
    ]);
    expect(revokeResult).toMatchObject({ revoked: true });
    expect([true, false]).toContain(heartbeatResult.authenticated);
    await expect(
      store.authenticateDeviceCredential(
        paired.screen.id,
        paired.credential.keyId,
      ),
    ).resolves.toEqual({ authenticated: false, reason: "INVALID_PROOF" });
    await expect(
      store.revokeDeviceCredentialAndAudit(
        paired.organization.id,
        paired.screen.id,
        { actorUserId: actor.id },
      ),
    ).resolves.toEqual({ revoked: false, reason: "ALREADY_REVOKED" });
    expect(
      await prisma.auditEvent.count({
        where: { action: "device.credential.revoked" },
      }),
    ).toBe(1);
    await expect(
      prisma.screen.findUniqueOrThrow({ where: { id: paired.screen.id } }),
    ).resolves.toMatchObject({ credentialRevokedAt: expect.any(Date) });
  });

  it("prunes one bounded batch of old device challenges without removing live challenges", async () => {
    const [retentionIndex] = await prisma.$queryRaw<
      Array<{ indexdef: string }>
    >`SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname = 'DeviceAuthChallenge_expiresAt_id_idx'`;
    expect(retentionIndex?.indexdef).toContain(
      'ON public."DeviceAuthChallenge" USING btree ("expiresAt", id)',
    );
    const paired = await pairProofDevice("challenge-retention", 31);
    const createdAt = new Date(
      Date.now() - DEVICE_AUTH_CHALLENGE_RETENTION_MS - 60_000,
    );
    const expiresAt = new Date(createdAt.getTime() + 30_000);
    const consumedAt = new Date(createdAt.getTime() + 10_000);
    const lockedChallengeId = randomToken();
    await prisma.deviceAuthChallenge.createMany({
      data: Array.from(
        { length: DATABASE_MAINTENANCE_BATCH_SIZE + 1 },
        (_, index) => ({
          id: index === 0 ? lockedChallengeId : randomToken(),
          organizationId: paired.organization.id,
          credentialId: paired.credential.id,
          challengeHashSha256: proofHash(),
          operation: "MANIFEST" as const,
          requestDigestSha256: proofHash(),
          createdAt,
          expiresAt,
          consumedAt,
        }),
      ),
    });
    const acquired = deferred();
    const release = deferred();
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT challenge."id"
        FROM "DeviceAuthChallenge" challenge
        WHERE challenge."id" = ${lockedChallengeId}
        FOR UPDATE OF challenge`;
      acquired.resolve();
      await release.promise;
    });
    const holderSettled = holder.then(
      () => ({ succeeded: true as const }),
      (error: unknown) => {
        acquired.reject(error);
        return { succeeded: false as const, error };
      },
    );
    try {
      await acquired.promise;
    } catch (error) {
      release.resolve();
      await holderSettled;
      throw error;
    }
    const issuanceSettled = store
      .issueDeviceAuthChallenge({
        screenId: paired.screen.id,
        keyId: paired.credential.keyId,
        challengeHashSha256: proofHash(),
        operation: "manifest",
        requestDigestSha256: proofHash(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      })
      .then(
        (result) => ({ succeeded: true as const, result }),
        (error: unknown) => ({ succeeded: false as const, error }),
      );
    let timeout: NodeJS.Timeout | undefined;
    const raceResult = await Promise.race([
      issuanceSettled.then(() => ({ timedOut: false as const })),
      new Promise<{ timedOut: true }>((resolve) => {
        timeout = setTimeout(() => resolve({ timedOut: true }), 2_000);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    release.resolve();
    const [holderResult, issuanceResult] = await Promise.all([
      holderSettled,
      issuanceSettled,
    ]);
    if (!holderResult.succeeded) throw holderResult.error;
    if (raceResult.timedOut) {
      throw new Error("challenge issuance waited on a locked retention row");
    }
    if (!issuanceResult.succeeded) throw issuanceResult.error;
    const live = issuanceResult.result;
    if (!live) throw new Error("live challenge was not issued");

    expect(
      await prisma.deviceAuthChallenge.count({
        where: { expiresAt: { lte: expiresAt } },
      }),
    ).toBe(1);
    await expect(
      prisma.deviceAuthChallenge.findUnique({
        where: { id: lockedChallengeId },
      }),
    ).resolves.not.toBeNull();
    await expect(
      prisma.deviceAuthChallenge.findUnique({ where: { id: live.id } }),
    ).resolves.not.toBeNull();
  });

  it("does not prune old challenges when issuance is rejected at the live cap", async () => {
    const paired = await pairProofDevice("challenge-retention-cap", 32);
    const oldChallengeId = randomToken();
    const createdAt = new Date(
      Date.now() - DEVICE_AUTH_CHALLENGE_RETENTION_MS - 60_000,
    );
    await prisma.deviceAuthChallenge.create({
      data: {
        id: oldChallengeId,
        organizationId: paired.organization.id,
        credentialId: paired.credential.id,
        challengeHashSha256: proofHash(),
        operation: "HEARTBEAT",
        requestDigestSha256: proofHash(),
        createdAt,
        expiresAt: new Date(createdAt.getTime() + 30_000),
        consumedAt: new Date(createdAt.getTime() + 10_000),
      },
    });
    const liveExpiresAt = new Date(Date.now() + 30_000);
    await prisma.deviceAuthChallenge.createMany({
      data: Array.from({ length: 4 }, () => ({
        id: randomToken(),
        organizationId: paired.organization.id,
        credentialId: paired.credential.id,
        challengeHashSha256: proofHash(),
        operation: "MANIFEST" as const,
        requestDigestSha256: proofHash(),
        expiresAt: liveExpiresAt,
      })),
    });

    await expect(
      store.issueDeviceAuthChallenge({
        screenId: paired.screen.id,
        keyId: paired.credential.keyId,
        challengeHashSha256: proofHash(),
        operation: "manifest",
        requestDigestSha256: proofHash(),
        expiresAt: liveExpiresAt.toISOString(),
      }),
    ).resolves.toBeNull();
    await expect(
      prisma.deviceAuthChallenge.findUnique({
        where: { id: oldChallengeId },
      }),
    ).resolves.not.toBeNull();
    expect(await prisma.deviceAuthChallenge.count()).toBe(5);
  });

  it("persists proof heartbeats as authoritative playback snapshots", async () => {
    const paired = await pairProofDevice("proof-heartbeat-snapshot", 31);
    const sendHeartbeat = async (data: {
      playerVersion: string;
      manifestVersion: string | null;
      nowPlayingAssetId: string | null;
      uptimeSeconds: number;
      freeStorageBytes: number;
      networkType: string;
    }) => {
      const requestDigestSha256 = proofHash();
      const challengeHashSha256 = proofHash();
      const challenge = await store.issueDeviceAuthChallenge({
        screenId: paired.screen.id,
        keyId: paired.credential.keyId,
        challengeHashSha256,
        operation: "heartbeat",
        requestDigestSha256,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      });
      if (!challenge) throw new Error("device challenge was not issued");
      const result = await store.heartbeatWithDeviceProof(
        {
          credentialId: paired.credential.id,
          challengeId: challenge.id,
          challengeHashSha256,
          operation: "heartbeat",
          requestDigestSha256,
        },
        data,
        () => true,
      );
      return { challengeId: challenge.id, result };
    };

    const initial = await sendHeartbeat({
      playerVersion: "snapshot-1",
      manifestVersion: "release-7",
      nowPlayingAssetId: "asset-7",
      uptimeSeconds: 120,
      freeStorageBytes: 1_000_000,
      networkType: "wifi",
    });
    expect(initial.result).toMatchObject({
      authenticated: true,
      screen: {
        manifestVersion: "release-7",
        nowPlayingAssetId: "asset-7",
      },
    });

    const cleared = await sendHeartbeat({
      playerVersion: "snapshot-2",
      manifestVersion: null,
      nowPlayingAssetId: null,
      uptimeSeconds: 180,
      freeStorageBytes: 900_000,
      networkType: "ethernet",
    });
    expect(cleared.result).toMatchObject({
      authenticated: true,
      screen: {
        playerVersion: "snapshot-2",
        uptimeSeconds: 180,
        freeStorageBytes: 900_000,
        networkType: "ethernet",
      },
    });
    if (!cleared.result.authenticated)
      throw new Error("heartbeat was not authenticated");
    expect(cleared.result.screen).not.toHaveProperty("manifestVersion");
    expect(cleared.result.screen).not.toHaveProperty("nowPlayingAssetId");

    await expect(
      prisma.screen.findUniqueOrThrow({ where: { id: paired.screen.id } }),
    ).resolves.toMatchObject({
      playerVersion: "snapshot-2",
      manifestVersion: null,
      nowPlayingAssetId: null,
      uptimeSeconds: 180n,
      freeStorageBytes: 900_000n,
      networkType: "ethernet",
    });
    expect(
      await prisma.deviceAuthChallenge.count({
        where: {
          id: { in: [initial.challengeId, cleared.challengeId] },
          consumedAt: { not: null },
        },
      }),
    ).toBe(2);
  });

  it("enforces one live credential per screen at the database boundary", async () => {
    const paired = await pairProofDevice("proof-live-unique", 14);
    const duplicate = proofEnrollment(15);

    await expect(
      prisma.deviceCredential.create({
        data: {
          organizationId: paired.organization.id,
          screenId: paired.screen.id,
          liveScreenId: paired.screen.id,
          liveScreenOrganizationId: paired.organization.id,
          keyId: duplicate.keyId,
          publicKeySpki: Buffer.from(duplicate.publicKeySpki, "base64url"),
          algorithm: duplicate.algorithm,
          securityLevel: duplicate.securityLevel,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("rejects NULL components in targeted pending enrollment authority", async () => {
    const organization = await createOrganization("targeted-null-check");
    const actor = await createMember(
      organization.id,
      "OWNER",
      "targeted-null-check-owner",
    );
    const membership = await prisma.membership.findUniqueOrThrow({
      where: {
        organizationId_userId: {
          organizationId: organization.id,
          userId: actor.id,
        },
      },
    });
    const nonMember = await createUser(
      `creator-removal-non-member-${randomUUID()}@example.test`,
    );
    const otherOrganization = await createOrganization(
      "creator-removal-other-tenant",
    );
    await expect(
      prisma.membershipAttribution.create({
        data: {
          organizationId: organization.id,
          userId: nonMember.id,
        },
      }),
    ).rejects.toBeDefined();
    await expect(
      prisma.membershipAttribution.create({
        data: {
          organizationId: otherOrganization.id,
          userId: actor.id,
        },
      }),
    ).rejects.toBeDefined();
    const screen = await store.createScreen(organization.id, {
      name: "NULL check target",
      location: "Lab",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const base = {
      organizationId: organization.id,
      purpose: "NEW_SCREEN" as const,
      targetScreenId: screen.id,
      targetScreenReferenceId: screen.id,
      targetOrganizationId: organization.id,
      expectedGeneration: 0,
      authorizedByUserId: actor.id,
      authorizedByMembershipId: membership.id,
      authorizedByAuthenticationEpoch: actor.authenticationEpoch,
      authorizedByAuthorizationEpoch: membership.authorizationEpoch,
      status: "PENDING" as const,
      expiresAt: new Date(Date.now() + 60_000),
    };
    for (const field of [
      "targetScreenReferenceId",
      "targetOrganizationId",
      "expectedGeneration",
    ] as const) {
      await expect(
        prisma.pairingCode.create({
          data: {
            ...base,
            id: `targeted-null-${field}`,
            codeHash: `targeted-null-${field}-${randomUUID()}`,
            [field]: null,
          },
        }),
      ).rejects.toThrow();
    }
    for (const expectedGeneration of [0, -1]) {
      await expect(
        prisma.pairingCode.create({
          data: {
            ...base,
            id: `terminal-reenroll-generation-${expectedGeneration}`,
            codeHash: `terminal-reenroll-generation-${expectedGeneration}-${randomUUID()}`,
            purpose: "REENROLL",
            status: "REVOKED",
            expectedGeneration,
            requestReason: "Invalid terminal replacement history",
          },
        }),
      ).rejects.toThrow();
    }
    for (const field of [
      "authorizedByMembershipId",
      "authorizedByAuthenticationEpoch",
      "authorizedByAuthorizationEpoch",
    ] as const) {
      await expect(
        prisma.pairingCode.create({
          data: {
            ...base,
            id: `terminal-new-authority-${field}`,
            codeHash: `terminal-new-authority-${field}-${randomUUID()}`,
            status: "REVOKED",
            requestReason: "Invalid terminal enrollment history",
            [field]: null,
          },
        }),
      ).rejects.toThrow();
    }
    for (const [operation, statusCode] of [
      ["SCREEN_ENROLLMENT_CREATE", 200],
      ["SCREEN_ENROLLMENT_ACTIVATE", 201],
    ] as const) {
      await expect(
        prisma.idempotencyRecord.create({
          data: {
            organizationId: organization.id,
            operation,
            keyHash: proofHash(),
            actorUserId: actor.id,
            requestDigestSha256: proofHash(),
            statusCode,
            responseBody: { invalid: true },
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ).rejects.toThrow();
    }
  });

  it("stages targeted initial enrollment and atomically activates one exact fingerprint", async () => {
    const organization = await createOrganization("targeted-enrollment");
    const actor = await createMember(
      organization.id,
      "OWNER",
      "targeted-enrollment-owner",
    );
    const screen = await store.createScreen(organization.id, {
      name: "Precreated player",
      location: "Lab",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const createKeyHash = proofHash();
    const requestDigestSha256 = proofHash();
    const codeHash = `targeted-${randomUUID()}`;
    const requested = await store.requestScreenEnrollmentAndAudit(
      organization.id,
      screen.id,
      new Date(Date.now() + 60_000).toISOString(),
      "Install the precreated player",
      { actorUserId: actor.id },
      {
        keyHash: createKeyHash,
        requestDigestSha256,
        codeCandidates: [{ counter: 0, codeHash }],
      },
    );
    if (!requested.created) throw new Error("initial grant was not created");
    const replay = await store.requestScreenEnrollmentAndAudit(
      organization.id,
      screen.id,
      new Date(Date.now() + 60_000).toISOString(),
      "Install the precreated player",
      { actorUserId: actor.id },
      {
        keyHash: createKeyHash,
        requestDigestSha256,
        codeCandidates: [{ counter: 0, codeHash }],
      },
    );
    expect(replay).toMatchObject({
      created: true,
      replayed: true,
      pairing: { id: requested.pairing.id },
    });

    const stage = async (credential: ReturnType<typeof proofEnrollment>) => {
      const challengeHashSha256 = proofHash();
      const transcriptDigestSha256 = proofHash();
      const attempt = await store.issuePairingChallenge({
        codeHash,
        credential,
        challengeHashSha256,
        transcriptDigestSha256,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      });
      if (!attempt) throw new Error("initial challenge was not issued");
      const result = await store.claimPairingWithCredentialAndAudit(
        {
          codeHash,
          pairingAttemptId: attempt.id,
          challengeHashSha256,
          transcriptDigestSha256,
          keyId: credential.keyId,
          device: {
            installationId: credential.keyId,
            model: "Candidate player",
            osVersion: "15",
            playerVersion: "0.2.0",
          },
        },
        () => true,
        {},
      );
      if (result.paired || result.reason !== "PENDING_APPROVAL")
        throw new Error("initial candidate was not staged");
      return result;
    };
    const [candidateA, candidateB] = await Promise.all([
      stage(proofEnrollment(55)),
      stage(proofEnrollment(56)),
    ]);
    await expect(
      prisma.screen.findUniqueOrThrow({ where: { id: screen.id } }),
    ).resolves.toMatchObject({
      status: "OFFLINE",
      installationId: null,
      credentialGeneration: 0,
    });
    await expect(
      store.activateScreenEnrollmentCandidateAndAudit(
        organization.id,
        screen.id,
        requested.pairing.id,
        candidateA.candidateId,
        candidateB.keyId,
        { actorUserId: actor.id },
        { keyHash: proofHash(), requestDigestSha256: proofHash() },
      ),
    ).resolves.toMatchObject({
      activated: false,
      reason: "FINGERPRINT_MISMATCH",
    });
    const activationKeyA = proofHash();
    const activationDigestA = proofHash();
    const [activationA, activationB] = await Promise.all([
      store.activateScreenEnrollmentCandidateAndAudit(
        organization.id,
        screen.id,
        requested.pairing.id,
        candidateA.candidateId,
        candidateA.keyId,
        { actorUserId: actor.id },
        {
          keyHash: activationKeyA,
          requestDigestSha256: activationDigestA,
        },
      ),
      store.activateScreenEnrollmentCandidateAndAudit(
        organization.id,
        screen.id,
        requested.pairing.id,
        candidateA.candidateId,
        candidateA.keyId,
        { actorUserId: actor.id },
        {
          keyHash: activationKeyA,
          requestDigestSha256: activationDigestA,
        },
      ),
    ]);
    expect(activationA).toMatchObject({ activated: true });
    expect(activationB).toMatchObject({ activated: true });
    if (!activationA.activated || !activationB.activated)
      throw new Error("same-key activation did not replay");
    expect(
      Number(activationA.replayed === true) +
        Number(activationB.replayed === true),
    ).toBe(1);
    const winner = candidateA;
    expect(
      await prisma.deviceCredential.count({
        where: { organizationId: organization.id, screenId: screen.id },
      }),
    ).toBe(1);
    await expect(
      prisma.screen.findUniqueOrThrow({ where: { id: screen.id } }),
    ).resolves.toMatchObject({
      status: "OFFLINE",
      installationId: winner.keyId,
      credentialGeneration: 1,
      lastSeenAt: null,
    });
    await expect(
      store.activateScreenEnrollmentCandidateAndAudit(
        organization.id,
        screen.id,
        requested.pairing.id,
        candidateA.candidateId,
        candidateA.keyId,
        { actorUserId: actor.id },
        {
          keyHash: activationKeyA,
          requestDigestSha256: activationDigestA,
        },
      ),
    ).resolves.toMatchObject({ activated: true, replayed: true });
  });

  it("keeps enrollment maintenance and mutations fail-atomic on rejection and audit failure", async () => {
    const organization = await createOrganization("enrollment-fail-atomic");
    const actor = await createMember(
      organization.id,
      "OWNER",
      "enrollment-fail-atomic-owner",
    );
    const screen = await store.createScreen(organization.id, {
      name: "Fail-atomic target",
      location: "Lab",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const seedSentinel = () =>
      prisma.idempotencyRecord.create({
        data: {
          organizationId: organization.id,
          operation: "SCREEN_ENROLLMENT_CREATE",
          keyHash: proofHash(),
          actorUserId: actor.id,
          requestDigestSha256: proofHash(),
          statusCode: 201,
          responseBody: { sentinel: true },
          expiresAt: new Date(0),
          createdAt: new Date(-1),
        },
      });
    let sentinel = await seedSentinel();
    const requestInput = () => ({
      keyHash: proofHash(),
      requestDigestSha256: proofHash(),
      codeCandidates: [{ counter: 0, codeHash: `fail-atomic-${randomUUID()}` }],
    });
    await expect(
      store.requestScreenEnrollmentAndAudit(
        organization.id,
        "missing-screen",
        new Date(Date.now() + 60_000).toISOString(),
        "Rejected",
        { actorUserId: actor.id },
        requestInput(),
      ),
    ).resolves.toEqual({ created: false, reason: "NOT_FOUND" });
    await expect(
      prisma.idempotencyRecord.findUniqueOrThrow({
        where: { id: sentinel.id },
      }),
    ).resolves.toMatchObject({ responseBody: { sentinel: true } });

    await prisma.$executeRawUnsafe(
      `ALTER TABLE "AuditEvent" ADD CONSTRAINT "integration_reject_enrollment_request_audit" CHECK ("action" <> 'device.enrollment.requested')`,
    );
    try {
      await expect(
        store.requestScreenEnrollmentAndAudit(
          organization.id,
          screen.id,
          new Date(Date.now() + 60_000).toISOString(),
          "Audit rejection",
          { actorUserId: actor.id },
          requestInput(),
        ),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" DROP CONSTRAINT "integration_reject_enrollment_request_audit"',
      );
    }
    await expect(
      prisma.idempotencyRecord.findUniqueOrThrow({
        where: { id: sentinel.id },
      }),
    ).resolves.toMatchObject({ responseBody: { sentinel: true } });
    expect(
      await prisma.pairingCode.count({
        where: { organizationId: organization.id },
      }),
    ).toBe(0);

    await prisma.idempotencyRecord.delete({ where: { id: sentinel.id } });
    const codeHash = `activation-fail-atomic-${randomUUID()}`;
    const requested = await store.requestScreenEnrollmentAndAudit(
      organization.id,
      screen.id,
      new Date(Date.now() + 60_000).toISOString(),
      "Activation audit rejection",
      { actorUserId: actor.id },
      {
        keyHash: proofHash(),
        requestDigestSha256: proofHash(),
        codeCandidates: [{ counter: 0, codeHash }],
      },
    );
    if (!requested.created) throw new Error("grant was not created");
    const credential = proofEnrollment(75);
    const challengeHashSha256 = proofHash();
    const transcriptDigestSha256 = proofHash();
    const attempt = await store.issuePairingChallenge({
      codeHash,
      credential,
      challengeHashSha256,
      transcriptDigestSha256,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    if (!attempt) throw new Error("challenge was not issued");
    const staged = await store.claimPairingWithCredentialAndAudit(
      {
        codeHash,
        pairingAttemptId: attempt.id,
        challengeHashSha256,
        transcriptDigestSha256,
        keyId: credential.keyId,
        device: {
          installationId: credential.keyId,
          model: "Fail-atomic candidate",
          osVersion: "15",
          playerVersion: "0.2.0",
        },
      },
      () => true,
      {},
    );
    if (staged.paired || staged.reason !== "PENDING_APPROVAL")
      throw new Error("candidate was not staged");
    sentinel = await seedSentinel();
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "AuditEvent" ADD CONSTRAINT "integration_reject_enrollment_activation_audit" CHECK ("action" <> 'device.enrollment.activated')`,
    );
    try {
      await expect(
        store.activateScreenEnrollmentCandidateAndAudit(
          organization.id,
          screen.id,
          requested.pairing.id,
          staged.candidateId,
          staged.keyId,
          { actorUserId: actor.id },
          { keyHash: proofHash(), requestDigestSha256: proofHash() },
        ),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" DROP CONSTRAINT "integration_reject_enrollment_activation_audit"',
      );
    }
    await expect(
      prisma.idempotencyRecord.findUniqueOrThrow({
        where: { id: sentinel.id },
      }),
    ).resolves.toMatchObject({ responseBody: { sentinel: true } });
    await expect(
      prisma.pairingCode.findUniqueOrThrow({
        where: { id: requested.pairing.id },
      }),
    ).resolves.toMatchObject({ status: "PENDING" });
    expect(
      await prisma.deviceCredential.count({
        where: { organizationId: organization.id, screenId: screen.id },
      }),
    ).toBe(0);
  });

  it("serializes replacement proof against issuer demotion and revokes staged authority", async () => {
    const paired = await pairProofDevice("reenrollment-proof-demotion", 57);
    const issuer = await createMember(
      paired.organization.id,
      "ADMIN",
      "reenrollment-proof-demotion-issuer",
    );
    await createMember(
      paired.organization.id,
      "OWNER",
      "reenrollment-proof-demotion-owner",
    );
    const grant = await store.requestScreenReenrollmentAndAudit(
      paired.organization.id,
      paired.screen.id,
      `reenroll-${randomUUID()}`,
      new Date(Date.now() + 60_000).toISOString(),
      "Replace player during issuer race",
      { actorUserId: issuer.id },
    );
    if (!grant.created) throw new Error("replacement grant was not created");
    const credential = proofEnrollment(58);
    const challengeHashSha256 = proofHash();
    const transcriptDigestSha256 = proofHash();
    const attempt = await store.issuePairingChallenge({
      codeHash: grant.pairing.codeHash,
      credential,
      challengeHashSha256,
      transcriptDigestSha256,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    if (!attempt) throw new Error("replacement challenge was not issued");
    const [proofResult, demotionResult] =
      await queueOwnerContinuityOperations<unknown>(paired.organization.id, [
        () =>
          store.claimPairingWithCredentialAndAudit(
            {
              codeHash: grant.pairing.codeHash,
              pairingAttemptId: attempt.id,
              challengeHashSha256,
              transcriptDigestSha256,
              keyId: credential.keyId,
              device: {
                installationId: credential.keyId,
                model: "Racing replacement",
                osVersion: "15",
                playerVersion: "0.2.0",
              },
            },
            () => true,
            {},
          ),
        () =>
          store.changeMembershipRoleAndAudit(
            paired.organization.id,
            issuer.id,
            "VIEWER",
            { reason: "Concurrent issuer demotion" },
          ),
      ]);
    const proof = proofResult as { paired: boolean };
    const demotion = demotionResult as { updated: boolean; reason?: string };
    expect(demotion).toEqual({ updated: true });
    expect(proof.paired).toBe(false);
    await expect(
      prisma.pairingCode.findUniqueOrThrow({ where: { id: grant.pairing.id } }),
    ).resolves.toMatchObject({ status: "REVOKED" });
    await expect(
      prisma.pairingAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
    ).resolves.toMatchObject({ cancelledAt: expect.any(Date) });
  });

  it("prunes terminal enrollment authority without crossing tenant boundaries", async () => {
    const [ownOrganization, foreignOrganization] = await Promise.all([
      createOrganization("enrollment-retention-own"),
      createOrganization("enrollment-retention-foreign"),
    ]);
    const ownActor = await createMember(
      ownOrganization.id,
      "OWNER",
      "enrollment-retention-own",
    );
    const target = await store.createScreen(ownOrganization.id, {
      name: "Retention target",
      location: "Lab",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const oldExpiry = new Date(Date.now() - 31 * 24 * 60 * 60_000);
    await prisma.pairingCode.createMany({
      data: [
        ...Array.from(
          { length: DATABASE_MAINTENANCE_BATCH_SIZE + 5 },
          (_, index) => ({
            id: `retention-own-grant-${index.toString().padStart(3, "0")}`,
            organizationId: ownOrganization.id,
            codeHash: `retention-own-${randomUUID()}`,
            status: "EXPIRED" as const,
            expiresAt: oldExpiry,
          }),
        ),
        {
          id: "retention-foreign-grant",
          organizationId: foreignOrganization.id,
          codeHash: `retention-foreign-${randomUUID()}`,
          status: "EXPIRED",
          expiresAt: oldExpiry,
        },
      ],
    });
    await prisma.idempotencyRecord.createMany({
      data: [
        ...Array.from({ length: DATABASE_MAINTENANCE_BATCH_SIZE + 5 }, () => ({
          organizationId: ownOrganization.id,
          operation: "SCREEN_ENROLLMENT_CREATE" as const,
          keyHash: proofHash(),
          actorUserId: ownActor.id,
          requestDigestSha256: proofHash(),
          statusCode: 201,
          responseBody: { retained: true },
          expiresAt: oldExpiry,
          createdAt: new Date(oldExpiry.getTime() - 1),
        })),
        {
          organizationId: foreignOrganization.id,
          operation: "SCREEN_ENROLLMENT_CREATE",
          keyHash: proofHash(),
          actorUserId: "foreign-retention-fixture",
          requestDigestSha256: proofHash(),
          statusCode: 201,
          responseBody: { retained: true },
          expiresAt: oldExpiry,
          createdAt: new Date(oldExpiry.getTime() - 1),
        },
      ],
    });
    await expect(
      store.requestScreenEnrollmentAndAudit(
        ownOrganization.id,
        target.id,
        new Date(Date.now() + 60_000).toISOString(),
        "Trigger tenant retention cleanup",
        { actorUserId: ownActor.id },
        {
          keyHash: proofHash(),
          requestDigestSha256: proofHash(),
          codeCandidates: [
            { counter: 0, codeHash: `retention-new-${randomUUID()}` },
          ],
        },
      ),
    ).resolves.toMatchObject({ created: true });
    expect(
      await prisma.pairingCode.count({
        where: {
          organizationId: ownOrganization.id,
          id: { startsWith: "retention-own-grant-" },
        },
      }),
    ).toBe(5);
    expect(
      await prisma.pairingCode.count({
        where: { id: "retention-foreign-grant" },
      }),
    ).toBe(1);
    expect(
      await prisma.idempotencyRecord.count({
        where: {
          organizationId: ownOrganization.id,
          expiresAt: { lte: oldExpiry },
        },
      }),
    ).toBe(DATABASE_MAINTENANCE_BATCH_SIZE + 5);
    expect(
      await prisma.idempotencyRecord.count({
        where: {
          organizationId: ownOrganization.id,
          expiresAt: { lte: oldExpiry },
          responseBody: { not: Prisma.DbNull },
        },
      }),
    ).toBe(5);
    expect(
      await prisma.idempotencyRecord.count({
        where: {
          organizationId: foreignOrganization.id,
          expiresAt: { lte: oldExpiry },
        },
      }),
    ).toBe(1);
  });

  it("contains a screen while replacing and reasserting targeted re-enrollment grants", async () => {
    const paired = await pairProofDevice("proof-reenrollment", 18);
    const actor = await createUser("proof-reenrollment-owner@example.test");
    await prisma.membership.create({
      data: {
        organizationId: paired.organization.id,
        userId: actor.id,
        role: "OWNER",
      },
    });
    const expiredChallengeId = Buffer.alloc(32, 23).toString("base64url");
    await prisma.deviceAuthChallenge.create({
      data: {
        id: expiredChallengeId,
        organizationId: paired.organization.id,
        credentialId: paired.credential.id,
        challengeHashSha256: proofHash(),
        operation: "MANIFEST",
        requestDigestSha256: proofHash(),
        createdAt: new Date(Date.now() - 90_000),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    const first = await store.requestScreenReenrollmentAndAudit(
      paired.organization.id,
      paired.screen.id,
      `reenroll-${randomUUID()}`,
      new Date(Date.now() + 60_000).toISOString(),
      "Replace failed player hardware",
      { actorUserId: actor.id },
    );
    expect(first).toMatchObject({ created: true });
    expect(
      await prisma.deviceAuthChallenge.findUniqueOrThrow({
        where: { id: expiredChallengeId },
      }),
    ).toMatchObject({ consumedAt: null });
    expect(
      await prisma.deviceCredential.findUniqueOrThrow({
        where: { id: paired.credential.id },
      }),
    ).toMatchObject({
      revokedAt: expect.any(Date),
      liveScreenId: null,
      liveScreenOrganizationId: null,
    });
    const second = await store.requestScreenReenrollmentAndAudit(
      paired.organization.id,
      paired.screen.id,
      `reenroll-${randomUUID()}`,
      new Date(Date.now() + 60_000).toISOString(),
      "Retry because the response was lost",
      { actorUserId: actor.id },
    );
    expect(second).toMatchObject({ created: true });
    if (!first.created || !second.created)
      throw new Error("re-enrollment grant creation failed");
    expect(
      await prisma.pairingCode.findUniqueOrThrow({
        where: { id: first.pairing.id },
      }),
    ).toMatchObject({ status: "REVOKED" });
    await expect(
      store.revokeDeviceCredentialAndAudit(
        paired.organization.id,
        paired.screen.id,
        { actorUserId: actor.id },
      ),
    ).resolves.toMatchObject({ revoked: true });
    expect(
      await prisma.pairingCode.findUniqueOrThrow({
        where: { id: second.pairing.id },
      }),
    ).toMatchObject({ status: "REVOKED" });
    expect(
      await prisma.screen.findUniqueOrThrow({
        where: { id: paired.screen.id },
      }),
    ).toMatchObject({
      credentialGeneration: 4,
      credentialRevokedAt: expect.any(Date),
    });
    expect(
      await prisma.auditEvent.count({
        where: { action: "device.credential.revocation_reasserted" },
      }),
    ).toBe(1);
  });

  it("activates a proved replacement after its short proof attempt has expired", async () => {
    const staged = await stageReenrollmentCandidate(
      "proof-reenrollment-delayed",
      19,
      20,
    );
    await expect(
      prisma.screen.findUniqueOrThrow({
        where: { id: staged.paired.screen.id },
      }),
    ).resolves.toMatchObject({
      status: "OFFLINE",
      lastSeenAt: null,
      manifestVersion: null,
      nowPlayingAssetId: null,
      uptimeSeconds: null,
      freeStorageBytes: null,
      networkType: null,
    });
    await prisma.$executeRaw`
      UPDATE "PairingAttempt"
      SET "createdAt" = CURRENT_TIMESTAMP - INTERVAL '30 seconds',
          "provedAt" = CURRENT_TIMESTAMP - INTERVAL '2 seconds',
          "expiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
      WHERE "id" = ${staged.candidate.candidateId}`;

    const activated = await store.activateReenrollmentCandidateAndAudit(
      staged.paired.organization.id,
      staged.paired.screen.id,
      staged.grant.id,
      staged.candidate.candidateId,
      { actorUserId: staged.actor.id },
    );

    expect(activated).toMatchObject({
      activated: true,
      screen: { id: staged.paired.screen.id, status: "offline" },
      credential: { keyId: staged.credential.keyId },
    });
    if (!activated.activated) throw new Error("replacement activation failed");
    expect(activated.screen).not.toHaveProperty("lastSeenAt");
    expect(activated.screen).not.toHaveProperty("manifestVersion");
    expect(activated.screen).not.toHaveProperty("nowPlayingAssetId");
    expect(activated.screen).not.toHaveProperty("uptimeSeconds");
    expect(activated.screen).not.toHaveProperty("freeStorageBytes");
    expect(activated.screen).not.toHaveProperty("networkType");
    expect(await prisma.screen.count()).toBe(1);
    expect(
      await prisma.deviceCredential.count({
        where: {
          liveScreenId: staged.paired.screen.id,
          revokedAt: null,
        },
      }),
    ).toBe(1);
    const challengeHashSha256 = proofHash();
    const requestDigestSha256 = proofHash();
    const heartbeatChallenge = await store.issueDeviceAuthChallenge({
      screenId: staged.paired.screen.id,
      keyId: activated.credential.keyId,
      challengeHashSha256,
      operation: "heartbeat",
      requestDigestSha256,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    if (!heartbeatChallenge)
      throw new Error("replacement heartbeat challenge failed");
    const heartbeat = await store.heartbeatWithDeviceProof(
      {
        credentialId: activated.credential.id,
        challengeId: heartbeatChallenge.id,
        challengeHashSha256,
        operation: "heartbeat",
        requestDigestSha256,
      },
      {
        playerVersion: "replacement-player",
        manifestVersion: "replacement-manifest",
        nowPlayingAssetId: "replacement-asset",
        uptimeSeconds: 1,
        freeStorageBytes: 654_321,
        networkType: "replacement-network",
      },
      () => true,
    );
    expect(heartbeat).toMatchObject({
      authenticated: true,
      screen: {
        status: "online",
        manifestVersion: "replacement-manifest",
        nowPlayingAssetId: "replacement-asset",
        uptimeSeconds: 1,
        freeStorageBytes: 654_321,
        networkType: "replacement-network",
        lastSeenAt: expect.any(String),
      },
    });
  });

  it("heals only revoked or never-heartbeaten legacy replacement telemetry", async () => {
    const activate = async (
      label: string,
      oldKeyByte: number,
      newKeyByte: number,
    ) => {
      const staged = await stageReenrollmentCandidate(
        label,
        oldKeyByte,
        newKeyByte,
      );
      const activated = await store.activateReenrollmentCandidateAndAudit(
        staged.paired.organization.id,
        staged.paired.screen.id,
        staged.grant.id,
        staged.candidate.candidateId,
        { actorUserId: staged.actor.id },
      );
      if (!activated.activated)
        throw new Error("replacement activation failed");
      return { staged, activated };
    };
    const stale = await activate("legacy-replacement-stale", 40, 41);
    const staleAttempt = await prisma.pairingAttempt.findUniqueOrThrow({
      where: { id: stale.staged.candidate.candidateId },
    });
    await prisma.screen.update({
      where: { id: stale.staged.paired.screen.id },
      data: {
        status: "ONLINE",
        lastSeenAt: staleAttempt.activatedAt,
        manifestVersion: "legacy-manifest",
        nowPlayingAssetId: "legacy-asset",
        uptimeSeconds: 90n,
        freeStorageBytes: 91n,
        networkType: "legacy-network",
      },
    });

    const current = await activate("replacement-with-heartbeat", 42, 43);
    const challengeHashSha256 = proofHash();
    const requestDigestSha256 = proofHash();
    const challenge = await store.issueDeviceAuthChallenge({
      screenId: current.staged.paired.screen.id,
      keyId: current.activated.credential.keyId,
      challengeHashSha256,
      operation: "heartbeat",
      requestDigestSha256,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    if (!challenge) throw new Error("replacement heartbeat challenge failed");
    const heartbeat = await store.heartbeatWithDeviceProof(
      {
        credentialId: current.activated.credential.id,
        challengeId: challenge.id,
        challengeHashSha256,
        operation: "heartbeat",
        requestDigestSha256,
      },
      {
        playerVersion: "current-player",
        manifestVersion: "current-manifest",
        nowPlayingAssetId: "current-asset",
        uptimeSeconds: 100,
        freeStorageBytes: 101,
        networkType: "current-network",
      },
      () => true,
    );
    if (!heartbeat.authenticated)
      throw new Error("replacement heartbeat failed");
    await prisma.pairingAttempt.update({
      where: { id: current.staged.candidate.candidateId },
      data: {
        activatedAt: new Date(
          new Date(heartbeat.screen.lastSeenAt!).getTime() + 1_000,
        ),
      },
    });

    const revoked = await pairProofDevice("legacy-revoked-stale", 44);
    const revokedActor = await createMember(
      revoked.organization.id,
      "OWNER",
      "legacy-revoked-owner",
    );
    await store.revokeDeviceCredentialAndAudit(
      revoked.organization.id,
      revoked.screen.id,
      { actorUserId: revokedActor.id },
    );
    await prisma.screen.update({
      where: { id: revoked.screen.id },
      data: {
        status: "ONLINE",
        lastSeenAt: new Date(),
        manifestVersion: "revoked-manifest",
        nowPlayingAssetId: "revoked-asset",
        uptimeSeconds: 200n,
        freeStorageBytes: 201n,
        networkType: "revoked-network",
      },
    });

    const migration = await readFile(
      new URL(
        "../prisma/migrations/20260912153000_heal_detached_device_telemetry/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await prisma.$executeRawUnsafe(migration);

    for (const screenId of [stale.staged.paired.screen.id, revoked.screen.id]) {
      await expect(
        prisma.screen.findUniqueOrThrow({ where: { id: screenId } }),
      ).resolves.toMatchObject({
        status: "OFFLINE",
        lastSeenAt: null,
        manifestVersion: null,
        nowPlayingAssetId: null,
        uptimeSeconds: null,
        freeStorageBytes: null,
        networkType: null,
      });
    }
    await expect(
      prisma.screen.findUniqueOrThrow({
        where: { id: current.staged.paired.screen.id },
      }),
    ).resolves.toMatchObject({
      status: "ONLINE",
      manifestVersion: "current-manifest",
      nowPlayingAssetId: "current-asset",
      uptimeSeconds: 100n,
      freeStorageBytes: 101n,
      networkType: "current-network",
    });
    const firstPass = await prisma.screen.findMany({
      where: {
        id: {
          in: [
            stale.staged.paired.screen.id,
            current.staged.paired.screen.id,
            revoked.screen.id,
          ],
        },
      },
      orderBy: { id: "asc" },
      select: { id: true, updatedAt: true },
    });
    await prisma.$executeRawUnsafe(migration);
    await expect(
      prisma.screen.findMany({
        where: {
          id: {
            in: [
              stale.staged.paired.screen.id,
              current.staged.paired.screen.id,
              revoked.screen.id,
            ],
          },
        },
        orderBy: { id: "asc" },
        select: { id: true, updatedAt: true },
      }),
    ).resolves.toEqual(firstPass);
  });

  it("serializes cancellation against replacement activation", async () => {
    const staged = await stageReenrollmentCandidate(
      "proof-reenrollment-cancel-race",
      21,
      22,
    );
    const [activation, cancellation] = await Promise.all([
      store.activateReenrollmentCandidateAndAudit(
        staged.paired.organization.id,
        staged.paired.screen.id,
        staged.grant.id,
        staged.candidate.candidateId,
        { actorUserId: staged.actor.id },
      ),
      store.cancelScreenReenrollmentAndAudit(
        staged.paired.organization.id,
        staged.paired.screen.id,
        staged.grant.id,
        { actorUserId: staged.actor.id },
      ),
    ]);
    expect(Number(activation.activated) + Number(cancellation.cancelled)).toBe(
      1,
    );
    const grant = await prisma.pairingCode.findUniqueOrThrow({
      where: { id: staged.grant.id },
    });
    const liveReplacementCount = await prisma.deviceCredential.count({
      where: {
        keyId: staged.credential.keyId,
        liveScreenId: staged.paired.screen.id,
        revokedAt: null,
      },
    });
    expect(grant.status).toBe(activation.activated ? "CLAIMED" : "REVOKED");
    expect(liveReplacementCount).toBe(activation.activated ? 1 : 0);
    expect(
      await prisma.auditEvent.count({
        where: {
          action: {
            in: [
              "device.reenrollment.activated",
              "device.reenrollment.cancelled",
            ],
          },
        },
      }),
    ).toBe(1);
  });

  it("can delete a tenant containing consumed proof history", async () => {
    const paired = await pairProofDevice("proof-tenant-delete", 16);

    await expect(
      prisma.organization.delete({ where: { id: paired.organization.id } }),
    ).resolves.toMatchObject({ id: paired.organization.id });
    expect(await prisma.pairingAttempt.count()).toBe(0);
    expect(await prisma.deviceCredential.count()).toBe(0);
    expect(
      await prisma.deviceKeyTombstone.findUnique({
        where: { keyId: paired.credential.keyId },
      }),
    ).not.toBeNull();
    const replacementOrg = await createOrganization("proof-key-reuse-denied");
    const replacementPairing = await store.createPairing(
      replacementOrg.id,
      `proof-code-${randomUUID()}`,
      new Date(Date.now() + 60_000).toISOString(),
    );
    await expect(
      store.issuePairingChallenge({
        codeHash: replacementPairing.codeHash,
        credential: proofEnrollment(16),
        challengeHashSha256: proofHash(),
        transcriptDigestSha256: proofHash(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      }),
    ).resolves.toBeNull();
  });

  it("surfaces database uniqueness conflicts and scopes playlist names per tenant", async () => {
    const [alpha, beta] = await Promise.all([
      createOrganization("unique-alpha"),
      createOrganization("unique-beta"),
    ]);
    await store.createPlaylist(alpha.id, {
      name: "Shared name",
      description: "First",
      items: [],
    });
    await store.createPlaylist(beta.id, {
      name: "Shared name",
      description: "Other tenant",
      items: [],
    });

    await expect(
      store.createPlaylist(alpha.id, {
        name: "Shared name",
        description: "Duplicate in one tenant",
        items: [],
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    const codeHash = `unique-code-${randomUUID()}`;
    await store.createPairing(
      alpha.id,
      codeHash,
      new Date(Date.now() + 60_000).toISOString(),
    );
    await expect(
      store.tryCreatePairing(
        beta.id,
        codeHash,
        new Date(Date.now() + 60_000).toISOString(),
      ),
    ).resolves.toEqual({ created: false, reason: "CODE_COLLISION" });
  });

  it("round-trips safe bigint media and heartbeat counters through DTO conversion", async () => {
    const organization = await createOrganization("bigint");
    const sizeBytes = Number.MAX_SAFE_INTEGER;
    const media = await store.createMedia(organization.id, {
      name: "Large logical asset",
      kind: "video",
      mimeType: "video/mp4",
      url: "https://media.example.test/large.mp4",
      checksumSha256: "c".repeat(64),
      sizeBytes,
    });
    const screen = await store.createScreen(organization.id, {
      name: "Counter player",
      location: "Lab",
      orientation: "landscape",
      resolution: "3840x2160",
      tags: [],
    });
    const heartbeat = await store.heartbeat(screen.id, {
      playerVersion: "bigint-test",
      manifestVersion: null,
      nowPlayingAssetId: null,
      uptimeSeconds: sizeBytes,
      freeStorageBytes: sizeBytes - 1,
      networkType: "integration",
    });

    expect(media.sizeBytes).toBe(sizeBytes);
    expect(heartbeat).toMatchObject({
      uptimeSeconds: sizeBytes,
      freeStorageBytes: sizeBytes - 1,
    });
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({ where: { id: media.id } }),
    ).resolves.toMatchObject({ sizeBytes: BigInt(sizeBytes) });

    await prisma.mediaAsset.update({
      where: { id: media.id },
      data: { sizeBytes: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
    });
    await expect(store.getMedia(organization.id, media.id)).rejects.toThrow(
      /safe-integer range/,
    );
  });

  it("resolves login identity eligibility in one store operation without leaking membership state", async () => {
    const [alpha, beta] = await Promise.all([
      prisma.organization.create({
        data: {
          id: "integration-org-a",
          name: "Integration membership alpha",
          slug: `integration-membership-alpha-${randomUUID()}`,
        },
      }),
      prisma.organization.create({
        data: {
          id: "integration-org-b",
          name: "Integration membership beta",
          slug: `integration-membership-beta-${randomUUID()}`,
        },
      }),
    ]);
    const user = await createUser("Owner@Example.Test");
    const disabledUser = await createUser("disabled-login@example.test");
    const membershiplessUser = await createUser(
      "membershipless-login@example.test",
    );
    await prisma.membership.createMany({
      data: [
        {
          organizationId: alpha.id,
          userId: user.id,
          role: "OWNER",
        },
        {
          organizationId: beta.id,
          userId: user.id,
          role: "VIEWER",
        },
        {
          organizationId: alpha.id,
          userId: disabledUser.id,
          role: "VIEWER",
        },
      ],
    });
    await prisma.user.update({
      where: { id: disabledUser.id },
      data: { disabledAt: new Date() },
    });

    const loginUser = await store.findUserByEmail("owner@example.test");
    expect(loginUser).toMatchObject({
      id: user.id,
      email: user.email,
      organizationId: alpha.id,
      role: "OWNER",
    });
    await expect(store.findUserByEmail(disabledUser.email)).resolves.toBeNull();
    await expect(
      store.findUserByEmail(membershiplessUser.email),
    ).resolves.toBeNull();
    await expect(
      store.findUserByEmail("unknown-login@example.test"),
    ).resolves.toBeNull();
    await expect(
      store.findSessionUser(user.id, alpha.id),
    ).resolves.toMatchObject({ organizationId: alpha.id, role: "OWNER" });
    await expect(
      store.findSessionUser(user.id, beta.id),
    ).resolves.toMatchObject({ organizationId: beta.id, role: "VIEWER" });
  });

  it("serializes and bounds opaque failed-login telemetry", async () => {
    const accountKey = opaqueSecurityEventKey(
      "integration-telemetry-secret",
      "login-failure-account",
      "unknown@example.test",
    );
    const sourceKey = opaqueSecurityEventKey(
      "integration-telemetry-secret",
      "login-failure-source",
      "192.0.2.1",
    );
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.recordLoginFailure({
          accountKey,
          sourceKey,
          reason: index === 7 ? "RATE_LIMITED" : "INVALID_CREDENTIALS",
        }),
      ),
    );
    expect(await prisma.loginFailureEvent.count()).toBe(8);
    expect(
      await prisma.loginFailureEvent.count({
        where: { accountKey, sourceKey },
      }),
    ).toBe(8);

    await prisma.loginFailureEvent.create({
      data: {
        accountKey: "a".repeat(64),
        sourceKey: "b".repeat(64),
        reason: "INVALID_CREDENTIALS",
        occurredAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      },
    });
    await prisma.loginFailureEvent.createMany({
      data: Array.from({ length: LOGIN_FAILURE_MAX_RECORDS }, (_, index) => ({
        accountKey: "c".repeat(64),
        sourceKey: "d".repeat(64),
        reason: "INVALID_CREDENTIALS" as const,
        occurredAt: new Date(Date.now() - 60_000 + index),
      })),
    });
    const newestAccountKey = "e".repeat(64);
    await store.recordLoginFailure({
      accountKey: newestAccountKey,
      sourceKey: "f".repeat(64),
      reason: "RATE_LIMITED",
    });
    expect(await prisma.loginFailureEvent.count()).toBe(
      LOGIN_FAILURE_MAX_RECORDS,
    );
    expect(
      await prisma.loginFailureEvent.count({
        where: {
          occurredAt: {
            lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
          },
        },
      }),
    ).toBe(0);
    await expect(
      prisma.loginFailureEvent.findFirst({
        where: { accountKey: newestAccountKey },
      }),
    ).resolves.not.toBeNull();

    await expect(
      store.recordLoginFailure({
        accountKey: "unknown@example.test",
        sourceKey,
        reason: "INVALID_CREDENTIALS",
      }),
    ).rejects.toThrow("opaque");
  });

  it("tracks, prunes, and independently revokes user sessions", async () => {
    const [organization, otherOrganization] = await Promise.all([
      createOrganization("user-sessions"),
      createOrganization("user-sessions-other"),
    ]);
    const actor = await createMember(organization.id, "OWNER", "sessions");
    const expiredHash = "c".repeat(64);
    await prisma.userSession.create({
      data: {
        organizationId: organization.id,
        userId: actor.id,
        tokenHash: expiredHash,
        authenticationEpoch: 0,
        authorizationEpoch: 0,
        expiresAt: new Date(Date.now() - 1_000),
      },
    });
    const createSession = (tokenHash: string) =>
      store.createUserSessionAndAudit(
        organization.id,
        {
          tokenHash,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          expectedPasswordHash: actor.passwordHash,
          expectedRole: "OWNER",
          expectedAuthenticationEpoch: 0,
          expectedAuthorizationEpoch: 0,
        },
        { actorUserId: actor.id, requestId: `login-${tokenHash[0]}` },
      );
    const firstHash = "a".repeat(64);
    const secondHash = "b".repeat(64);
    const first = await createSession(firstHash);
    const second = await createSession(secondHash);
    expect(first).toMatchObject({ created: true });
    expect(second).toMatchObject({ created: true });
    expect(
      await prisma.userSession.findUnique({
        where: { tokenHash: expiredHash },
      }),
    ).toBeNull();
    await expect(
      store.findActiveUserSession(actor.id, organization.id, firstHash),
    ).resolves.toMatchObject({ id: actor.id, role: "OWNER" });
    await prisma.user.update({
      where: { id: actor.id },
      data: {
        bootstrapPasswordExpiresAt: new Date(Date.now() + 30 * 60_000),
      },
    });
    await expect(
      store.findActiveUserSession(actor.id, organization.id, firstHash),
    ).resolves.toBeNull();
    await prisma.user.update({
      where: { id: actor.id },
      data: { bootstrapPasswordExpiresAt: null },
    });
    await expect(
      store.findActiveUserSession(actor.id, otherOrganization.id, firstHash),
    ).resolves.toBeNull();

    const revocations = await Promise.all([
      store.revokeUserSessionAndAudit(actor.id, organization.id, firstHash, {
        actorUserId: actor.id,
        requestId: "logout-first",
      }),
      store.revokeUserSessionAndAudit(actor.id, organization.id, firstHash, {
        actorUserId: actor.id,
        requestId: "logout-race",
      }),
    ]);
    expect(revocations.filter((result) => result.revoked)).toHaveLength(1);
    expect(
      revocations.filter(
        (result) => !result.revoked && result.reason === "NOT_FOUND",
      ),
    ).toHaveLength(1);
    await expect(
      store.findActiveUserSession(actor.id, organization.id, firstHash),
    ).resolves.toBeNull();
    await expect(
      store.findActiveUserSession(actor.id, organization.id, secondHash),
    ).resolves.toMatchObject({ id: actor.id });
    expect(
      await prisma.auditEvent.count({
        where: {
          organizationId: organization.id,
          action: "auth.logout",
        },
      }),
    ).toBe(1);
  });

  it("atomically consumes a bootstrap marker and its exact rotation session", async () => {
    const [organization, otherOrganization] = await Promise.all([
      createOrganization("bootstrap-rotation"),
      createOrganization("bootstrap-rotation-other"),
    ]);
    const actor = await createMember(
      organization.id,
      "OWNER",
      "bootstrap-rotation",
    );
    await prisma.membership.create({
      data: {
        organizationId: otherOrganization.id,
        userId: actor.id,
        role: "VIEWER",
      },
    });
    const bootstrapPasswordExpiresAt = new Date(Date.now() + 30 * 60_000);
    await prisma.user.update({
      where: { id: actor.id },
      data: { bootstrapPasswordExpiresAt },
    });
    const loginUser = await store.findUserByEmail(actor.email);
    expect(loginUser?.bootstrapPasswordExpiresAt).toBe(
      bootstrapPasswordExpiresAt.toISOString(),
    );
    await expect(
      store.findSessionUser(actor.id, organization.id),
    ).resolves.toMatchObject({
      bootstrapPasswordExpiresAt: bootstrapPasswordExpiresAt.toISOString(),
    });
    const tokenHash = "e".repeat(64);
    const issued = await store.createUserSessionAndAudit(
      organization.id,
      {
        tokenHash,
        expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
        expectedPasswordHash: actor.passwordHash,
        expectedRole: "OWNER",
        expectedAuthenticationEpoch: 0,
        expectedAuthorizationEpoch: 0,
        purpose: "BOOTSTRAP_PASSWORD_ROTATION",
        expectedBootstrapPasswordExpiresAt:
          bootstrapPasswordExpiresAt.toISOString(),
      },
      { actorUserId: actor.id, requestId: "bootstrap-login" },
    );
    expect(issued).toMatchObject({
      created: true,
      session: { purpose: "BOOTSTRAP_PASSWORD_ROTATION" },
    });
    await expect(
      store.findActiveUserSession(actor.id, organization.id, tokenHash),
    ).resolves.toMatchObject({
      sessionPurpose: "BOOTSTRAP_PASSWORD_ROTATION",
      bootstrapPasswordExpiresAt: bootstrapPasswordExpiresAt.toISOString(),
    });
    await prisma.user.update({
      where: { id: actor.id },
      data: { bootstrapPasswordExpiresAt: null },
    });
    await expect(
      store.findActiveUserSession(actor.id, organization.id, tokenHash),
    ).resolves.toBeNull();
    await prisma.user.update({
      where: { id: actor.id },
      data: { bootstrapPasswordExpiresAt },
    });

    const rotated = await store.rotateBootstrapPasswordAndAudit(
      actor.id,
      organization.id,
      {
        tokenHash,
        expectedPasswordHash: actor.passwordHash,
        expectedBootstrapPasswordExpiresAt:
          bootstrapPasswordExpiresAt.toISOString(),
        expectedAuthenticationEpoch: 0,
        expectedAuthorizationEpoch: 0,
        passwordHash: approvedPasswordHash,
      },
      { actorUserId: actor.id, requestId: "bootstrap-rotate" },
    );
    expect(rotated).toEqual({
      rotated: true,
      affectedOrganizationIds: [organization.id, otherOrganization.id].sort(),
    });
    await expect(
      store.findActiveUserSession(actor.id, organization.id, tokenHash),
    ).resolves.toBeNull();
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: actor.id } }),
    ).resolves.toMatchObject({
      passwordHash: approvedPasswordHash,
      bootstrapPasswordExpiresAt: null,
      authenticationEpoch: 1,
    });
    expect(
      await prisma.auditEvent.count({
        where: {
          actorUserId: actor.id,
          action: "auth.bootstrap_password_rotated",
        },
      }),
    ).toBe(2);
    await expect(
      store.rotateBootstrapPasswordAndAudit(
        actor.id,
        organization.id,
        {
          tokenHash,
          expectedPasswordHash: actor.passwordHash,
          expectedBootstrapPasswordExpiresAt:
            bootstrapPasswordExpiresAt.toISOString(),
          expectedAuthenticationEpoch: 0,
          expectedAuthorizationEpoch: 0,
          passwordHash: approvedPasswordHash,
        },
        { actorUserId: actor.id },
      ),
    ).resolves.toEqual({ rotated: false, reason: "FORBIDDEN" });
  });

  it("rolls back bootstrap rotation when its audit cannot commit", async () => {
    const organization = await createOrganization("bootstrap-audit-rollback");
    const actor = await createMember(
      organization.id,
      "OWNER",
      "bootstrap-audit-rollback",
    );
    const bootstrapPasswordExpiresAt = new Date(Date.now() + 30 * 60_000);
    await prisma.user.update({
      where: { id: actor.id },
      data: { bootstrapPasswordExpiresAt },
    });
    const tokenHash = "7".repeat(64);
    await expect(
      store.createUserSessionAndAudit(
        organization.id,
        {
          tokenHash,
          expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
          expectedPasswordHash: actor.passwordHash,
          expectedRole: "OWNER",
          expectedAuthenticationEpoch: 0,
          expectedAuthorizationEpoch: 0,
          purpose: "BOOTSTRAP_PASSWORD_ROTATION",
          expectedBootstrapPasswordExpiresAt:
            bootstrapPasswordExpiresAt.toISOString(),
        },
        { actorUserId: actor.id },
      ),
    ).resolves.toMatchObject({ created: true });
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "AuditEvent" ADD CONSTRAINT "integration_reject_bootstrap_rotation_audit" CHECK ("action" <> \'auth.bootstrap_password_rotated\')',
    );
    try {
      await expect(
        store.rotateBootstrapPasswordAndAudit(
          actor.id,
          organization.id,
          {
            tokenHash,
            expectedPasswordHash: actor.passwordHash,
            expectedBootstrapPasswordExpiresAt:
              bootstrapPasswordExpiresAt.toISOString(),
            expectedAuthenticationEpoch: 0,
            expectedAuthorizationEpoch: 0,
            passwordHash: approvedPasswordHash,
          },
          { actorUserId: actor.id },
        ),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" DROP CONSTRAINT "integration_reject_bootstrap_rotation_audit"',
      );
    }
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: actor.id } }),
    ).resolves.toMatchObject({
      passwordHash: actor.passwordHash,
      bootstrapPasswordExpiresAt,
      authenticationEpoch: 0,
    });
    await expect(
      store.findActiveUserSession(actor.id, organization.id, tokenHash),
    ).resolves.toMatchObject({
      sessionPurpose: "BOOTSTRAP_PASSWORD_ROTATION",
    });
  });

  it("recovers an owner through one audited, authority-revoking transaction", async () => {
    const fixture = await createBootstrapRecoveryFixture(
      "bootstrap-recovery",
      "bootstrap-recovery-current-password",
      true,
    );
    const temporaryPassword = "bootstrap-recovery-temporary-password";
    const [before] = await prisma.$queryRaw<Array<{ databaseNow: Date }>>`
      SELECT CURRENT_TIMESTAMP AS "databaseNow"`;
    if (!before) throw new Error("Database clock was unavailable");

    const recovered = await recoverBootstrapPassword(prisma, {
      acknowledgement: BOOTSTRAP_RECOVERY_ACKNOWLEDGEMENT,
      email: fixture.actor.email.toUpperCase(),
      temporaryPassword,
    });
    const [after] = await prisma.$queryRaw<Array<{ databaseNow: Date }>>`
      SELECT CURRENT_TIMESTAMP AS "databaseNow"`;
    if (!after) throw new Error("Database clock was unavailable");

    expect(recovered).toMatchObject({
      userId: fixture.actor.id,
      normalizedEmail: fixture.actor.email,
      affectedOrganizationCount: 2,
    });
    expect(recovered.changeBefore.getTime()).toBeGreaterThanOrEqual(
      before.databaseNow.getTime() + 30 * 60_000,
    );
    expect(recovered.changeBefore.getTime()).toBeLessThanOrEqual(
      after.databaseNow.getTime() + 30 * 60_000,
    );
    const recoveredActor = await prisma.user.findUniqueOrThrow({
      where: { id: fixture.actor.id },
    });
    expect(recoveredActor).toMatchObject({
      authenticationEpoch: 1,
      bootstrapPasswordExpiresAt: recovered.changeBefore,
    });
    await expect(
      compare(temporaryPassword, recoveredActor.passwordHash),
    ).resolves.toBe(true);
    await expect(
      compare(
        "bootstrap-recovery-current-password",
        recoveredActor.passwordHash,
      ),
    ).resolves.toBe(false);
    expect(
      await prisma.userSession.count({
        where: {
          id: { in: fixture.sessions.map(({ id }) => id) },
          revokedAt: { not: null },
        },
      }),
    ).toBe(2);
    await expect(
      prisma.pairingCode.findUniqueOrThrow({ where: { id: fixture.grant.id } }),
    ).resolves.toMatchObject({ status: "REVOKED" });
    await expect(
      prisma.pairingAttempt.findUniqueOrThrow({
        where: { id: fixture.attempt.id },
      }),
    ).resolves.toMatchObject({ cancelledAt: expect.any(Date) });
    const audits = await prisma.auditEvent.findMany({
      where: {
        entityId: fixture.actor.id,
        action: "auth.bootstrap_password_recovery_issued",
      },
      orderBy: { organizationId: "asc" },
    });
    expect(audits).toHaveLength(2);
    expect(audits.map(({ organizationId }) => organizationId)).toEqual(
      fixture.organizations.map(({ id }) => id).sort(),
    );
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorUserId: null,
          actorType: "system",
          metadata: expect.objectContaining({
            source: "offline-operator-recovery",
            rotationWindowMinutes: 30,
          }),
        }),
      ]),
    );
  });

  it("rolls back every bootstrap recovery mutation when an audit cannot commit", async () => {
    const fixture = await createBootstrapRecoveryFixture(
      "bootstrap-recovery-rollback",
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "AuditEvent" ADD CONSTRAINT "integration_reject_bootstrap_recovery_audit" CHECK ("action" <> \'auth.bootstrap_password_recovery_issued\')',
    );
    try {
      await expect(
        recoverBootstrapPassword(prisma, {
          acknowledgement: BOOTSTRAP_RECOVERY_ACKNOWLEDGEMENT,
          email: fixture.actor.email,
          temporaryPassword: "bootstrap-recovery-rollback-temporary",
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" DROP CONSTRAINT "integration_reject_bootstrap_recovery_audit"',
      );
    }
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: fixture.actor.id } }),
    ).resolves.toMatchObject({
      passwordHash: fixture.actor.passwordHash,
      authenticationEpoch: 0,
      bootstrapPasswordExpiresAt: null,
    });
    await expect(
      prisma.userSession.findUniqueOrThrow({
        where: { id: fixture.sessions[0]!.id },
      }),
    ).resolves.toMatchObject({ revokedAt: null });
    await expect(
      prisma.pairingCode.findUniqueOrThrow({ where: { id: fixture.grant.id } }),
    ).resolves.toMatchObject({ status: "PENDING" });
    await expect(
      prisma.pairingAttempt.findUniqueOrThrow({
        where: { id: fixture.attempt.id },
      }),
    ).resolves.toMatchObject({ cancelledAt: null });
    expect(
      await prisma.auditEvent.count({
        where: {
          entityId: fixture.actor.id,
          action: "auth.bootstrap_password_recovery_issued",
        },
      }),
    ).toBe(0);
  });

  it("rejects a distinct temporary password with the same bcrypt input prefix", async () => {
    const bcryptPrefix = "x".repeat(72);
    const fixture = await createBootstrapRecoveryFixture(
      "bootstrap-recovery-reuse",
      `${bcryptPrefix}current-suffix`,
    );

    await expect(
      recoverBootstrapPassword(prisma, {
        acknowledgement: BOOTSTRAP_RECOVERY_ACKNOWLEDGEMENT,
        email: fixture.actor.email,
        temporaryPassword: bcryptPrefix,
      }),
    ).rejects.toThrow("must differ from the current password");
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: fixture.actor.id } }),
    ).resolves.toMatchObject({
      passwordHash: fixture.actor.passwordHash,
      authenticationEpoch: 0,
      bootstrapPasswordExpiresAt: null,
    });
    await expect(
      prisma.userSession.findUniqueOrThrow({
        where: { id: fixture.sessions[0]!.id },
      }),
    ).resolves.toMatchObject({ revokedAt: null });
    await expect(
      prisma.pairingCode.findUniqueOrThrow({ where: { id: fixture.grant.id } }),
    ).resolves.toMatchObject({ status: "PENDING" });
    expect(
      await prisma.auditEvent.count({
        where: { action: "auth.bootstrap_password_recovery_issued" },
      }),
    ).toBe(0);
  });

  it("allows exactly one concurrent bootstrap rotation", async () => {
    const organization = await createOrganization("bootstrap-rotation-race");
    const actor = await createMember(
      organization.id,
      "OWNER",
      "bootstrap-rotation-race",
    );
    const bootstrapPasswordExpiresAt = new Date(Date.now() + 30 * 60_000);
    await prisma.user.update({
      where: { id: actor.id },
      data: { bootstrapPasswordExpiresAt },
    });
    const issue = (tokenHash: string) =>
      store.createUserSessionAndAudit(
        organization.id,
        {
          tokenHash,
          expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
          expectedPasswordHash: actor.passwordHash,
          expectedRole: "OWNER",
          expectedAuthenticationEpoch: 0,
          expectedAuthorizationEpoch: 0,
          purpose: "BOOTSTRAP_PASSWORD_ROTATION",
          expectedBootstrapPasswordExpiresAt:
            bootstrapPasswordExpiresAt.toISOString(),
        },
        { actorUserId: actor.id },
      );
    const firstHash = "8".repeat(64);
    const secondHash = "9".repeat(64);
    await expect(
      Promise.all([issue(firstHash), issue(secondHash)]),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ created: true }),
        expect.objectContaining({ created: true }),
      ]),
    );
    const rotate = (tokenHash: string) =>
      store.rotateBootstrapPasswordAndAudit(
        actor.id,
        organization.id,
        {
          tokenHash,
          expectedPasswordHash: actor.passwordHash,
          expectedBootstrapPasswordExpiresAt:
            bootstrapPasswordExpiresAt.toISOString(),
          expectedAuthenticationEpoch: 0,
          expectedAuthorizationEpoch: 0,
          passwordHash: approvedPasswordHash,
        },
        { actorUserId: actor.id },
      );
    const results = await Promise.all([rotate(firstHash), rotate(secondHash)]);
    expect(results.filter((result) => result.rotated)).toHaveLength(1);
    expect(
      results.filter(
        (result) => !result.rotated && result.reason === "FORBIDDEN",
      ),
    ).toHaveLength(1);
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: actor.id } }),
    ).resolves.toMatchObject({
      passwordHash: approvedPasswordHash,
      bootstrapPasswordExpiresAt: null,
      authenticationEpoch: 1,
    });
    expect(
      await prisma.auditEvent.count({
        where: {
          actorUserId: actor.id,
          action: "auth.bootstrap_password_rotated",
        },
      }),
    ).toBe(1);
  });

  it("rolls back session creation and revocation when audit insertion fails", async () => {
    const organization = await createOrganization("session-audit-rollback");
    const actor = await createMember(
      organization.id,
      "ADMIN",
      "session-audit-rollback",
    );
    const existingHash = "d".repeat(64);
    await prisma.userSession.create({
      data: {
        organizationId: organization.id,
        userId: actor.id,
        tokenHash: existingHash,
        authenticationEpoch: 0,
        authorizationEpoch: 0,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "AuditEvent" ADD CONSTRAINT "integration_reject_session_audits" CHECK ("action" NOT IN (\'auth.login_succeeded\', \'auth.logout\'))',
    );
    const rejectedHash = "e".repeat(64);
    try {
      await expect(
        store.createUserSessionAndAudit(
          organization.id,
          {
            tokenHash: rejectedHash,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            expectedPasswordHash: actor.passwordHash,
            expectedRole: "ADMIN",
            expectedAuthenticationEpoch: 0,
            expectedAuthorizationEpoch: 0,
          },
          { actorUserId: actor.id },
        ),
      ).rejects.toThrow();
      await expect(
        store.revokeUserSessionAndAudit(
          actor.id,
          organization.id,
          existingHash,
          { actorUserId: actor.id },
        ),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" DROP CONSTRAINT "integration_reject_session_audits"',
      );
    }
    expect(
      await prisma.userSession.findUnique({
        where: { tokenHash: rejectedHash },
      }),
    ).toBeNull();
    await expect(
      prisma.userSession.findUniqueOrThrow({
        where: { tokenHash: existingHash },
      }),
    ).resolves.toMatchObject({ revokedAt: null });
  });

  it("rejects session issuance after credential or membership state changes", async () => {
    const organization = await createOrganization("session-revalidation");
    const actor = await createMember(
      organization.id,
      "OWNER",
      "session-revalidation",
    );
    const input = {
      tokenHash: "f".repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      expectedPasswordHash: actor.passwordHash,
      expectedRole: "OWNER" as const,
      expectedAuthenticationEpoch: 0,
      expectedAuthorizationEpoch: 0,
    };
    await prisma.membership.update({
      where: {
        organizationId_userId: {
          organizationId: organization.id,
          userId: actor.id,
        },
      },
      data: { role: "VIEWER" },
    });
    await expect(
      store.createUserSessionAndAudit(organization.id, input, {
        actorUserId: actor.id,
      }),
    ).resolves.toEqual({ created: false, reason: "FORBIDDEN" });

    await prisma.membership.update({
      where: {
        organizationId_userId: {
          organizationId: organization.id,
          userId: actor.id,
        },
      },
      data: { role: "OWNER" },
    });
    await prisma.user.update({
      where: { id: actor.id },
      data: { passwordHash: "changed-password-hash" },
    });
    await expect(
      store.createUserSessionAndAudit(organization.id, input, {
        actorUserId: actor.id,
      }),
    ).resolves.toEqual({ created: false, reason: "FORBIDDEN" });
    expect(
      await prisma.userSession.count({
        where: { organizationId: organization.id },
      }),
    ).toBe(0);
    expect(
      await prisma.auditEvent.count({
        where: { organizationId: organization.id },
      }),
    ).toBe(0);
  });

  it("keeps password and membership epoch revocation atomic across tenants", async () => {
    const [alpha, beta] = await Promise.all([
      createOrganization("identity-epoch-alpha"),
      createOrganization("identity-epoch-beta"),
    ]);
    const actor = await createUser(
      `identity-epoch-${randomUUID()}@example.test`,
    );
    await prisma.membership.createMany({
      data: [
        { organizationId: alpha.id, userId: actor.id, role: "OWNER" },
        { organizationId: beta.id, userId: actor.id, role: "VIEWER" },
      ],
    });
    await createMember(alpha.id, "OWNER", "identity-epoch-backup");
    const createSession = (
      organizationId: string,
      role: "OWNER" | "VIEWER",
      tokenHash: string,
      authenticationEpoch = 0,
      authorizationEpoch = 0,
    ) =>
      store.createUserSessionAndAudit(
        organizationId,
        {
          tokenHash,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          expectedPasswordHash: actor.passwordHash,
          expectedRole: role,
          expectedAuthenticationEpoch: authenticationEpoch,
          expectedAuthorizationEpoch: authorizationEpoch,
        },
        { actorUserId: actor.id },
      );
    const alphaHash = "1".repeat(64);
    const betaHash = "2".repeat(64);
    await expect(
      createSession(alpha.id, "OWNER", alphaHash),
    ).resolves.toMatchObject({
      created: true,
    });
    await expect(
      createSession(beta.id, "VIEWER", betaHash),
    ).resolves.toMatchObject({
      created: true,
    });

    await expect(
      store.rotateUserPasswordAndAudit(actor.id, approvedPasswordHash, {
        reason: "Integration password reset",
      }),
    ).resolves.toEqual({
      updated: true,
      affectedOrganizationIds: [alpha.id, beta.id].sort(),
    });
    await expect(
      store.findActiveUserSession(actor.id, alpha.id, alphaHash),
    ).resolves.toBeNull();
    await expect(
      store.findActiveUserSession(actor.id, beta.id, betaHash),
    ).resolves.toBeNull();
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: actor.id } }),
    ).resolves.toMatchObject({
      passwordHash: approvedPasswordHash,
      authenticationEpoch: 1,
    });
    expect(
      await prisma.auditEvent.count({
        where: { action: "identity.password_rotated" },
      }),
    ).toBe(2);

    const restoredHash = "3".repeat(64);
    await expect(
      store.createUserSessionAndAudit(
        alpha.id,
        {
          tokenHash: restoredHash,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          expectedPasswordHash: approvedPasswordHash,
          expectedRole: "OWNER",
          expectedAuthenticationEpoch: 1,
          expectedAuthorizationEpoch: 0,
        },
        { actorUserId: actor.id },
      ),
    ).resolves.toMatchObject({ created: true });
    await store.changeMembershipRoleAndAudit(alpha.id, actor.id, "VIEWER", {
      reason: "Integration demotion",
    });
    await store.changeMembershipRoleAndAudit(alpha.id, actor.id, "OWNER", {
      reason: "Integration role restore",
    });
    await expect(
      store.findActiveUserSession(actor.id, alpha.id, restoredHash),
    ).resolves.toBeNull();
    await expect(
      prisma.membership.findUniqueOrThrow({
        where: {
          organizationId_userId: {
            organizationId: alpha.id,
            userId: actor.id,
          },
        },
      }),
    ).resolves.toMatchObject({ role: "OWNER", authorizationEpoch: 2 });
    await expect(
      prisma.accessGrant.count({
        where: {
          organizationId: alpha.id,
          subjectUserId: actor.id,
          creatorKind: "SYSTEM",
          createdBySystemKey: "legacy-role-backfill-v1",
          scopeType: "ORGANIZATION",
          revokedAt: null,
        },
      }),
    ).resolves.toBe(13);
    await expect(
      prisma.accessGrant.count({
        where: {
          organizationId: alpha.id,
          subjectUserId: actor.id,
          creatorKind: "SYSTEM",
          createdBySystemKey: "legacy-role-backfill-v1",
          revokedAt: { not: null },
        },
      }),
    ).resolves.toBe(6);

    const betaAfterResetHash = "6".repeat(64);
    await expect(
      store.createUserSessionAndAudit(
        beta.id,
        {
          tokenHash: betaAfterResetHash,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          expectedPasswordHash: approvedPasswordHash,
          expectedRole: "VIEWER",
          expectedAuthenticationEpoch: 1,
          expectedAuthorizationEpoch: 0,
        },
        { actorUserId: actor.id },
      ),
    ).resolves.toMatchObject({ created: true });
    await expect(
      store.removeMembershipAndAudit(beta.id, actor.id, {
        reason: "Integration tenant removal",
      }),
    ).resolves.toEqual({ updated: true });
    await expect(
      prisma.membership.findUnique({
        where: {
          organizationId_userId: {
            organizationId: beta.id,
            userId: actor.id,
          },
        },
      }),
    ).resolves.toBeNull();
    await expect(
      prisma.userSession.findUnique({
        where: { tokenHash: betaAfterResetHash },
      }),
    ).resolves.toBeNull();

    await expect(
      store.disableUserAndAudit(actor.id, {
        reason: "Integration offboarding",
      }),
    ).resolves.toEqual({
      updated: true,
      affectedOrganizationIds: [alpha.id],
    });
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: actor.id } }),
    ).resolves.toMatchObject({ authenticationEpoch: 2 });
    await expect(
      store.findActiveUserSession(actor.id, alpha.id, restoredHash),
    ).resolves.toBeNull();
  });

  it("serializes competing owner removals and preserves one active owner", async () => {
    const organization = await createOrganization("owner-continuity-race");
    const [first, second] = await Promise.all([
      createMember(organization.id, "OWNER", "owner-continuity-first"),
      createMember(organization.id, "OWNER", "owner-continuity-second"),
      createMember(organization.id, "OWNER", "owner-continuity-disabled", true),
    ]);

    const results = await queueOwnerContinuityOperations(organization.id, [
      () =>
        store.changeMembershipRoleAndAudit(organization.id, first.id, "ADMIN", {
          reason: "Concurrent owner demotion",
        }),
      () =>
        store.removeMembershipAndAudit(organization.id, second.id, {
          reason: "Concurrent owner removal",
        }),
    ]);
    expect(results.filter((result) => result.updated)).toHaveLength(1);
    expect(results.filter((result) => !result.updated)).toEqual([
      { updated: false, reason: "OWNER_CONTINUITY_REQUIRED" },
    ]);

    const activeOwners = await prisma.membership.findMany({
      where: {
        organizationId: organization.id,
        role: "OWNER",
        user: { disabledAt: null },
      },
    });
    expect(activeOwners).toHaveLength(1);
    await expect(
      store.disableUserAndAudit(activeOwners[0]!.userId, {
        reason: "Would orphan tenant",
      }),
    ).resolves.toEqual({
      updated: false,
      reason: "OWNER_CONTINUITY_REQUIRED",
    });
    expect(
      await prisma.auditEvent.count({
        where: {
          organizationId: organization.id,
          action: {
            in: [
              "identity.membership_role_changed",
              "identity.membership_removed",
              "identity.user_disabled",
            ],
          },
        },
      }),
    ).toBe(1);
  });

  it("serializes owner promotion against removal without an ownerless result", async () => {
    const organization = await createOrganization("owner-promotion-race");
    const [owner, candidate] = await Promise.all([
      createMember(organization.id, "OWNER", "owner-promotion-current"),
      createMember(organization.id, "ADMIN", "owner-promotion-candidate"),
    ]);

    const handoff = await queueOwnerContinuityOperations(organization.id, [
      () =>
        store.changeMembershipRoleAndAudit(organization.id, owner.id, "ADMIN", {
          reason: "Concurrent ownership handoff",
        }),
      () =>
        store.changeMembershipRoleAndAudit(
          organization.id,
          candidate.id,
          "OWNER",
          { reason: "Concurrent ownership handoff" },
        ),
    ]);
    const demotion = handoff[0]!;
    const promotion = handoff[1]!;
    expect(promotion).toEqual({ updated: true });
    expect(
      demotion.updated || demotion.reason === "OWNER_CONTINUITY_REQUIRED",
    ).toBe(true);
    expect(
      await prisma.membership.count({
        where: {
          organizationId: organization.id,
          role: "OWNER",
          user: { disabledAt: null },
        },
      }),
    ).toBeGreaterThanOrEqual(1);
  });

  it("keeps session issue and logout audit FKs compatible with the tenant invariant lock", async () => {
    const organization = await createOrganization("owner-session-locks");
    const actor = await createMember(
      organization.id,
      "OWNER",
      "owner-session-locks",
    );
    await createMember(organization.id, "OWNER", "owner-session-locks-backup");
    const sessionInput = (tokenHash: string) => ({
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      expectedPasswordHash: actor.passwordHash,
      expectedRole: "OWNER" as const,
      expectedAuthenticationEpoch: 0,
      expectedAuthorizationEpoch: 0,
    });
    const existingHash = "7".repeat(64);
    await store.createUserSessionAndAudit(
      organization.id,
      sessionInput(existingHash),
      { actorUserId: actor.id },
    );

    const whileTenantLocked = async <T>(operation: () => Promise<T>) => {
      const acquired = deferred();
      const release = deferred();
      const holder = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT organization."id"
          FROM "Organization" organization
          WHERE organization."id" = ${organization.id}
          FOR NO KEY UPDATE OF organization`;
        acquired.resolve();
        await release.promise;
      });
      const holderSettled = holder.then(
        () => ({ succeeded: true as const }),
        (error: unknown) => {
          acquired.reject(error);
          return { succeeded: false as const, error };
        },
      );
      try {
        await acquired.promise;
      } catch (error) {
        release.resolve();
        await holderSettled;
        throw error;
      }
      const operationSettled = operation().then(
        (result) => ({ succeeded: true as const, result }),
        (error: unknown) => ({ succeeded: false as const, error }),
      );
      let timeout: NodeJS.Timeout | undefined;
      const raceResult = await Promise.race([
        operationSettled.then(() => ({ timedOut: false as const })),
        new Promise<{ timedOut: true }>((resolve) => {
          timeout = setTimeout(() => resolve({ timedOut: true }), 2_000);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      release.resolve();
      const [holderResult, operationResult] = await Promise.all([
        holderSettled,
        operationSettled,
      ]);
      if (!holderResult.succeeded) throw holderResult.error;
      if (raceResult.timedOut)
        throw new Error("session operation waited on tenant lock");
      if (!operationResult.succeeded) throw operationResult.error;
      return operationResult.result;
    };

    await expect(
      whileTenantLocked(() =>
        store.createUserSessionAndAudit(
          organization.id,
          sessionInput("8".repeat(64)),
          { actorUserId: actor.id },
        ),
      ),
    ).resolves.toMatchObject({ created: true });
    await expect(
      whileTenantLocked(() =>
        store.revokeUserSessionAndAudit(
          actor.id,
          organization.id,
          existingHash,
          { actorUserId: actor.id },
        ),
      ),
    ).resolves.toEqual({ revoked: true });
  });

  it("completes session races against demotion, removal, and multi-tenant disable", async () => {
    const createInput = (
      actor: { passwordHash: string },
      tokenHash: string,
    ) => ({
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      expectedPasswordHash: actor.passwordHash,
      expectedRole: "OWNER" as const,
      expectedAuthenticationEpoch: 0,
      expectedAuthorizationEpoch: 0,
    });

    const demotionOrganization = await createOrganization(
      "session-demotion-race",
    );
    const demoted = await createMember(
      demotionOrganization.id,
      "OWNER",
      "session-demotion-race",
    );
    await createMember(
      demotionOrganization.id,
      "OWNER",
      "session-demotion-race-backup",
    );
    const demotionHash = "9".repeat(64);
    const [issuance, demotion] = await Promise.all([
      store.createUserSessionAndAudit(
        demotionOrganization.id,
        createInput(demoted, demotionHash),
        { actorUserId: demoted.id },
      ),
      store.changeMembershipRoleAndAudit(
        demotionOrganization.id,
        demoted.id,
        "ADMIN",
        { reason: "Concurrent session demotion" },
      ),
    ]);
    expect(demotion).toEqual({ updated: true });
    expect(issuance.created === true || issuance.reason === "FORBIDDEN").toBe(
      true,
    );
    await expect(
      store.findActiveUserSession(
        demoted.id,
        demotionOrganization.id,
        demotionHash,
      ),
    ).resolves.toBeNull();

    const removalOrganization = await createOrganization("session-remove-race");
    const removed = await createMember(
      removalOrganization.id,
      "OWNER",
      "session-remove-race",
    );
    await createMember(
      removalOrganization.id,
      "OWNER",
      "session-remove-race-backup",
    );
    const removalHash = "a".repeat(64);
    await store.createUserSessionAndAudit(
      removalOrganization.id,
      createInput(removed, removalHash),
      { actorUserId: removed.id },
    );
    const [logout, removal] = await Promise.all([
      store.revokeUserSessionAndAudit(
        removed.id,
        removalOrganization.id,
        removalHash,
        { actorUserId: removed.id },
      ),
      store.removeMembershipAndAudit(removalOrganization.id, removed.id, {
        reason: "Concurrent session removal",
      }),
    ]);
    expect(removal).toEqual({ updated: true });
    expect(logout.revoked === true || logout.reason === "NOT_FOUND").toBe(true);

    const [disableAlpha, disableBeta] = await Promise.all([
      createOrganization("session-disable-race-alpha"),
      createOrganization("session-disable-race-beta"),
    ]);
    const disabled = await createUser(
      `session-disable-race-${randomUUID()}@example.test`,
    );
    await prisma.membership.createMany({
      data: [
        {
          organizationId: disableAlpha.id,
          userId: disabled.id,
          role: "OWNER",
        },
        {
          organizationId: disableBeta.id,
          userId: disabled.id,
          role: "OWNER",
        },
      ],
    });
    await Promise.all([
      createMember(
        disableAlpha.id,
        "OWNER",
        "session-disable-race-alpha-backup",
      ),
      createMember(disableBeta.id, "OWNER", "session-disable-race-beta-backup"),
    ]);
    const disableHash = "b".repeat(64);
    const [disableIssuance, disable] = await Promise.all([
      store.createUserSessionAndAudit(
        disableAlpha.id,
        createInput(disabled, disableHash),
        { actorUserId: disabled.id },
      ),
      store.disableUserAndAudit(disabled.id, {
        reason: "Concurrent multi-tenant disable",
      }),
    ]);
    expect(disable).toMatchObject({ updated: true });
    expect(
      disableIssuance.created === true ||
        disableIssuance.reason === "FORBIDDEN",
    ).toBe(true);
    await expect(
      store.findActiveUserSession(disabled.id, disableAlpha.id, disableHash),
    ).resolves.toBeNull();
  });

  it("rejects a multi-tenant disable atomically when any tenant would be orphaned", async () => {
    const [alpha, beta] = await Promise.all([
      createOrganization("owner-continuity-alpha"),
      createOrganization("owner-continuity-beta"),
    ]);
    const target = await createUser(
      `owner-continuity-target-${randomUUID()}@example.test`,
    );
    await prisma.membership.createMany({
      data: [
        { organizationId: alpha.id, userId: target.id, role: "OWNER" },
        { organizationId: beta.id, userId: target.id, role: "OWNER" },
      ],
    });
    await createMember(alpha.id, "OWNER", "owner-continuity-alpha-backup");

    await expect(
      store.disableUserAndAudit(target.id, {
        reason: "One tenant has no replacement",
      }),
    ).resolves.toEqual({
      updated: false,
      reason: "OWNER_CONTINUITY_REQUIRED",
    });
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: target.id } }),
    ).resolves.toMatchObject({ disabledAt: null, authenticationEpoch: 0 });
    expect(
      await prisma.auditEvent.count({
        where: {
          organizationId: { in: [alpha.id, beta.id] },
          action: "identity.user_disabled",
        },
      }),
    ).toBe(0);
  });

  it("orders concurrent multi-tenant disables without deadlock or orphaning", async () => {
    const [alpha, beta] = await Promise.all([
      createOrganization("owner-disable-race-alpha"),
      createOrganization("owner-disable-race-beta"),
    ]);
    const [first, second] = await Promise.all([
      createUser(`owner-disable-race-first-${randomUUID()}@example.test`),
      createUser(`owner-disable-race-second-${randomUUID()}@example.test`),
    ]);
    await prisma.membership.createMany({
      data: [first, second].flatMap((user) => [
        { organizationId: alpha.id, userId: user.id, role: "OWNER" as const },
        { organizationId: beta.id, userId: user.id, role: "OWNER" as const },
      ]),
    });

    const results = await queueOwnerContinuityOperations(
      [alpha.id, beta.id].sort()[0]!,
      [
        () =>
          store.disableUserAndAudit(first.id, {
            reason: "Concurrent disable",
          }),
        () =>
          store.disableUserAndAudit(second.id, {
            reason: "Concurrent disable",
          }),
      ],
    );
    expect(results.filter((result) => result.updated)).toHaveLength(1);
    expect(results.filter((result) => !result.updated)).toEqual([
      { updated: false, reason: "OWNER_CONTINUITY_REQUIRED" },
    ]);
    const remainingOwners = await prisma.membership.findMany({
      where: {
        organizationId: { in: [alpha.id, beta.id] },
        role: "OWNER",
        user: { disabledAt: null },
      },
      orderBy: { organizationId: "asc" },
    });
    expect(remainingOwners.map(({ organizationId }) => organizationId)).toEqual(
      [alpha.id, beta.id].sort(),
    );
    expect(new Set(remainingOwners.map(({ userId }) => userId))).toHaveLength(
      1,
    );
  });

  it("serializes session issuance against password reset without reviving a request", async () => {
    const organization = await createOrganization("identity-reset-race");
    const actor = await createMember(
      organization.id,
      "OWNER",
      "identity-reset-race",
    );
    const tokenHash = "4".repeat(64);

    const [issuance, reset] = await Promise.all([
      store.createUserSessionAndAudit(
        organization.id,
        {
          tokenHash,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          expectedPasswordHash: actor.passwordHash,
          expectedRole: "OWNER",
          expectedAuthenticationEpoch: 0,
          expectedAuthorizationEpoch: 0,
        },
        { actorUserId: actor.id },
      ),
      store.rotateUserPasswordAndAudit(actor.id, approvedPasswordHash, {
        reason: "Concurrent reset",
      }),
    ]);

    expect(reset).toMatchObject({ updated: true });
    expect(
      issuance.created === false ||
        (await prisma.userSession.findUnique({ where: { tokenHash } }))
          ?.revokedAt,
    ).toBeTruthy();
    await expect(
      store.findActiveUserSession(actor.id, organization.id, tokenHash),
    ).resolves.toBeNull();
  });

  it("rolls back identity epochs, credentials, and revocation when audit insertion fails", async () => {
    const organization = await createOrganization("identity-audit-rollback");
    const actor = await createMember(
      organization.id,
      "OWNER",
      "identity-audit-rollback",
    );
    await createMember(
      organization.id,
      "OWNER",
      "identity-audit-rollback-backup",
    );
    const tokenHash = "5".repeat(64);
    await prisma.userSession.create({
      data: {
        organizationId: organization.id,
        userId: actor.id,
        tokenHash,
        authenticationEpoch: 0,
        authorizationEpoch: 0,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "AuditEvent" ADD CONSTRAINT "integration_reject_identity_audits" CHECK ("action" NOT LIKE \'identity.%\')',
    );
    try {
      await expect(
        store.rotateUserPasswordAndAudit(actor.id, approvedPasswordHash, {
          reason: "Rejected audit",
        }),
      ).rejects.toThrow();
      await expect(
        store.changeMembershipRoleAndAudit(organization.id, actor.id, "ADMIN", {
          reason: "Rejected role audit",
        }),
      ).rejects.toThrow();
      await expect(
        store.disableUserAndAudit(actor.id, {
          reason: "Rejected disable audit",
        }),
      ).rejects.toThrow();
      await expect(
        store.removeMembershipAndAudit(organization.id, actor.id, {
          reason: "Rejected removal audit",
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" DROP CONSTRAINT "integration_reject_identity_audits"',
      );
    }
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: actor.id } }),
    ).resolves.toMatchObject({
      passwordHash: actor.passwordHash,
      authenticationEpoch: 0,
      disabledAt: null,
    });
    await expect(
      prisma.userSession.findUniqueOrThrow({ where: { tokenHash } }),
    ).resolves.toMatchObject({ revokedAt: null });
    await expect(
      prisma.membership.findUniqueOrThrow({
        where: {
          organizationId_userId: {
            organizationId: organization.id,
            userId: actor.id,
          },
        },
      }),
    ).resolves.toMatchObject({ role: "OWNER", authorizationEpoch: 0 });
  });

  it("removes a release creator while retaining tenant-scoped, digest-valid provenance", async () => {
    const organization = await createOrganization("creator-removal");
    const actor = await createMember(
      organization.id,
      "PUBLISHER",
      "creator-removal",
    );
    await createMember(organization.id, "OWNER", "creator-removal-owner");
    const membership = await prisma.membership.findUniqueOrThrow({
      where: {
        organizationId_userId: {
          organizationId: organization.id,
          userId: actor.id,
        },
      },
    });
    const { publication, screen } = await createPublicationFixture(
      organization.id,
      actor.id,
      "creator-removal",
    );
    const tokenHash = "6".repeat(64);
    await prisma.userSession.create({
      data: {
        organizationId: organization.id,
        userId: actor.id,
        tokenHash,
        authenticationEpoch: 0,
        authorizationEpoch: 0,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const grant = await prisma.pairingCode.create({
      data: {
        id: "g".repeat(43),
        organizationId: organization.id,
        purpose: "NEW_SCREEN",
        targetScreenId: screen.id,
        targetScreenReferenceId: screen.id,
        targetOrganizationId: organization.id,
        expectedGeneration: 0,
        authorizedByUserId: actor.id,
        authorizedByMembershipId: membership.id,
        authorizedByAuthenticationEpoch: 0,
        authorizedByAuthorizationEpoch: 0,
        requestReason: "Creator removal regression",
        codeHash: "7".repeat(64),
        status: "PENDING",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const attempt = await prisma.pairingAttempt.create({
      data: {
        id: "h".repeat(43),
        organizationId: organization.id,
        pairingCodeId: grant.id,
        keyId: "i".repeat(43),
        publicKeySpki: Buffer.alloc(91, 1),
        algorithm: "ES256",
        securityLevel: "software",
        challengeHashSha256: "8".repeat(64),
        transcriptDigestSha256: "9".repeat(64),
        expiresAt: new Date(Date.now() + 30_000),
      },
    });

    await prisma.$executeRawUnsafe(
      'ALTER TABLE "AuditEvent" ADD CONSTRAINT "integration_reject_creator_removal_audit" CHECK ("action" <> \'identity.membership_removed\')',
    );
    try {
      await expect(
        store.removeMembershipAndAudit(organization.id, actor.id, {
          reason: "Rejected creator removal",
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" DROP CONSTRAINT "integration_reject_creator_removal_audit"',
      );
    }
    await expect(
      prisma.membership.findUnique({
        where: {
          organizationId_userId: {
            organizationId: organization.id,
            userId: actor.id,
          },
        },
      }),
    ).resolves.not.toBeNull();
    await expect(
      prisma.userSession.findUnique({ where: { tokenHash } }),
    ).resolves.not.toBeNull();
    await expect(
      prisma.pairingCode.findUniqueOrThrow({ where: { id: grant.id } }),
    ).resolves.toMatchObject({ status: "PENDING" });
    await expect(
      prisma.pairingAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
    ).resolves.toMatchObject({ cancelledAt: null });

    await expect(
      store.removeMembershipAndAudit(organization.id, actor.id, {
        reason: "Creator left the tenant",
        requestId: "creator-removal-request",
      }),
    ).resolves.toEqual({ updated: true });

    await expect(
      prisma.membership.findUnique({
        where: {
          organizationId_userId: {
            organizationId: organization.id,
            userId: actor.id,
          },
        },
      }),
    ).resolves.toBeNull();
    await expect(
      prisma.userSession.findUnique({ where: { tokenHash } }),
    ).resolves.toBeNull();
    await expect(
      prisma.pairingCode.findUniqueOrThrow({ where: { id: grant.id } }),
    ).resolves.toMatchObject({ status: "REVOKED" });
    await expect(
      prisma.pairingAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
    ).resolves.toEqual(
      expect.objectContaining({ cancelledAt: expect.any(Date) }),
    );
    await expect(
      prisma.membershipAttribution.findUnique({
        where: {
          organizationId_userId: {
            organizationId: organization.id,
            userId: actor.id,
          },
        },
      }),
    ).resolves.toMatchObject({
      organizationId: organization.id,
      userId: actor.id,
    });
    const retainedRelease = await prisma.publishedRelease.findUniqueOrThrow({
      where: { id: publication.release.id },
      include: { items: { orderBy: { position: "asc" } } },
    });
    const retainedAssignment = await prisma.releaseAssignment.findUniqueOrThrow(
      {
        where: { id: publication.assignment.id },
        include: { targets: true },
      },
    );
    expect(retainedRelease.createdById).toBe(actor.id);
    expect(retainedAssignment.createdById).toBe(actor.id);
    const active = await store.activeOrdinaryReleases(
      organization.id,
      screen.id,
      new Date().toISOString(),
    );
    expect(active).toHaveLength(1);
    expect(hasValidStoredReleaseDigest(active[0]!.release)).toBe(true);
    expect(
      hasValidStoredAssignmentDigest(active[0]!.assignment, active[0]!.release),
    ).toBe(true);
    expect(
      await prisma.auditEvent.count({
        where: {
          organizationId: organization.id,
          action: "identity.membership_removed",
          entityId: membership.id,
          requestId: "creator-removal-request",
        },
      }),
    ).toBe(1);
    const attributionBeforeRejoin =
      await prisma.membershipAttribution.findUniqueOrThrow({
        where: {
          organizationId_userId: {
            organizationId: organization.id,
            userId: actor.id,
          },
        },
      });
    await expect(
      prisma.membershipAttribution.update({
        where: {
          organizationId_userId: {
            organizationId: organization.id,
            userId: actor.id,
          },
        },
        data: { recordedAt: new Date() },
      }),
    ).rejects.toBeDefined();
    const recreatedMembership = await prisma.membership.create({
      data: {
        organizationId: organization.id,
        userId: actor.id,
        role: "VIEWER",
      },
    });
    await expect(
      prisma.membershipAttribution.findUniqueOrThrow({
        where: {
          organizationId_userId: {
            organizationId: organization.id,
            userId: actor.id,
          },
        },
      }),
    ).resolves.toMatchObject({
      recordedAt: attributionBeforeRejoin.recordedAt,
    });
    await prisma.membership.delete({ where: { id: recreatedMembership.id } });

    const cascadeOrganization = await createOrganization(
      "attribution-organization-cascade",
    );
    const cascadeActor = await createMember(
      cascadeOrganization.id,
      "OWNER",
      "attribution-organization-cascade",
    );
    await prisma.membership.delete({
      where: {
        organizationId_userId: {
          organizationId: cascadeOrganization.id,
          userId: cascadeActor.id,
        },
      },
    });
    await expect(
      prisma.membershipAttribution.findUnique({
        where: {
          organizationId_userId: {
            organizationId: cascadeOrganization.id,
            userId: cascadeActor.id,
          },
        },
      }),
    ).resolves.not.toBeNull();
    await prisma.organization.delete({
      where: { id: cascadeOrganization.id },
    });
    await expect(
      prisma.membershipAttribution.findUnique({
        where: {
          organizationId_userId: {
            organizationId: cascadeOrganization.id,
            userId: cascadeActor.id,
          },
        },
      }),
    ).resolves.toBeNull();
  });

  it("serializes publication against creator membership removal", async () => {
    const runScenario = async (
      label: string,
      order: "REMOVAL_FIRST" | "PUBLICATION_FIRST",
    ) => {
      const organization = await createOrganization(label);
      const actor = await createMember(organization.id, "PUBLISHER", label);
      const approver = await createMember(
        organization.id,
        "OWNER",
        `${label}-owner`,
      );
      const screen = await store.createScreen(organization.id, {
        name: `${label} screen`,
        location: "",
        orientation: "landscape",
        resolution: "1920x1080",
        tags: [],
      });
      const media = await store.createMedia(organization.id, {
        name: `${label} asset`,
        kind: "image",
        mimeType: "image/png",
        url: `https://media.example.test/${label}.png`,
        checksumSha256: "a".repeat(64),
        sizeBytes: 100,
      });
      const playlist = await store.createPlaylist(organization.id, {
        name: `${label} playlist`,
        description: "",
        items: [
          {
            id: "ignored",
            assetId: media.id,
            position: 0,
            durationSeconds: 10,
          },
        ],
      });
      const created = await store.createReleaseCandidateAndAudit(
        organization.id,
        {
          playlistId: playlist.id,
          name: `${label} schedule`,
          priority: "normal",
          startsAt: new Date(Date.now() - 60_000).toISOString(),
          timezone: "UTC",
          daysOfWeek: [],
          enabled: true,
          screenIds: [screen.id],
          expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        },
        { actorUserId: actor.id },
        { mediaAllowedOrigins: ["https://media.example.test"] },
        publicationIdempotency(),
      );
      if (!created.completed) throw new Error(created.reason);
      const submitted = await store.submitReleaseCandidateAndAudit(
        organization.id,
        created.candidate.id,
        created.candidate.digestSha256,
        { actorUserId: actor.id },
        publicationIdempotency(),
      );
      if (!submitted.completed) throw new Error(submitted.reason);
      const approved = await store.approveReleaseCandidateAndAudit(
        organization.id,
        created.candidate.id,
        created.candidate.digestSha256,
        { actorUserId: approver.id },
        publicationIdempotency(),
      );
      if (!approved.completed) throw new Error(approved.reason);
      const publish = async () => {
        const result = await store.publishReleaseCandidateAndAudit(
          organization.id,
          created.candidate.id,
          created.candidate.digestSha256,
          { actorUserId: actor.id },
          { mediaAllowedOrigins: ["https://media.example.test"] },
          publicationIdempotency(),
        );
        return result.completed
          ? { published: true as const }
          : { published: false as const, reason: result.reason };
      };
      const remove = () =>
        store.removeMembershipAndAudit(organization.id, actor.id, {
          reason: `Concurrent creator removal ${order}`,
        });
      const publicationOperation = {
        waitFor: 'actor."authenticationEpoch" AS "authenticationEpoch"',
        run: publish,
      };
      const removalOperation = {
        waitFor: 'FROM "Membership" membership',
        run: remove,
      };
      const results = await queueMembershipRowOperations(
        organization.id,
        actor.id,
        order === "REMOVAL_FIRST"
          ? [removalOperation, publicationOperation]
          : [publicationOperation, removalOperation],
      );
      await expect(
        prisma.membership.findUnique({
          where: {
            organizationId_userId: {
              organizationId: organization.id,
              userId: actor.id,
            },
          },
        }),
      ).resolves.toBeNull();
      return { actor, organization, results };
    };

    const removalFirst = await runScenario(
      "creator-removal-race-removal-first",
      "REMOVAL_FIRST",
    );
    expect(removalFirst.results).toEqual([
      { updated: true },
      { published: false, reason: "FORBIDDEN" },
    ]);
    expect(
      await prisma.publishedRelease.count({
        where: { organizationId: removalFirst.organization.id },
      }),
    ).toBe(1);
    await expect(
      prisma.releaseCandidate.findFirstOrThrow({
        where: { organizationId: removalFirst.organization.id },
      }),
    ).resolves.toMatchObject({ state: "APPROVED" });
    await expect(
      Promise.all([
        prisma.schedule.count({
          where: { organizationId: removalFirst.organization.id },
        }),
        prisma.releaseAssignment.count({
          where: { organizationId: removalFirst.organization.id },
        }),
        prisma.releaseCandidatePublication.count({
          where: { organizationId: removalFirst.organization.id },
        }),
        prisma.auditEvent.count({
          where: {
            organizationId: removalFirst.organization.id,
            action: {
              in: ["release.candidate.published", "release.published"],
            },
          },
        }),
      ]),
    ).resolves.toEqual([0, 0, 0, 0]);

    const publicationFirst = await runScenario(
      "creator-removal-race-publication-first",
      "PUBLICATION_FIRST",
    );
    expect(publicationFirst.results[0]).toMatchObject({ published: true });
    expect(publicationFirst.results[1]).toEqual({ updated: true });
    await expect(
      prisma.publishedRelease.findFirstOrThrow({
        where: { organizationId: publicationFirst.organization.id },
      }),
    ).resolves.toMatchObject({ createdById: publicationFirst.actor.id });
  });

  it("rechecks release capabilities from locked current memberships before writes", async () => {
    const [organization, otherOrganization] = await Promise.all([
      createOrganization("release-capabilities"),
      createOrganization("release-capabilities-other"),
    ]);
    const [actor, missingActor, crossOrgActor, deletedActor, disabledActor] =
      await Promise.all([
        createUser("release-viewer@example.test"),
        createUser("release-missing@example.test"),
        createUser("release-cross-org@example.test"),
        createUser("release-deleted@example.test"),
        createUser("release-disabled@example.test"),
      ]);
    await prisma.membership.createMany({
      data: [
        {
          organizationId: organization.id,
          userId: actor.id,
          role: "VIEWER",
        },
        {
          organizationId: otherOrganization.id,
          userId: crossOrgActor.id,
          role: "PUBLISHER",
        },
        {
          organizationId: organization.id,
          userId: deletedActor.id,
          role: "PUBLISHER",
        },
        {
          organizationId: organization.id,
          userId: disabledActor.id,
          role: "PUBLISHER",
        },
      ],
    });
    await prisma.user.update({
      where: { id: disabledActor.id },
      data: { disabledAt: new Date() },
    });
    await prisma.membership.delete({
      where: {
        organizationId_userId: {
          organizationId: organization.id,
          userId: deletedActor.id,
        },
      },
    });
    const screen = await store.createScreen(organization.id, {
      name: "Capability screen",
      location: "",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const media = await store.createMedia(organization.id, {
      name: "Capability media",
      kind: "image",
      mimeType: "image/png",
      url: "https://media.example.test/capability.png",
      checksumSha256: "c".repeat(64),
      sizeBytes: 100,
    });
    const playlist = await store.createPlaylist(organization.id, {
      name: "Capability playlist",
      description: "",
      items: [
        {
          id: "ignored",
          assetId: media.id,
          position: 0,
          durationSeconds: 10,
        },
      ],
    });
    const input = {
      playlistId: playlist.id,
      name: "Capability schedule",
      priority: "normal" as const,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      timezone: "UTC",
      daysOfWeek: [],
      enabled: true,
      screenIds: [screen.id],
    };
    const policy = { mediaAllowedOrigins: ["https://media.example.test"] };

    for (const actorUserId of [
      actor.id,
      missingActor.id,
      crossOrgActor.id,
      deletedActor.id,
      disabledActor.id,
    ]) {
      await expect(
        publishApprovedSchedule(
          organization.id,
          input,
          { actorUserId },
          policy,
          publicationIdempotency(),
        ),
      ).resolves.toEqual({ published: false, reason: "FORBIDDEN" });
    }
    expect(await prisma.publishedRelease.count()).toBe(0);
    expect(await prisma.schedule.count()).toBe(0);
    expect(await prisma.releaseAssignment.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);

    await prisma.membership.update({
      where: {
        organizationId_userId: {
          organizationId: organization.id,
          userId: actor.id,
        },
      },
      data: { role: "PUBLISHER" },
    });
    const publication = await publishApprovedSchedule(
      organization.id,
      input,
      { actorUserId: actor.id },
      policy,
      publicationIdempotency(),
    );
    if (!publication.published) throw new Error("authorized publish failed");

    await prisma.membership.update({
      where: {
        organizationId_userId: {
          organizationId: organization.id,
          userId: actor.id,
        },
      },
      data: { role: "VIEWER" },
    });
    for (const actorUserId of [
      actor.id,
      missingActor.id,
      crossOrgActor.id,
      deletedActor.id,
      disabledActor.id,
    ]) {
      await expect(
        store.withdrawScheduleAndAudit(
          organization.id,
          publication.schedule.id,
          { actorUserId },
        ),
      ).resolves.toEqual({ withdrawn: false, reason: "FORBIDDEN" });
    }
    expect(await prisma.releaseAssignment.count()).toBe(1);
    expect(await prisma.auditEvent.count()).toBe(5);

    await prisma.membership.update({
      where: {
        organizationId_userId: {
          organizationId: organization.id,
          userId: actor.id,
        },
      },
      data: { role: "ADMIN" },
    });
    await expect(
      store.withdrawScheduleAndAudit(organization.id, publication.schedule.id, {
        actorUserId: actor.id,
      }),
    ).resolves.toMatchObject({ withdrawn: true });
    expect(await prisma.releaseAssignment.count()).toBe(2);
    expect(await prisma.auditEvent.count()).toBe(6);
  });

  it("freezes published content and schedule selection, then preserves history after withdrawal", async () => {
    const organization = await createOrganization("immutable-release");
    const actor = await createUser("release-owner@example.test");
    await prisma.membership.create({
      data: {
        organizationId: organization.id,
        userId: actor.id,
        role: "OWNER",
      },
    });
    const screen = await store.createScreen(organization.id, {
      name: "Release screen",
      location: "Lobby",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const media = await store.createMedia(organization.id, {
      name: "Frozen image",
      kind: "image",
      mimeType: "image/png",
      url: "https://media.example.test/frozen.png",
      checksumSha256: "f".repeat(64),
      sizeBytes: 4_096,
    });
    const playlist = await store.createPlaylist(organization.id, {
      name: "Frozen playlist",
      description: "Original description",
      items: [
        {
          id: "ignored-by-create",
          assetId: media.id,
          position: 0,
          durationSeconds: 30,
        },
      ],
    });
    const now = new Date();
    const publicationInput = {
      playlistId: playlist.id,
      name: "Frozen schedule",
      priority: "normal" as const,
      startsAt: new Date(now.getTime() - 60_000).toISOString(),
      timezone: "UTC",
      daysOfWeek: [],
      enabled: true,
      screenIds: [screen.id],
    };
    const publication = await publishApprovedSchedule(
      organization.id,
      publicationInput,
      {
        actorUserId: actor.id,
        requestId: "publish-integration",
      },
      { mediaAllowedOrigins: ["https://media.example.test"] },
      publicationIdempotency(),
    );
    expect(publication.published).toBe(true);
    if (!publication.published)
      throw new Error("publication unexpectedly failed");
    expect(await prisma.schedule.count()).toBe(1);
    expect(await prisma.publishedRelease.count()).toBe(1);
    expect(await prisma.releaseAssignment.count()).toBe(1);
    expect(await prisma.idempotencyRecord.count()).toBe(4);
    expect(
      await prisma.auditEvent.count({
        where: { organizationId: organization.id, action: "release.published" },
      }),
    ).toBe(1);

    await prisma.playlist.update({
      where: { id: playlist.id },
      data: { name: "Mutated draft", description: "Changed" },
    });
    await prisma.playlistItem.updateMany({
      where: { playlistId: playlist.id },
      data: { durationSeconds: 5 },
    });
    await prisma.mediaAsset.update({
      where: { id: media.id },
      data: {
        name: "Mutated asset",
        url: "https://media.example.test/mutated.png",
        checksumSha256: "0".repeat(64),
      },
    });
    await prisma.schedule.update({
      where: { id: publication.schedule.id },
      data: { enabled: false, startsAt: new Date(now.getTime() + 86_400_000) },
    });

    const active = await store.activeOrdinaryReleases(
      organization.id,
      screen.id,
      now.toISOString(),
    );
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      release: {
        id: publication.release.id,
        playlistName: "Frozen playlist",
        playlistDescription: "Original description",
        digestSha256: publication.release.digestSha256,
        items: [
          {
            asset: {
              id: media.id,
              name: "Frozen image",
              url: "https://media.example.test/frozen.png",
              checksumSha256: "f".repeat(64),
            },
            durationSeconds: 30,
          },
        ],
      },
      assignment: {
        id: publication.assignment.id,
        state: "ASSIGNED",
        schedule: { name: "Frozen schedule", enabled: true },
      },
    });
    const frozenAsset = active[0]!.release.items[0]!.asset;
    const deliveryAuthorization = {
      organizationId: organization.id,
      screenId: screen.id,
      assignmentId: publication.assignment.id,
      assignmentDigestSha256: publication.assignment.digestSha256,
      assetId: frozenAsset.id,
      storageKey: frozenAsset.storageKey!,
      checksumSha256: frozenAsset.checksumSha256,
      sizeBytes: frozenAsset.sizeBytes,
      at: now.toISOString(),
    };
    await expect(
      store.authorizeMediaDelivery(deliveryAuthorization),
    ).resolves.toBe(true);
    await expect(
      store.authorizeMediaDelivery({
        ...deliveryAuthorization,
        screenId: "another-screen",
      }),
    ).resolves.toBe(false);
    await expect(
      store.authorizeMediaDelivery({
        ...deliveryAuthorization,
        assignmentDigestSha256: "0".repeat(64),
      }),
    ).resolves.toBe(false);
    await expect(
      store.authorizeMediaDelivery({
        ...deliveryAuthorization,
        organizationId: "another-organization",
      }),
    ).resolves.toBe(false);

    const auditCountBeforeIntegrityChecks = await prisma.auditEvent.count();
    const expectSnapshotRejected = async () => {
      await expect(
        store.activeOrdinaryReleases(
          organization.id,
          screen.id,
          now.toISOString(),
        ),
      ).resolves.toEqual([]);
      await expect(
        store.authorizeMediaDelivery(deliveryAuthorization),
      ).resolves.toBe(false);
      await expect(prisma.auditEvent.count()).resolves.toBe(
        auditCountBeforeIntegrityChecks,
      );
    };

    await prisma.publishedRelease.update({
      where: { id: publication.release.id },
      data: { sourcePlaylistName: "Drifted frozen metadata" },
    });
    await expectSnapshotRejected();
    await prisma.publishedRelease.update({
      where: { id: publication.release.id },
      data: { sourcePlaylistName: publication.release.playlistName },
    });

    const frozenItem = await prisma.frozenReleaseItem.findFirstOrThrow({
      where: { releaseId: publication.release.id },
    });
    await prisma.frozenReleaseItem.update({
      where: { id: frozenItem.id },
      data: { position: frozenItem.position + 1 },
    });
    await expectSnapshotRejected();
    await prisma.frozenReleaseItem.update({
      where: { id: frozenItem.id },
      data: { position: frozenItem.position },
    });
    await prisma.frozenReleaseItem.update({
      where: { id: frozenItem.id },
      data: { assetName: "Drifted frozen asset" },
    });
    await expectSnapshotRejected();
    await prisma.frozenReleaseItem.update({
      where: { id: frozenItem.id },
      data: { assetName: frozenItem.assetName },
    });

    await prisma.publishedRelease.update({
      where: { id: publication.release.id },
      data: { digestSha256: "0".repeat(64) },
    });
    await expectSnapshotRejected();
    await prisma.publishedRelease.update({
      where: { id: publication.release.id },
      data: { digestSha256: publication.release.digestSha256 },
    });

    for (const data of [
      { scheduleName: "Drifted frozen schedule" },
      { digestSha256: "1".repeat(64) },
    ]) {
      await expectPrismaTriggerRejected(
        prisma.releaseAssignment.update({
          where: { id: publication.assignment.id },
          data,
        }),
        "Release assignment snapshot is immutable",
      );
    }

    const driftTarget = await store.createScreen(organization.id, {
      name: "Unexpected frozen target",
      location: "",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    await expectPrismaTriggerRejected(
      prisma.releaseAssignmentTarget.create({
        data: {
          organizationId: organization.id,
          assignmentId: publication.assignment.id,
          screenId: driftTarget.id,
          liveScreenId: driftTarget.id,
          liveScreenOrganizationId: organization.id,
        },
      }),
      "Release assignment targets may only be attached during assignment creation",
    );

    await expect(
      store.activeOrdinaryReleases(
        organization.id,
        screen.id,
        now.toISOString(),
      ),
    ).resolves.toHaveLength(1);
    await expect(
      store.authorizeMediaDelivery(deliveryAuthorization),
    ).resolves.toBe(true);
    await expect(
      store.deletePlaylist(organization.id, playlist.id),
    ).resolves.toBe("IN_USE");
    await expect(store.deleteMedia(organization.id, media.id)).resolves.toBe(
      "IN_USE",
    );
    await expect(
      store.deletePlaylistAndAudit(organization.id, playlist.id, {
        actorUserId: actor.id,
      }),
    ).resolves.toEqual({ deleted: false, reason: "IN_USE" });
    await expect(
      store.deleteMediaAndAudit(organization.id, media.id, {
        actorUserId: actor.id,
      }),
    ).resolves.toEqual({ deleted: false, reason: "IN_USE" });

    await expect(
      prisma.screen.delete({ where: { id: screen.id } }),
    ).resolves.toMatchObject({ id: screen.id });

    // Deleting a target clears the frozen live binding. The immutable history
    // remains withdrawable by id, but it must no longer cross the delivery or
    // management-list integrity boundary as an active schedule.
    await expect(store.listSchedules(organization.id)).resolves.toEqual([]);
    const otherOrganization = await createOrganization(
      "withdrawal-list-isolation",
    );
    const otherPlaylist = await store.createPlaylist(otherOrganization.id, {
      name: "Other tenant draft",
      description: "",
      items: [],
    });
    const otherSchedule = await store.createSchedule(otherOrganization.id, {
      playlistId: otherPlaylist.id,
      name: "Other tenant schedule",
      priority: "normal",
      startsAt: new Date().toISOString(),
      timezone: "UTC",
      daysOfWeek: [],
      enabled: true,
      screenIds: [],
    });
    const [withdrawal, concurrentOtherSchedules] = await Promise.all([
      store.withdrawScheduleAndAudit(organization.id, publication.schedule.id, {
        actorUserId: actor.id,
        requestId: "withdraw-integration",
      }),
      store.listSchedules(otherOrganization.id),
    ]);
    expect(concurrentOtherSchedules).toEqual([
      expect.objectContaining({ id: otherSchedule.id }),
    ]);
    expect(withdrawal).toMatchObject({
      withdrawn: true,
      assignment: {
        state: "WITHDRAWN",
        previousAssignmentId: publication.assignment.id,
        releaseId: publication.release.id,
        screenIds: [screen.id],
      },
    });
    if (!withdrawal.withdrawn) throw new Error(withdrawal.reason);
    expect(
      hasValidStoredAssignmentDigest(
        withdrawal.assignment,
        publication.release,
      ),
    ).toBe(true);
    await expect(store.listSchedules(organization.id)).resolves.toEqual([]);
    await expect(
      store.authorizeMediaDelivery(deliveryAuthorization),
    ).resolves.toBe(false);
    await expect(
      store.activeOrdinaryReleases(
        organization.id,
        screen.id,
        now.toISOString(),
      ),
    ).resolves.toEqual([]);
    expect(
      await prisma.publishedRelease.count({
        where: { id: publication.release.id },
      }),
    ).toBe(1);
    await expect(
      store.deletePlaylistAndAudit(organization.id, playlist.id, {
        actorUserId: actor.id,
      }),
    ).resolves.toEqual({ deleted: false, reason: "IN_USE" });
    await expect(
      store.deleteMediaAndAudit(organization.id, media.id, {
        actorUserId: actor.id,
      }),
    ).resolves.toEqual({ deleted: false, reason: "IN_USE" });
    expect(
      await prisma.auditEvent.count({
        where: {
          organizationId: organization.id,
          action: { in: ["media.deleted", "playlist.deleted"] },
        },
      }),
    ).toBe(0);
    expect(
      await prisma.releaseAssignment.count({
        where: { scheduleId: publication.schedule.id },
      }),
    ).toBe(2);

    const retainedTargets = await prisma.releaseAssignmentTarget.findMany({
      where: { assignment: { scheduleId: publication.schedule.id } },
      orderBy: { assignment: { createdAt: "asc" } },
    });
    expect(retainedTargets).toHaveLength(2);
    expect(retainedTargets).toEqual(
      retainedTargets.map(() =>
        expect.objectContaining({
          organizationId: organization.id,
          screenId: screen.id,
          liveScreenId: null,
          liveScreenOrganizationId: null,
        }),
      ),
    );
    expect(
      await prisma.auditEvent.count({
        where: {
          organizationId: organization.id,
          action: { in: ["release.published", "release.withdrawn"] },
        },
      }),
    ).toBe(2);
  });

  it("rejects cross-tenant release sources, targets, frozen assets, and actors", async () => {
    const [alpha, beta] = await Promise.all([
      createOrganization("release-alpha"),
      createOrganization("release-beta"),
    ]);
    const actor = await createUser("release-alpha@example.test");
    const betaActor = await createUser("release-beta@example.test");
    await prisma.membership.create({
      data: { organizationId: alpha.id, userId: actor.id, role: "OWNER" },
    });
    await prisma.membership.create({
      data: {
        organizationId: beta.id,
        userId: betaActor.id,
        role: "OWNER",
      },
    });
    const [alphaScreen, betaScreen] = await Promise.all([
      store.createScreen(alpha.id, {
        name: "Alpha release screen",
        location: "",
        orientation: "landscape",
        resolution: "1920x1080",
        tags: [],
      }),
      store.createScreen(beta.id, {
        name: "Beta release screen",
        location: "",
        orientation: "landscape",
        resolution: "1920x1080",
        tags: [],
      }),
    ]);
    const [alphaMedia, betaMedia] = await Promise.all([
      store.createMedia(alpha.id, {
        name: "Alpha release asset",
        kind: "image",
        mimeType: "image/png",
        url: "https://media.example.test/release-alpha.png",
        checksumSha256: "1".repeat(64),
        sizeBytes: 100,
      }),
      store.createMedia(beta.id, {
        name: "Beta release asset",
        kind: "image",
        mimeType: "image/png",
        url: "https://media.example.test/release-beta.png",
        checksumSha256: "2".repeat(64),
        sizeBytes: 100,
      }),
    ]);
    const [alphaPlaylist, betaPlaylist] = await Promise.all([
      store.createPlaylist(alpha.id, {
        name: "Alpha release playlist",
        description: "",
        items: [
          {
            id: "ignored-alpha",
            assetId: alphaMedia.id,
            position: 0,
            durationSeconds: 10,
          },
        ],
      }),
      store.createPlaylist(beta.id, {
        name: "Beta release playlist",
        description: "",
        items: [
          {
            id: "ignored-beta",
            assetId: betaMedia.id,
            position: 0,
            durationSeconds: 10,
          },
        ],
      }),
    ]);
    const input = {
      playlistId: alphaPlaylist.id,
      name: "Tenant publication",
      priority: "normal" as const,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      timezone: "UTC",
      daysOfWeek: [],
      enabled: true,
      screenIds: [alphaScreen.id],
    };

    await expect(
      publishApprovedSchedule(
        alpha.id,
        { ...input, playlistId: betaPlaylist.id },
        { actorUserId: actor.id },
        { mediaAllowedOrigins: ["https://media.example.test"] },
        publicationIdempotency(),
      ),
    ).resolves.toEqual({ published: false, reason: "PLAYLIST_NOT_FOUND" });
    await expect(
      publishApprovedSchedule(
        alpha.id,
        { ...input, screenIds: [betaScreen.id] },
        { actorUserId: actor.id },
        { mediaAllowedOrigins: ["https://media.example.test"] },
        publicationIdempotency(),
      ),
    ).resolves.toEqual({ published: false, reason: "SCREEN_NOT_FOUND" });
    await expect(
      publishApprovedSchedule(
        beta.id,
        {
          ...input,
          playlistId: betaPlaylist.id,
          screenIds: [betaScreen.id],
        },
        { actorUserId: actor.id },
        { mediaAllowedOrigins: ["https://media.example.test"] },
        publicationIdempotency(),
      ),
    ).resolves.toEqual({ published: false, reason: "FORBIDDEN" });
    expect(await prisma.publishedRelease.count()).toBe(0);
    expect(await prisma.releaseAssignment.count()).toBe(0);
    expect(await prisma.schedule.count()).toBe(0);

    await expect(
      prisma.publishedRelease.create({
        data: {
          organizationId: alpha.id,
          sourcePlaylistId: betaPlaylist.id,
          sourcePlaylistName: "Wrong tenant",
          sourcePlaylistDescription: "",
          sourcePlaylistUpdatedAt: new Date(),
          digestSha256: "3".repeat(64),
          createdById: actor.id,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      prisma.publishedRelease.create({
        data: {
          organizationId: alpha.id,
          sourcePlaylistId: alphaPlaylist.id,
          sourcePlaylistName: "Cross-tenant creator",
          sourcePlaylistDescription: "",
          sourcePlaylistUpdatedAt: new Date(),
          digestSha256: "4".repeat(64),
          createdById: betaActor.id,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });

    const valid = await publishApprovedSchedule(
      alpha.id,
      input,
      { actorUserId: actor.id },
      { mediaAllowedOrigins: ["https://media.example.test"] },
      publicationIdempotency(),
    );
    if (!valid.published) throw new Error("valid tenant publication failed");
    const sourceItem = await prisma.playlistItem.findFirstOrThrow({
      where: { playlistId: alphaPlaylist.id },
    });
    await expect(
      prisma.frozenReleaseItem.create({
        data: {
          organizationId: alpha.id,
          releaseId: valid.release.id,
          sourcePlaylistItemId: sourceItem.id,
          sourceAssetId: betaMedia.id,
          assetName: "Cross-tenant frozen asset",
          assetKind: "IMAGE",
          assetMimeType: "image/png",
          assetUrl: betaMedia.url,
          assetStorageKey: betaMedia.storageKey!,
          assetChecksumSha256: betaMedia.checksumSha256,
          assetSizeBytes: 100n,
          assetCreatedAt: new Date(betaMedia.createdAt),
          position: 1,
          durationSeconds: 10,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      prisma.releaseAssignment.create({
        data: {
          organizationId: alpha.id,
          releaseId: valid.release.id,
          scheduleId: valid.schedule.id,
          state: "ASSIGNED",
          candidatePublicationId: randomUUID(),
          expectedWithdrawalDigestSha256: "7".repeat(64),
          digestSha256: "6".repeat(64),
          createdById: actor.id,
          scheduleName: "Cross-tenant target",
          priority: "NORMAL",
          startsAt: new Date(input.startsAt),
          timezone: "UTC",
          daysOfWeek: [],
          enabled: true,
          targets: {
            create: [
              {
                screenId: betaScreen.id,
                liveScreenId: betaScreen.id,
                liveScreenOrganizationId: alpha.id,
              },
            ],
          },
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      prisma.releaseAssignmentTarget.create({
        data: {
          organizationId: alpha.id,
          assignmentId: valid.assignment.id,
          screenId: "partial-null-live-id",
          liveScreenId: null,
          liveScreenOrganizationId: alpha.id,
        },
      }),
    ).rejects.toBeDefined();
    await expect(
      prisma.releaseAssignmentTarget.create({
        data: {
          organizationId: alpha.id,
          assignmentId: valid.assignment.id,
          screenId: "partial-null-live-org",
          liveScreenId: "partial-null-live-org",
          liveScreenOrganizationId: null,
        },
      }),
    ).rejects.toBeDefined();
    expect(
      await prisma.releaseAssignment.count({
        where: { organizationId: alpha.id },
      }),
    ).toBe(1);
  });

  it("private-media migration refuses legacy URL metadata without verified objects", async () => {
    const organization = await createOrganization("private-media-preflight");
    await prisma.mediaAsset.create({
      data: {
        organizationId: organization.id,
        name: "Unverified legacy object",
        kind: "IMAGE",
        mimeType: "image/png",
        url: "https://legacy.example.test/unverified.png",
        storageKey:
          "organizations/private-media-preflight/assets/unverified/" +
          "a".repeat(64),
        checksumSha256: "a".repeat(64),
        sizeBytes: 1n,
      },
    });
    const migration = await readFile(
      new URL(
        "../prisma/migrations/20260912141000_private_media_delivery/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const preflight = migration.match(
      /DO \$private_media_preflight\$[\s\S]*?\$private_media_preflight\$;/,
    )?.[0];
    expect(preflight).toBeTruthy();
    expect(migration).not.toMatch(
      /UPDATE\s+"(?:MediaAsset|FrozenReleaseItem)"/i,
    );

    await expect(prisma.$executeRawUnsafe(preflight!)).rejects.toMatchObject({
      code: "P2010",
      meta: expect.objectContaining({ code: "P0001" }),
    });
    expect(await prisma.mediaAsset.count()).toBe(1);
  });

  it("location backfill preserves legacy labels and assigns tenant-bound classifications", async () => {
    const organization = await createOrganization("location-backfill");
    const [lobby, unassigned] = await Promise.all([
      prisma.screen.create({
        data: {
          organizationId: organization.id,
          name: "Lobby",
          location: " Main lobby ",
        },
      }),
      prisma.screen.create({
        data: { organizationId: organization.id, name: "Unset", location: "" },
      }),
    ]);
    const migration = await readFile(
      new URL(
        "../prisma/migrations/20260912151000_location_foundation/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const insert = migration.match(
      /WITH labels AS \([\s\S]*?FROM labels;/,
    )?.[0];
    const update = migration.match(/UPDATE "Screen" screen[\s\S]*?END;/)?.[0];
    expect(insert).toBeTruthy();
    expect(update).toBeTruthy();
    await prisma.$executeRawUnsafe(insert!);
    await prisma.$executeRawUnsafe(update!);

    const restored = await prisma.screen.findMany({
      where: { organizationId: organization.id },
      include: { classifiedLocation: true },
      orderBy: { name: "asc" },
    });
    expect(restored).toMatchObject([
      {
        id: lobby.id,
        location: " Main lobby ",
        classifiedLocation: { name: "Main lobby" },
      },
      {
        id: unassigned.id,
        location: "",
        classifiedLocation: { name: "Unassigned" },
      },
    ]);
  });

  it("release migration preflight refuses populated legacy schedules", async () => {
    const organization = await createOrganization("release-preflight");
    const playlist = await prisma.playlist.create({
      data: { organizationId: organization.id, name: "Legacy playlist" },
    });
    await prisma.schedule.create({
      data: {
        organizationId: organization.id,
        playlistId: playlist.id,
        name: "Legacy schedule",
        startsAt: new Date(),
      },
    });
    const migration = await readFile(
      new URL(
        "../prisma/migrations/20260912030000_immutable_ordinary_releases/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const preflight = migration.match(
      /DO \$release_preflight\$[\s\S]*?\$release_preflight\$;/,
    )?.[0];
    expect(preflight).toBeTruthy();

    await expect(prisma.$executeRawUnsafe(preflight!)).rejects.toMatchObject({
      code: "P2010",
      meta: expect.objectContaining({ code: "P0001" }),
    });
    expect(await prisma.schedule.count()).toBe(1);
  });

  it("rejects expired and aggregate-oversized media inside PostgreSQL publication", async () => {
    const organization = await createOrganization("media-policy");
    const actor = await createUser(`media-policy-${randomUUID()}@example.test`);
    await prisma.membership.create({
      data: {
        organizationId: organization.id,
        userId: actor.id,
        role: "PUBLISHER",
      },
    });
    const screen = await store.createScreen(organization.id, {
      name: "Media policy screen",
      location: "",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const publish = (playlistId: string) =>
      publishApprovedSchedule(
        organization.id,
        {
          playlistId,
          name: `Media policy ${randomUUID()}`,
          priority: "normal",
          startsAt: new Date(Date.now() - 60_000).toISOString(),
          timezone: "UTC",
          daysOfWeek: [],
          enabled: true,
          screenIds: [screen.id],
        },
        { actorUserId: actor.id },
        { mediaAllowedOrigins: ["https://media.example.test"] },
        publicationIdempotency(),
      );

    const expiredAsset = await store.createMedia(organization.id, {
      name: "Expired",
      kind: "image",
      mimeType: "image/png",
      url: "https://media.example.test/expired.png",
      checksumSha256: "a".repeat(64),
      sizeBytes: 1,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const expiredPlaylist = await store.createPlaylist(organization.id, {
      name: "Expired playlist",
      description: "",
      items: [
        {
          id: "ignored",
          assetId: expiredAsset.id,
          position: 0,
          durationSeconds: 10,
        },
      ],
    });
    await expect(publish(expiredPlaylist.id)).resolves.toEqual({
      published: false,
      reason: "ASSET_EXPIRED",
    });
    await prisma.mediaAsset.update({
      where: { id: expiredAsset.id },
      data: { kind: "WEB", mimeType: "text/html", expiresAt: null },
    });
    await expect(publish(expiredPlaylist.id)).resolves.toEqual({
      published: false,
      reason: "ASSET_UNSUPPORTED",
    });

    const assets = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        store.createMedia(organization.id, {
          name: `Large ${index}`,
          kind: "video",
          mimeType: "video/mp4",
          url: `https://media.example.test/large-${index}.mp4`,
          checksumSha256: String(index).repeat(64),
          sizeBytes: 128 * 1024 * 1024,
        }),
      ),
    );
    const aggregatePlaylist = await store.createPlaylist(organization.id, {
      name: "Aggregate playlist",
      description: "",
      items: assets.map((asset, position) => ({
        id: "ignored",
        assetId: asset.id,
        position,
        durationSeconds: 10,
      })),
    });
    await expect(publish(aggregatePlaylist.id)).resolves.toEqual({
      published: false,
      reason: "RELEASE_TOO_LARGE",
    });
    expect(await prisma.publishedRelease.count()).toBe(0);
    expect(await prisma.releaseAssignment.count()).toBe(0);
    expect(await prisma.schedule.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("enforces case-insensitive email uniqueness in PostgreSQL", async () => {
    await createUser("Owner@Example.Test");

    await expect(createUser("owner@example.test")).rejects.toMatchObject({
      code: "P2002",
    });
    expect(await prisma.user.count()).toBe(1);
  });

  it("serializes independently approved release-candidate publication", async () => {
    const organization = await createOrganization("release-candidate");
    const [author, approver] = await Promise.all([
      createMember(organization.id, "OWNER", "release-author"),
      createMember(organization.id, "ADMIN", "release-approver"),
    ]);
    const screen = await store.createScreen(organization.id, {
      name: "Candidate screen",
      location: "",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const media = await store.createMedia(organization.id, {
      name: "Candidate media",
      kind: "image",
      mimeType: "image/png",
      url: "https://media.example.test/release-candidate.png",
      checksumSha256: "c".repeat(64),
      sizeBytes: 100,
    });
    const playlist = await store.createPlaylist(organization.id, {
      name: "Candidate playlist",
      description: "",
      items: [
        { id: "ignored", assetId: media.id, position: 0, durationSeconds: 10 },
      ],
    });
    const created = await store.createReleaseCandidateAndAudit(
      organization.id,
      {
        playlistId: playlist.id,
        name: "Reviewed schedule",
        priority: "normal",
        startsAt: new Date(Date.now() + 60_000).toISOString(),
        timezone: "UTC",
        daysOfWeek: [],
        enabled: true,
        screenIds: [screen.id],
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      },
      { actorUserId: author.id },
      { mediaAllowedOrigins: ["https://media.example.test"] },
      publicationIdempotency(),
    );
    expect(created.completed).toBe(true);
    if (!created.completed) throw new Error(created.reason);
    const submitted = await store.submitReleaseCandidateAndAudit(
      organization.id,
      created.candidate.id,
      created.candidate.digestSha256,
      { actorUserId: author.id },
      publicationIdempotency(),
    );
    expect(submitted).toMatchObject({
      completed: true,
      candidate: { state: "IN_REVIEW" },
    });
    await expect(
      store.approveReleaseCandidateAndAudit(
        organization.id,
        created.candidate.id,
        created.candidate.digestSha256,
        { actorUserId: author.id },
        publicationIdempotency(),
      ),
    ).resolves.toEqual({
      completed: false,
      reason: "AUTHOR_CANNOT_APPROVE",
    });
    const foreignOrganization = await createOrganization(
      "foreign-release-candidate",
    );
    const foreignApprover = await createMember(
      foreignOrganization.id,
      "ADMIN",
      "foreign-release-approver",
    );
    await expect(
      store.approveReleaseCandidateAndAudit(
        foreignOrganization.id,
        created.candidate.id,
        created.candidate.digestSha256,
        { actorUserId: foreignApprover.id },
        publicationIdempotency(),
      ),
    ).resolves.toEqual({ completed: false, reason: "NOT_FOUND" });
    const approved = await store.approveReleaseCandidateAndAudit(
      organization.id,
      created.candidate.id,
      created.candidate.digestSha256,
      { actorUserId: approver.id },
      publicationIdempotency(),
    );
    expect(approved).toMatchObject({
      completed: true,
      candidate: {
        state: "APPROVED",
        approval: { approverUserId: approver.id },
      },
    });

    const auditCountBeforeRejectedPublish = await prisma.auditEvent.count();
    const idempotencyCountBeforeRejectedPublish =
      await prisma.idempotencyRecord.count();
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "AuditEvent" ADD CONSTRAINT "integration_reject_candidate_publish" CHECK ("action" <> \'release.published\')',
    );
    try {
      await expect(
        store.publishReleaseCandidateAndAudit(
          organization.id,
          created.candidate.id,
          created.candidate.digestSha256,
          { actorUserId: author.id },
          { mediaAllowedOrigins: ["https://media.example.test"] },
          publicationIdempotency(),
        ),
      ).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" DROP CONSTRAINT "integration_reject_candidate_publish"',
      );
    }
    expect(await prisma.schedule.count()).toBe(0);
    expect(await prisma.releaseAssignment.count()).toBe(0);
    expect(await prisma.releaseCandidatePublication.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(
      auditCountBeforeRejectedPublish,
    );
    expect(await prisma.idempotencyRecord.count()).toBe(
      idempotencyCountBeforeRejectedPublish,
    );

    const rejectedByPolicy = await store.publishReleaseCandidateAndAudit(
      organization.id,
      created.candidate.id,
      created.candidate.digestSha256,
      { actorUserId: author.id },
      { mediaAllowedOrigins: [] },
      publicationIdempotency(),
    );
    expect(rejectedByPolicy).toEqual({
      completed: false,
      reason: "ASSET_NOT_ALLOWED",
    });
    expect(await prisma.schedule.count()).toBe(0);
    expect(await prisma.releaseAssignment.count()).toBe(0);
    expect(await prisma.releaseCandidatePublication.count()).toBe(0);
    expect(
      await prisma.idempotencyRecord.count({
        where: { organizationId: organization.id },
      }),
    ).toBe(3);

    await prisma.membership.update({
      where: {
        organizationId_userId: {
          organizationId: organization.id,
          userId: approver.id,
        },
      },
      data: { authorizationEpoch: { increment: 1 } },
    });
    await expect(
      store.publishReleaseCandidateAndAudit(
        organization.id,
        created.candidate.id,
        created.candidate.digestSha256,
        { actorUserId: author.id },
        { mediaAllowedOrigins: ["https://media.example.test"] },
        publicationIdempotency(),
      ),
    ).resolves.toEqual({ completed: false, reason: "APPROVAL_STALE" });
    expect(
      await prisma.idempotencyRecord.count({
        where: { organizationId: organization.id },
      }),
    ).toBe(3);
    await prisma.membership.update({
      where: {
        organizationId_userId: {
          organizationId: organization.id,
          userId: approver.id,
        },
      },
      data: { authorizationEpoch: { decrement: 1 } },
    });

    const createApprovedGuardCandidate = async (
      label: string,
      targetBinding: "empty" | "live" | "null",
    ) => {
      const candidateId = randomUUID();
      const digestSha256 = randomUUID().replaceAll("-", "").repeat(2);
      const candidate = await prisma.releaseCandidate.create({
        data: {
          id: candidateId,
          organizationId: organization.id,
          releaseId: created.candidate.releaseId,
          digestSha256,
          authorUserId: author.id,
          scheduleName: `Publication guard ${label}`,
          priority: created.candidate.schedule.priority.toUpperCase() as
            "NORMAL" | "CAMPAIGN" | "PRIORITY",
          startsAt: new Date(created.candidate.schedule.startsAt),
          endsAt: created.candidate.schedule.endsAt
            ? new Date(created.candidate.schedule.endsAt)
            : null,
          timezone: created.candidate.schedule.timezone,
          daysOfWeek: created.candidate.schedule.daysOfWeek,
          dailyStartMinutes:
            created.candidate.schedule.dailyStartMinutes ?? null,
          dailyEndMinutes: created.candidate.schedule.dailyEndMinutes ?? null,
          enabled: created.candidate.schedule.enabled,
          expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
        },
      });
      const submittedAt = candidate.createdAt;
      const approvedAt = new Date(submittedAt.getTime() + 1);
      if (targetBinding !== "empty") {
        await prisma.releaseCandidateTarget.create({
          data: {
            organizationId: organization.id,
            candidateId,
            screenId: screen.id,
            liveScreenId: targetBinding === "live" ? screen.id : null,
            liveScreenOrganizationId:
              targetBinding === "live" ? organization.id : null,
          },
        });
      }
      await prisma.releaseCandidate.update({
        where: { id: candidateId },
        data: { state: "IN_REVIEW", submittedAt },
      });
      const [approverUser, approverMembership] = await Promise.all([
        prisma.user.findUniqueOrThrow({ where: { id: approver.id } }),
        prisma.membership.findUniqueOrThrow({
          where: {
            organizationId_userId: {
              organizationId: organization.id,
              userId: approver.id,
            },
          },
        }),
      ]);
      await prisma.releaseApproval.create({
        data: {
          organizationId: organization.id,
          candidateId,
          candidateDigestSha256: digestSha256,
          approverUserId: approver.id,
          authenticationEpoch: approverUser.authenticationEpoch,
          authorizationEpoch: approverMembership.authorizationEpoch,
          approvedAt,
        },
      });
      return prisma.releaseCandidate.update({
        where: { id: candidateId },
        data: { state: "APPROVED", approvedAt },
      });
    };

    const expectForgedPublicationRejected = async ({
      candidateId,
      assignmentTargetBinding,
      targetScreenIds,
    }: {
      candidateId: string;
      assignmentTargetBinding: "empty" | "live" | "null";
      targetScreenIds: string[];
    }) => {
      const candidate = await prisma.releaseCandidate.findUniqueOrThrow({
        where: { id: candidateId },
      });
      const publicationId = randomUUID();
      const scheduleId = randomUUID();
      const assignmentId = randomUUID();
      const publishedAt = new Date();
      await expectPrismaTriggerRejected(
        prisma.$transaction(async (tx) => {
          const forgedSchedule = await tx.schedule.create({
            data: {
              id: scheduleId,
              organizationId: organization.id,
              playlistId: playlist.id,
              name: candidate.scheduleName,
              priority: candidate.priority,
              startsAt: candidate.startsAt,
              endsAt: candidate.endsAt,
              timezone: candidate.timezone,
              daysOfWeek: candidate.daysOfWeek,
              dailyStartMinutes: candidate.dailyStartMinutes,
              dailyEndMinutes: candidate.dailyEndMinutes,
              enabled: candidate.enabled,
              targets: {
                create: targetScreenIds.map((screenId) => ({
                  screenId,
                })),
              },
            },
          });
          const forgedAssignment = await tx.releaseAssignment.create({
            data: {
              id: assignmentId,
              organizationId: organization.id,
              releaseId: candidate.releaseId,
              scheduleId: forgedSchedule.id,
              state: "ASSIGNED",
              digestSha256: "b".repeat(64),
              createdById: author.id,
              scheduleName: candidate.scheduleName,
              priority: candidate.priority,
              startsAt: candidate.startsAt,
              endsAt: candidate.endsAt,
              timezone: candidate.timezone,
              daysOfWeek: candidate.daysOfWeek,
              dailyStartMinutes: candidate.dailyStartMinutes,
              dailyEndMinutes: candidate.dailyEndMinutes,
              enabled: candidate.enabled,
              approvalRequired: true,
              candidatePublicationId: publicationId,
              expectedWithdrawalDigestSha256: "c".repeat(64),
              ...(assignmentTargetBinding === "empty"
                ? {}
                : {
                    targets: {
                      create: {
                        screenId: screen.id,
                        liveScreenId:
                          assignmentTargetBinding === "live" ? screen.id : null,
                        liveScreenOrganizationId:
                          assignmentTargetBinding === "live"
                            ? organization.id
                            : null,
                      },
                    },
                  }),
            },
          });
          await tx.releaseCandidate.update({
            where: { id: candidate.id },
            data: {
              state: "PUBLISHED",
              publicationId,
              publishedAt,
            },
          });
          await tx.releaseCandidatePublication.create({
            data: {
              id: publicationId,
              organizationId: organization.id,
              candidateId: candidate.id,
              scheduleId: forgedSchedule.id,
              assignmentId: forgedAssignment.id,
              publisherUserId: author.id,
              publishedAt,
            },
          });
        }),
        "Publication does not match an approved candidate",
      );
      await expect(
        Promise.all([
          prisma.schedule.findUnique({ where: { id: scheduleId } }),
          prisma.releaseAssignment.findUnique({ where: { id: assignmentId } }),
          prisma.releaseCandidatePublication.findUnique({
            where: { id: publicationId },
          }),
        ]),
      ).resolves.toEqual([null, null, null]);
      await expect(
        prisma.releaseCandidate.findUniqueOrThrow({
          where: { id: candidate.id },
        }),
      ).resolves.toMatchObject({
        state: "APPROVED",
        publicationId: null,
        publishedAt: null,
      });
    };

    await expectForgedPublicationRejected({
      candidateId: created.candidate.id,
      assignmentTargetBinding: "live",
      targetScreenIds: [],
    });
    const emptyTargetCandidate = await createApprovedGuardCandidate(
      "empty targets",
      "empty",
    );
    await expectForgedPublicationRejected({
      candidateId: emptyTargetCandidate.id,
      assignmentTargetBinding: "empty",
      targetScreenIds: [],
    });
    const mismatchedLiveTripleCandidate = await createApprovedGuardCandidate(
      "mismatched live triple",
      "live",
    );
    await expectForgedPublicationRejected({
      candidateId: mismatchedLiveTripleCandidate.id,
      assignmentTargetBinding: "null",
      targetScreenIds: [screen.id],
    });
    const nullLiveBindingCandidate = await createApprovedGuardCandidate(
      "null live binding",
      "null",
    );
    await expectForgedPublicationRejected({
      candidateId: nullLiveBindingCandidate.id,
      assignmentTargetBinding: "null",
      targetScreenIds: [screen.id],
    });

    const publishCommands = [
      publicationIdempotency(),
      publicationIdempotency(),
    ];
    const publish = (command: (typeof publishCommands)[number]) =>
      store.publishReleaseCandidateAndAudit(
        organization.id,
        created.candidate.id,
        created.candidate.digestSha256,
        { actorUserId: author.id },
        { mediaAllowedOrigins: ["https://media.example.test"] },
        command,
      );
    const publishResults = await Promise.all(publishCommands.map(publish));
    const successfulPublishIndex = publishResults.findIndex(
      (result) => result.completed,
    );
    expect(successfulPublishIndex).toBeGreaterThanOrEqual(0);
    expect(publishResults[successfulPublishIndex]).toMatchObject({
      completed: true,
      candidate: { state: "PUBLISHED" },
    });
    expect(publishResults.filter((result) => result.completed)).toHaveLength(1);
    expect(publishResults.filter((result) => !result.completed)).toEqual([
      { completed: false, reason: "INVALID_STATE" },
    ]);
    await expect(
      publish(publishCommands[successfulPublishIndex]!),
    ).resolves.toMatchObject({
      completed: true,
      replayed: true,
      candidate: { state: "PUBLISHED" },
    });
    const publishCommand = publishCommands[successfulPublishIndex]!;
    const publishLedger = await prisma.idempotencyRecord.findUniqueOrThrow({
      where: {
        organizationId_operation_keyHash: {
          organizationId: organization.id,
          operation: "RELEASE_CANDIDATE_PUBLISH",
          keyHash: publishCommand.keyHash,
        },
      },
    });
    const trustedPublishResponse = JSON.parse(
      JSON.stringify(publishLedger.responseBody),
    ) as Record<string, unknown>;
    await prisma.idempotencyRecord.update({
      where: { id: publishLedger.id },
      data: {
        responseBody: {
          ...trustedPublishResponse,
          scheduleId: randomUUID(),
        },
      },
    });
    await expect(publish(publishCommand)).rejects.toThrow(
      "Idempotent candidate response references are invalid",
    );
    await prisma.idempotencyRecord.update({
      where: { id: publishLedger.id },
      data: {
        responseBody: {
          ...trustedPublishResponse,
          publicationId: randomUUID(),
        },
      },
    });
    await expect(publish(publishCommand)).rejects.toThrow(
      "Idempotent candidate response references are invalid",
    );
    await prisma.idempotencyRecord.update({
      where: { id: publishLedger.id },
      data: { responseBody: trustedPublishResponse as Prisma.InputJsonValue },
    });
    expect(await prisma.schedule.count()).toBe(1);
    expect(await prisma.releaseAssignment.count()).toBe(1);
    expect(
      await prisma.releaseApproval.count({
        where: { candidateId: created.candidate.id },
      }),
    ).toBe(1);
    expect(
      await prisma.auditEvent.count({
        where: { action: "release.candidate.published" },
      }),
    ).toBe(1);

    const assigned = await prisma.releaseAssignment.findFirstOrThrow();
    expect(assigned).toMatchObject({
      state: "ASSIGNED",
      approvalRequired: true,
    });
    const publication =
      await prisma.releaseCandidatePublication.findFirstOrThrow();
    const publishedCandidate = await prisma.releaseCandidate.findUniqueOrThrow({
      where: { id: created.candidate.id },
    });
    expect(assigned.candidatePublicationId).toBe(publication.id);
    expect(assigned.expectedWithdrawalDigestSha256).toBe(
      assignmentSnapshotDigest(
        canonicalAssignmentSnapshot({
          releaseDigestSha256: created.candidate.releaseDigestSha256,
          state: "WITHDRAWN",
          schedule: created.candidate.schedule,
          screenIds: created.candidate.screenIds,
          previousAssignmentId: assigned.id,
        }),
      ),
    );
    expect(publication.assignmentId).toBe(assigned.id);
    expect(publication.candidateId).toBe(publishedCandidate.id);
    expect(publishedCandidate).toMatchObject({
      state: "PUBLISHED",
      publicationId: publication.id,
    });
    for (const deleteParent of [
      (tx: Prisma.TransactionClient) =>
        tx.schedule.delete({ where: { id: assigned.scheduleId } }),
      (tx: Prisma.TransactionClient) =>
        tx.publishedRelease.delete({ where: { id: assigned.releaseId } }),
    ]) {
      await expect(
        prisma.$transaction(async (tx) => {
          await deleteParent(tx);
        }),
      ).rejects.toMatchObject({ code: "P2003" });
    }
    await expect(
      prisma.schedule.findUnique({ where: { id: assigned.scheduleId } }),
    ).resolves.not.toBeNull();
    await expect(
      prisma.publishedRelease.findUnique({ where: { id: assigned.releaseId } }),
    ).resolves.not.toBeNull();
    await expectPrismaTriggerRejected(
      prisma.releaseAssignment.update({
        where: { id: assigned.id },
        data: { scheduleName: `${assigned.scheduleName} mutated` },
      }),
      "Release assignment snapshot is immutable",
    );
    await expect(
      prisma.releaseAssignment.findUniqueOrThrow({
        where: { id: assigned.id },
      }),
    ).resolves.toMatchObject({ state: "ASSIGNED", approvalRequired: true });
    await expectPrismaTriggerRejected(
      prisma.releaseAssignment.create({
        data: {
          organizationId: assigned.organizationId,
          releaseId: assigned.releaseId,
          scheduleId: assigned.scheduleId,
          state: "WITHDRAWN",
          digestSha256: "d".repeat(64),
          previousAssignmentId: assigned.id,
          createdById: author.id,
          scheduleName: assigned.scheduleName,
          priority: assigned.priority,
          startsAt: assigned.startsAt,
          endsAt: assigned.endsAt,
          timezone: assigned.timezone,
          daysOfWeek: assigned.daysOfWeek,
          dailyStartMinutes: assigned.dailyStartMinutes,
          dailyEndMinutes: assigned.dailyEndMinutes,
          enabled: assigned.enabled,
          targets: {
            create: {
              screenId: screen.id,
              // A withdrawal must copy the predecessor target exactly. In
              // particular, it cannot discard a still-live screen binding.
              liveScreenId: null,
              liveScreenOrganizationId: null,
            },
          },
        },
      }),
      "Release assignment targets may only be attached during assignment creation",
    );
    await expectPrismaTriggerRejected(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO "ReleaseAssignment" (
          "id", "organizationId", "releaseId", "scheduleId", "state",
          "digestSha256", "previousAssignmentId", "createdById",
          "scheduleName", "priority", "startsAt", "endsAt", "timezone",
          "daysOfWeek", "dailyStartMinutes", "dailyEndMinutes", "enabled"
        ) VALUES (
          ${randomUUID()}, ${assigned.organizationId}, ${assigned.releaseId},
          ${assigned.scheduleId}, 'WITHDRAWN', ${"c".repeat(64)}, ${assigned.id},
          ${author.id}, ${assigned.scheduleName}, ${assigned.priority}::"SchedulePriority",
          ${assigned.startsAt}, ${assigned.endsAt}, ${assigned.timezone},
          ${assigned.daysOfWeek}, ${assigned.dailyStartMinutes},
          ${assigned.dailyEndMinutes}, ${assigned.enabled}
        )`;
      }),
      "Release withdrawal targets must exactly match the assigned predecessor",
    );
    await expect(prisma.releaseAssignment.count()).resolves.toBe(1);
    const active = await store.activeOrdinaryReleases(
      organization.id,
      screen.id,
      created.candidate.schedule.startsAt,
    );
    expect(active).toHaveLength(1);
    expect(active[0]!.assignment.id).toBe(assigned.id);
    expect(hasValidStoredReleaseDigest(active[0]!.release)).toBe(true);
    expect(
      hasValidStoredAssignmentDigest(active[0]!.assignment, active[0]!.release),
    ).toBe(true);
    const deliveryAuthorization = {
      organizationId: organization.id,
      screenId: screen.id,
      assignmentId: assigned.id,
      assignmentDigestSha256: assigned.digestSha256,
      assetId: active[0]!.release.items[0]!.asset.id,
      storageKey: active[0]!.release.items[0]!.asset.storageKey!,
      checksumSha256: active[0]!.release.items[0]!.asset.checksumSha256,
      sizeBytes: active[0]!.release.items[0]!.asset.sizeBytes,
      at: created.candidate.schedule.startsAt,
    };
    const assignedTargets = await prisma.releaseAssignmentTarget.findMany({
      where: { assignmentId: assigned.id },
    });
    const poisonedWithdrawalId = randomUUID();
    await expectPrismaTriggerRejected(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`INSERT INTO "ReleaseAssignment" (
          "id", "organizationId", "releaseId", "scheduleId", "state",
          "digestSha256", "previousAssignmentId", "createdById",
          "scheduleName", "priority", "startsAt", "endsAt", "timezone",
          "daysOfWeek", "dailyStartMinutes", "dailyEndMinutes", "enabled"
        ) SELECT
          ${poisonedWithdrawalId}, "organizationId", "releaseId", "scheduleId",
          'WITHDRAWN', ${"a".repeat(64)}, "id", ${author.id}, "scheduleName",
          "priority", "startsAt", "endsAt", "timezone", "daysOfWeek",
          "dailyStartMinutes", "dailyEndMinutes", "enabled"
        FROM "ReleaseAssignment"
        WHERE "id"=${assigned.id} AND "organizationId"=${organization.id}`;
        await tx.$executeRaw`INSERT INTO "ReleaseAssignmentTarget" (
          "organizationId", "assignmentId", "screenId", "liveScreenId",
          "liveScreenOrganizationId"
        ) SELECT "organizationId", ${poisonedWithdrawalId}, "screenId",
                 "liveScreenId", "liveScreenOrganizationId"
          FROM "ReleaseAssignmentTarget"
          WHERE "assignmentId"=${assigned.id}
            AND "organizationId"=${organization.id}`;
      }),
      "Release withdrawal targets must exactly match the assigned predecessor",
    );
    await expect(
      prisma.releaseAssignment.count({ where: { id: poisonedWithdrawalId } }),
    ).resolves.toBe(0);
    const invalidWithdrawals = [
      {
        label: "changed scalar",
        scheduleName: `${assigned.scheduleName} drifted`,
        digestSha256: assignmentSnapshotDigest(
          canonicalAssignmentSnapshot({
            releaseDigestSha256: active[0]!.release.digestSha256,
            state: "WITHDRAWN",
            schedule: {
              ...active[0]!.assignment.schedule,
              name: `${assigned.scheduleName} drifted`,
            },
            screenIds: [screen.id],
            previousAssignmentId: assigned.id,
          }),
        ),
        copyTargets: true,
      },
      {
        label: "target subset",
        scheduleName: assigned.scheduleName,
        digestSha256: assignmentSnapshotDigest(
          canonicalAssignmentSnapshot({
            releaseDigestSha256: active[0]!.release.digestSha256,
            state: "WITHDRAWN",
            schedule: active[0]!.assignment.schedule,
            screenIds: [],
            previousAssignmentId: assigned.id,
          }),
        ),
        copyTargets: false,
      },
    ];
    for (const invalid of invalidWithdrawals) {
      const invalidId = randomUUID();
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "ReleaseAssignment" DISABLE TRIGGER USER',
      );
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "ReleaseAssignmentTarget" DISABLE TRIGGER USER',
      );
      try {
        await prisma.releaseAssignment.create({
          data: {
            id: invalidId,
            organizationId: assigned.organizationId,
            releaseId: assigned.releaseId,
            scheduleId: assigned.scheduleId,
            state: "WITHDRAWN",
            digestSha256: invalid.digestSha256,
            previousAssignmentId: assigned.id,
            createdById: author.id,
            scheduleName: invalid.scheduleName,
            priority: assigned.priority,
            startsAt: assigned.startsAt,
            endsAt: assigned.endsAt,
            timezone: assigned.timezone,
            daysOfWeek: assigned.daysOfWeek,
            dailyStartMinutes: assigned.dailyStartMinutes,
            dailyEndMinutes: assigned.dailyEndMinutes,
            enabled: assigned.enabled,
            ...(invalid.copyTargets
              ? {
                  targets: {
                    create: assignedTargets.map((target) => ({
                      screenId: target.screenId,
                      liveScreenId: target.liveScreenId,
                      liveScreenOrganizationId: target.liveScreenOrganizationId,
                    })),
                  },
                }
              : {}),
          },
        });
        await expect(store.listSchedules(organization.id)).resolves.toEqual([
          expect.objectContaining({
            id: assigned.scheduleId,
            withdrawable: true,
            releaseId: assigned.releaseId,
            assignmentId: assigned.id,
          }),
        ]);
        await expect(
          store.activeOrdinaryReleases(
            organization.id,
            screen.id,
            created.candidate.schedule.startsAt,
          ),
        ).resolves.toEqual([
          expect.objectContaining({
            assignment: expect.objectContaining({ id: assigned.id }),
          }),
        ]);
        await expect(
          store.authorizeMediaDelivery(deliveryAuthorization),
        ).resolves.toBe(true);
      } catch (error) {
        throw new Error(`Invalid ${invalid.label} withdrawal case failed`, {
          cause: error,
        });
      } finally {
        await prisma.releaseAssignmentTarget.deleteMany({
          where: { assignmentId: invalidId },
        });
        await prisma.releaseAssignment.deleteMany({
          where: { id: invalidId },
        });
        await prisma.$executeRawUnsafe(
          'ALTER TABLE "ReleaseAssignmentTarget" ENABLE TRIGGER USER',
        );
        await prisma.$executeRawUnsafe(
          'ALTER TABLE "ReleaseAssignment" ENABLE TRIGGER USER',
        );
      }
    }
    await expectPrismaTriggerRejected(
      prisma.releaseAssignment.create({
        data: {
          id: randomUUID(),
          organizationId: assigned.organizationId,
          releaseId: assigned.releaseId,
          scheduleId: assigned.scheduleId,
          state: "ASSIGNED",
          digestSha256: "e".repeat(64),
          createdById: author.id,
          scheduleName: assigned.scheduleName,
          priority: assigned.priority,
          startsAt: assigned.startsAt,
          endsAt: assigned.endsAt,
          timezone: assigned.timezone,
          daysOfWeek: assigned.daysOfWeek,
          dailyStartMinutes: assigned.dailyStartMinutes,
          dailyEndMinutes: assigned.dailyEndMinutes,
          enabled: assigned.enabled,
          approvalRequired: false,
        },
      }),
      "New assigned releases require complete approval provenance",
    );
    await expect(
      prisma.releaseAssignment.create({
        data: {
          id: randomUUID(),
          organizationId: assigned.organizationId,
          releaseId: assigned.releaseId,
          scheduleId: assigned.scheduleId,
          state: "ASSIGNED",
          digestSha256: "f".repeat(64),
          createdById: author.id,
          scheduleName: assigned.scheduleName,
          priority: assigned.priority,
          startsAt: assigned.startsAt,
          endsAt: assigned.endsAt,
          timezone: assigned.timezone,
          daysOfWeek: assigned.daysOfWeek,
          dailyStartMinutes: assigned.dailyStartMinutes,
          dailyEndMinutes: assigned.dailyEndMinutes,
          enabled: assigned.enabled,
          approvalRequired: true,
          candidatePublicationId: randomUUID(),
          expectedWithdrawalDigestSha256: "9".repeat(64),
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    expect(await prisma.releaseAssignment.count()).toBe(1);

    const mismatchedTarget = await store.createScreen(organization.id, {
      name: "Mismatched candidate target",
      location: "",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    await expect(
      prisma.$executeRaw`UPDATE "ReleaseCandidateTarget"
        SET "liveScreenId"=${mismatchedTarget.id},
            "liveScreenOrganizationId"=${organization.id}
        WHERE "candidateId"=${created.candidate.id}
          AND "organizationId"=${organization.id}`,
    ).rejects.toMatchObject({
      code: "P2010",
      meta: expect.objectContaining({ code: "55000" }),
    });
    for (const gcCandidateId of ["", created.candidate.id]) {
      await expectPrismaTriggerRejected(
        prisma.$transaction(async (tx) => {
          if (gcCandidateId)
            await tx.$executeRaw`SELECT set_config('screengoblin.candidate_gc_id', ${gcCandidateId}, true)`;
          await tx.releaseCandidateTarget.deleteMany({
            where: {
              organizationId: organization.id,
              candidateId: created.candidate.id,
            },
          });
        }),
        "ReleaseCandidateTarget history cannot be deleted",
      );
    }
    expect(
      await prisma.releaseCandidateTarget.count({
        where: {
          organizationId: organization.id,
          candidateId: created.candidate.id,
        },
      }),
    ).toBe(1);

    await prisma.$executeRaw`UPDATE "ReleaseAssignmentTarget"
      SET "liveScreenId"=NULL, "liveScreenOrganizationId"=NULL
      WHERE "assignmentId"=${assigned.id}
        AND "organizationId"=${organization.id}
        AND "screenId"=${screen.id}`;
    await expect(store.listSchedules(organization.id)).resolves.toEqual([]);
    await expect(
      store.activeOrdinaryReleases(
        organization.id,
        screen.id,
        created.candidate.schedule.startsAt,
      ),
    ).resolves.toEqual([]);
    await expect(
      store.authorizeMediaDelivery(deliveryAuthorization),
    ).resolves.toBe(false);
    const legitimateWithdrawal = await store.withdrawScheduleAndAudit(
      organization.id,
      assigned.scheduleId,
      { actorUserId: author.id },
    );
    expect(legitimateWithdrawal).toMatchObject({
      withdrawn: true,
      assignment: {
        state: "WITHDRAWN",
        previousAssignmentId: assigned.id,
      },
    });
    if (!legitimateWithdrawal.withdrawn)
      throw new Error(legitimateWithdrawal.reason);
    expect(
      hasValidStoredAssignmentDigest(
        legitimateWithdrawal.assignment,
        active[0]!.release,
      ),
    ).toBe(true);

    await prisma.organization.delete({ where: { id: organization.id } });
    expect(
      await prisma.releaseCandidate.count({
        where: { organizationId: organization.id },
      }),
    ).toBe(0);
    expect(
      await prisma.releaseApproval.count({
        where: { organizationId: organization.id },
      }),
    ).toBe(0);
    expect(
      await prisma.releaseCandidatePublication.count({
        where: { organizationId: organization.id },
      }),
    ).toBe(0);
    expect(
      await prisma.schedule.count({
        where: { organizationId: organization.id },
      }),
    ).toBe(0);
    expect(
      await prisma.releaseAssignment.count({
        where: { organizationId: organization.id },
      }),
    ).toBe(0);
    expect(
      await prisma.membershipAttribution.count({
        where: { organizationId: organization.id },
      }),
    ).toBe(0);
    for (const count of await Promise.all([
      prisma.publishedRelease.count({
        where: { organizationId: organization.id },
      }),
      prisma.frozenReleaseItem.count({
        where: { organizationId: organization.id },
      }),
      prisma.releaseCandidateTarget.count({
        where: { organizationId: organization.id },
      }),
      prisma.releaseAssignmentTarget.count({
        where: { organizationId: organization.id },
      }),
      prisma.scheduleTarget.count({
        where: { organizationId: organization.id },
      }),
      prisma.playlistItem.count({ where: { organizationId: organization.id } }),
      prisma.playlist.count({ where: { organizationId: organization.id } }),
      prisma.mediaAsset.count({ where: { organizationId: organization.id } }),
      prisma.organization.count({ where: { id: organization.id } }),
    ]))
      expect(count).toBe(0);
  });

  it("tenant-binds candidate idempotency and rejects actor or payload reuse in PostgreSQL", async () => {
    const [alpha, beta] = await Promise.all([
      createOrganization("candidate-idempotency-alpha"),
      createOrganization("candidate-idempotency-beta"),
    ]);
    const [alphaAuthor, otherAlphaAuthor, betaAuthor] = await Promise.all([
      createMember(alpha.id, "PUBLISHER", "candidate-idempotency-alpha"),
      createMember(alpha.id, "PUBLISHER", "candidate-idempotency-alpha-other"),
      createMember(beta.id, "PUBLISHER", "candidate-idempotency-beta"),
    ]);
    const candidateInput = async (organizationId: string, label: string) => {
      const screen = await store.createScreen(organizationId, {
        name: `${label} screen`,
        location: "",
        orientation: "landscape",
        resolution: "1920x1080",
        tags: [],
      });
      const media = await store.createMedia(organizationId, {
        name: `${label} media`,
        kind: "image",
        mimeType: "image/png",
        url: `https://media.example.test/${label}.png`,
        checksumSha256: (label === "alpha" ? "a" : "b").repeat(64),
        sizeBytes: 100,
      });
      const playlist = await store.createPlaylist(organizationId, {
        name: `${label} playlist`,
        description: "",
        items: [
          {
            id: "ignored",
            assetId: media.id,
            position: 0,
            durationSeconds: 10,
          },
        ],
      });
      return {
        playlistId: playlist.id,
        name: `${label} candidate`,
        priority: "normal" as const,
        startsAt: new Date(Date.now() + 60_000).toISOString(),
        timezone: "UTC",
        daysOfWeek: [],
        enabled: true,
        screenIds: [screen.id],
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      };
    };
    const [alphaInput, betaInput] = await Promise.all([
      candidateInput(alpha.id, "alpha"),
      candidateInput(beta.id, "beta"),
    ]);
    const sharedKeyHash = "1".repeat(64);
    const alphaCommand = {
      keyHash: sharedKeyHash,
      requestDigestSha256: "2".repeat(64),
    };
    const first = await store.createReleaseCandidateAndAudit(
      alpha.id,
      alphaInput,
      { actorUserId: alphaAuthor.id },
      { mediaAllowedOrigins: ["https://media.example.test"] },
      alphaCommand,
    );
    expect(first.completed).toBe(true);
    if (!first.completed) throw new Error(first.reason);
    await expect(
      store.createReleaseCandidateAndAudit(
        alpha.id,
        alphaInput,
        { actorUserId: alphaAuthor.id },
        { mediaAllowedOrigins: ["https://media.example.test"] },
        alphaCommand,
      ),
    ).resolves.toMatchObject({
      completed: true,
      replayed: true,
      candidate: { id: first.candidate.id, state: "DRAFT" },
    });
    await expect(
      store.createReleaseCandidateAndAudit(
        alpha.id,
        { ...alphaInput, name: "Changed candidate payload" },
        { actorUserId: alphaAuthor.id },
        { mediaAllowedOrigins: ["https://media.example.test"] },
        { ...alphaCommand, requestDigestSha256: "3".repeat(64) },
      ),
    ).resolves.toEqual({
      completed: false,
      reason: "IDEMPOTENCY_KEY_REUSED",
    });
    await expect(
      store.createReleaseCandidateAndAudit(
        alpha.id,
        alphaInput,
        { actorUserId: otherAlphaAuthor.id },
        { mediaAllowedOrigins: ["https://media.example.test"] },
        alphaCommand,
      ),
    ).resolves.toEqual({
      completed: false,
      reason: "IDEMPOTENCY_KEY_REUSED",
    });
    await expect(
      store.createReleaseCandidateAndAudit(
        beta.id,
        betaInput,
        { actorUserId: betaAuthor.id },
        { mediaAllowedOrigins: ["https://media.example.test"] },
        alphaCommand,
      ),
    ).resolves.toMatchObject({ completed: true });

    await expect(
      store.submitReleaseCandidateAndAudit(
        alpha.id,
        first.candidate.id,
        first.candidate.digestSha256,
        { actorUserId: alphaAuthor.id },
        {
          keyHash: sharedKeyHash,
          requestDigestSha256: "4".repeat(64),
        },
      ),
    ).resolves.toMatchObject({
      completed: true,
      candidate: { state: "IN_REVIEW" },
    });
    expect(
      await prisma.idempotencyRecord.count({
        where: { keyHash: sharedKeyHash },
      }),
    ).toBe(3);

    await prisma.idempotencyRecord.update({
      where: {
        organizationId_operation_keyHash: {
          organizationId: alpha.id,
          operation: "RELEASE_CANDIDATE_CREATE",
          keyHash: sharedKeyHash,
        },
      },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    await expect(
      store.createReleaseCandidateAndAudit(
        alpha.id,
        alphaInput,
        { actorUserId: alphaAuthor.id },
        { mediaAllowedOrigins: ["https://media.example.test"] },
        alphaCommand,
      ),
    ).resolves.toEqual({
      completed: false,
      reason: "IDEMPOTENCY_KEY_EXPIRED",
    });
    const freshInput = await candidateInput(alpha.id, "alpha-fresh");
    await expect(
      store.createReleaseCandidateAndAudit(
        alpha.id,
        freshInput,
        { actorUserId: alphaAuthor.id },
        { mediaAllowedOrigins: ["https://media.example.test"] },
        publicationIdempotency(),
      ),
    ).resolves.toMatchObject({ completed: true });
    await expect(
      prisma.idempotencyRecord.findUniqueOrThrow({
        where: {
          organizationId_operation_keyHash: {
            organizationId: alpha.id,
            operation: "RELEASE_CANDIDATE_CREATE",
            keyHash: sharedKeyHash,
          },
        },
      }),
    ).resolves.toMatchObject({ responseBody: null });
  });

  it("bounds PostgreSQL candidate response compaction and rejects corrupt replay atomically", async () => {
    const organization = await createOrganization("candidate-retention");
    const author = await createMember(
      organization.id,
      "PUBLISHER",
      "candidate-retention-author",
    );
    const screen = await store.createScreen(organization.id, {
      name: "Candidate retention screen",
      location: "",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const media = await store.createMedia(organization.id, {
      name: "Candidate retention media",
      kind: "image",
      mimeType: "image/png",
      url: "https://media.example.test/candidate-retention.png",
      checksumSha256: "c".repeat(64),
      sizeBytes: 100,
    });
    const playlist = await store.createPlaylist(organization.id, {
      name: "Candidate retention playlist",
      description: "",
      items: [
        { id: "ignored", assetId: media.id, position: 0, durationSeconds: 10 },
      ],
    });
    const expiredAt = new Date(Date.now() - 24 * 60 * 60_000);
    await prisma.idempotencyRecord.createMany({
      data: Array.from({ length: DATABASE_MAINTENANCE_BATCH_SIZE + 5 }, () => ({
        organizationId: organization.id,
        operation: "RELEASE_CANDIDATE_CREATE" as const,
        keyHash: proofHash(),
        actorUserId: author.id,
        requestDigestSha256: proofHash(),
        statusCode: 201,
        responseBody: { retained: "until-bounded-compaction" },
        createdAt: new Date(expiredAt.getTime() - 60_000),
        expiresAt: expiredAt,
      })),
    });
    const command = publicationIdempotency();
    const created = await store.createReleaseCandidateAndAudit(
      organization.id,
      {
        playlistId: playlist.id,
        name: "Candidate retention",
        priority: "normal",
        startsAt: new Date(Date.now() + 60_000).toISOString(),
        timezone: "UTC",
        daysOfWeek: [],
        enabled: true,
        screenIds: [screen.id],
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      },
      { actorUserId: author.id },
      { mediaAllowedOrigins: ["https://media.example.test"] },
      command,
    );
    expect(created.completed).toBe(true);
    if (!created.completed) throw new Error(created.reason);
    expect(
      await prisma.idempotencyRecord.count({
        where: {
          organizationId: organization.id,
          expiresAt: { lte: expiredAt },
          responseBody: { equals: Prisma.DbNull },
        },
      }),
    ).toBe(DATABASE_MAINTENANCE_BATCH_SIZE);
    expect(
      await prisma.idempotencyRecord.count({
        where: {
          organizationId: organization.id,
          expiresAt: { lte: expiredAt },
          responseBody: { not: Prisma.DbNull },
        },
      }),
    ).toBe(5);

    const ledger = await prisma.idempotencyRecord.findUniqueOrThrow({
      where: {
        organizationId_operation_keyHash: {
          organizationId: organization.id,
          operation: "RELEASE_CANDIDATE_CREATE",
          keyHash: command.keyHash,
        },
      },
    });
    await prisma.idempotencyRecord.update({
      where: { id: ledger.id },
      data: {
        responseBody: {
          ...JSON.parse(JSON.stringify(created.candidate)),
          id: randomUUID(),
        },
      },
    });
    const [candidateCount, auditCount, ledgerCount] = await Promise.all([
      prisma.releaseCandidate.count(),
      prisma.auditEvent.count(),
      prisma.idempotencyRecord.count(),
    ]);
    await expect(
      store.createReleaseCandidateAndAudit(
        organization.id,
        {
          playlistId: playlist.id,
          name: "Candidate retention",
          priority: "normal",
          startsAt: created.candidate.schedule.startsAt,
          timezone: "UTC",
          daysOfWeek: [],
          enabled: true,
          screenIds: [screen.id],
          expiresAt: created.candidate.expiresAt,
        },
        { actorUserId: author.id },
        { mediaAllowedOrigins: ["https://media.example.test"] },
        command,
      ),
    ).rejects.toThrow("Idempotent candidate response references are invalid");
    const trustedCreateResponse = JSON.parse(
      JSON.stringify(created.candidate),
    ) as Record<string, unknown>;
    await prisma.idempotencyRecord.update({
      where: { id: ledger.id },
      data: {
        responseBody: {
          ...trustedCreateResponse,
          schedule: {
            ...(trustedCreateResponse.schedule as Record<string, unknown>),
            name: "Corrupted cached schedule name",
          },
        },
      },
    });
    await expect(
      store.createReleaseCandidateAndAudit(
        organization.id,
        {
          playlistId: playlist.id,
          name: "Candidate retention",
          priority: "normal",
          startsAt: created.candidate.schedule.startsAt,
          timezone: "UTC",
          daysOfWeek: [],
          enabled: true,
          screenIds: [screen.id],
          expiresAt: created.candidate.expiresAt,
        },
        { actorUserId: author.id },
        { mediaAllowedOrigins: ["https://media.example.test"] },
        command,
      ),
    ).rejects.toThrow("Idempotent candidate response references are invalid");
    await expect(
      Promise.all([
        prisma.releaseCandidate.count(),
        prisma.auditEvent.count(),
        prisma.idempotencyRecord.count(),
      ]),
    ).resolves.toEqual([candidateCount, auditCount, ledgerCount]);
    await expect(
      prisma.idempotencyRecord.findUniqueOrThrow({ where: { id: ledger.id } }),
    ).resolves.toMatchObject({
      responseBody: expect.objectContaining({
        schedule: expect.objectContaining({
          name: "Corrupted cached schedule name",
        }),
      }),
    });
  });

  it("migration preflight aborts on legacy case variants without choosing an account", async () => {
    const migrationUrl = new URL(
      "../prisma/migrations/20260912021000_case_insensitive_user_email/migration.sql",
      import.meta.url,
    );
    const migration = await readFile(migrationUrl, "utf8");
    const preflight = migration.match(
      /DO \$identity_preflight\$[\s\S]*?\$identity_preflight\$;/,
    )?.[0];
    expect(preflight).toBeTruthy();

    await prisma.$executeRawUnsafe('DROP INDEX "User_email_lower_key"');
    try {
      await Promise.all([
        createUser("Legacy@Example.Test"),
        createUser("legacy@example.test"),
      ]);

      await expect(prisma.$executeRawUnsafe(preflight!)).rejects.toMatchObject({
        code: "P2010",
        meta: expect.objectContaining({ code: "23505" }),
      });
      const indexes = await prisma.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname = 'User_email_lower_key'
      `;
      expect(indexes[0]?.count).toBe(0);
      expect(await prisma.user.count()).toBe(2);
    } finally {
      await prisma.user.deleteMany();
      await prisma.$executeRawUnsafe(
        'CREATE UNIQUE INDEX "User_email_lower_key" ON "User" (LOWER("email"))',
      );
    }
  });
});
