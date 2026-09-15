import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hash } from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { SessionUser } from "../src/domain/types.js";
import { MemoryStore } from "../src/store/memory.js";
import { randomToken, sha256 } from "../src/utils/crypto.js";

const secret = "test-secret-that-is-longer-than-thirty-two-characters";
const signingKey = Buffer.alloc(32, 7).toString("base64url");
let app: FastifyInstance;
let store: MemoryStore;
let author: SessionUser;
let approver: SessionUser;

const issueToken = (user: SessionUser) => {
  const sessionId = randomToken();
  store.userSessions.push({
    id: crypto.randomUUID(),
    organizationId: user.organizationId,
    userId: user.id,
    tokenHash: sha256(sessionId),
    authenticationEpoch: user.authenticationEpoch,
    authorizationEpoch: user.authorizationEpoch,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    createdAt: new Date().toISOString(),
  });
  return app.jwt.sign(
    {
      sub: user.id,
      email: user.email,
      organizationId: user.organizationId,
      role: user.role,
      sessionId,
    },
    { expiresIn: "1h" },
  );
};

const headers = (user: SessionUser, key = crypto.randomUUID()) => ({
  authorization: `Bearer ${issueToken(user)}`,
  "idempotency-key": key,
});

beforeEach(async () => {
  store = new MemoryStore();
  author = {
    id: "00000000-0000-4000-8000-000000000011",
    email: "publisher@example.test",
    name: "Publisher",
    passwordHash: await hash("correct horse battery staple", 4),
    organizationId: "org-a",
    role: "PUBLISHER",
    authenticationEpoch: 0,
    authorizationEpoch: 0,
  };
  approver = {
    id: "00000000-0000-4000-8000-000000000012",
    email: "approver@example.test",
    name: "Approver",
    passwordHash: await hash("correct horse battery staple", 4),
    organizationId: "org-a",
    role: "ADMIN",
    authenticationEpoch: 0,
    authorizationEpoch: 0,
  };
  store.users.push(author, approver);
  app = await buildApp({
    store,
    jwtSecret: secret,
    manifestSigningPrivateKey: signingKey,
    pairingCodePepper: secret,
    deviceAuthMode: "development-bearer",
    publicApiUrl: "https://signage.example.test",
    mediaAllowedOrigins: ["https://media.example.test"],
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

const fixture = async () => {
  const screen = await store.createScreen("org-a", {
    name: "Lobby",
    location: "",
    orientation: "landscape",
    resolution: "1920x1080",
    tags: [],
  });
  const asset = await store.createMedia("org-a", {
    name: "Welcome",
    kind: "image",
    mimeType: "image/png",
    url: "https://media.example.test/welcome.png",
    checksumSha256: "a".repeat(64),
    sizeBytes: 1024,
  });
  const playlist = await store.createPlaylist("org-a", {
    name: "Lobby playlist",
    description: "",
    items: [
      { id: "ignored", assetId: asset.id, position: 0, durationSeconds: 15 },
    ],
  });
  return { screen, asset, playlist };
};

const payload = (playlistId: string, screenId: string) => ({
  playlistId,
  name: "School day",
  priority: "normal" as const,
  startsAt: new Date(Date.now() + 60_000).toISOString(),
  endsAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
  timezone: "America/New_York",
  daysOfWeek: [1],
  dailyStartMinutes: 9 * 60,
  dailyEndMinutes: 17 * 60,
  enabled: true,
  screenIds: [screenId],
  expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
});

const create = async (user = author) => {
  const { playlist, screen } = await fixture();
  return app.inject({
    method: "POST",
    url: "/api/v1/release-candidates",
    headers: headers(user),
    payload: payload(playlist.id, screen.id),
  });
};

const transition = (
  operation: "submit" | "approve" | "publish",
  candidate: { id: string; digestSha256: string },
  user: SessionUser,
  key = crypto.randomUUID(),
) =>
  app.inject({
    method: "POST",
    url: `/api/v1/release-candidates/${candidate.id}/${operation}`,
    headers: headers(user, key),
    payload: { digestSha256: candidate.digestSha256 },
  });

const approvedCandidate = async () => {
  const created = await create();
  expect(created.statusCode).toBe(201);
  const draft = created.json();
  expect((await transition("submit", draft, author)).statusCode).toBe(200);
  const approved = await transition("approve", draft, approver);
  expect(approved.statusCode).toBe(200);
  return approved.json();
};

describe("immutable release-candidate publication", () => {
  it("retires direct publication with a permanent, side-effect-free 410", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/schedules",
      headers: headers(author),
      payload: {},
    });
    expect(response.statusCode).toBe(410);
    expect(response.json().error.code).toBe("DIRECT_PUBLICATION_DISABLED");
    expect(store.schedules).toEqual([]);
    expect(store.releases).toEqual([]);
    expect(store.releaseCandidates).toEqual([]);
    expect(store.audits).toEqual([]);
  });

  it("creates, submits, independently approves, and publishes exactly once", async () => {
    const created = await create();
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      state: "DRAFT",
      authorUserId: author.id,
    });
    const draft = created.json();
    expect((await transition("submit", draft, author)).json().state).toBe(
      "IN_REVIEW",
    );
    const approval = await transition("approve", draft, approver);
    expect(approval.json()).toMatchObject({
      state: "APPROVED",
      approval: {
        approverUserId: approver.id,
        candidateDigestSha256: draft.digestSha256,
      },
    });
    const key = crypto.randomUUID();
    const first = await transition("publish", draft, author, key);
    const replay = await transition("publish", draft, author, key);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ state: "PUBLISHED" });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    const listedSchedules = await app.inject({
      method: "GET",
      url: "/api/v1/schedules",
      headers: headers(author),
    });
    expect(listedSchedules.json().data).toEqual([
      expect.objectContaining({
        withdrawable: true,
        releaseId: first.json().releaseId,
        assignmentId: first.json().assignmentId,
      }),
    ]);
    expect(store.schedules).toHaveLength(1);
    expect(store.releaseAssignments).toHaveLength(1);
    expect(store.audits.map((record) => record.action)).toEqual([
      "release.candidate.created",
      "release.candidate.submitted",
      "release.candidate.approved",
      "release.candidate.published",
      "release.published",
    ]);
  });

  it("enforces the role matrix and separation of duties", async () => {
    const viewer: SessionUser = {
      ...approver,
      id: "00000000-0000-4000-8000-000000000013",
      email: "viewer-2@example.test",
      role: "VIEWER",
    };
    store.users.push(viewer);
    expect((await create(viewer)).statusCode).toBe(403);

    const created = await create();
    const candidate = created.json();
    expect(
      (await transition("approve", candidate, approver)).json().error.code,
    ).toBe("INVALID_STATE");
    expect((await transition("submit", candidate, author)).statusCode).toBe(
      200,
    );
    const selfApproval = await transition("approve", candidate, author);
    expect(selfApproval.statusCode).toBe(403);
    const ownerAuthor: SessionUser = { ...approver, role: "OWNER" };
    store.users[1]!.role = "OWNER";
    const ownerCandidate = (await create(ownerAuthor)).json();
    expect(
      (await transition("submit", ownerCandidate, ownerAuthor)).statusCode,
    ).toBe(200);
    const ownerSelfApproval = await transition(
      "approve",
      ownerCandidate,
      ownerAuthor,
    );
    expect(ownerSelfApproval.statusCode).toBe(409);
    expect(ownerSelfApproval.json().error.code).toBe("AUTHOR_CANNOT_APPROVE");
  });

  it("rejects stale candidate digests without advancing state", async () => {
    const candidate = (await create()).json();
    const stale = await transition(
      "submit",
      { ...candidate, digestSha256: "0".repeat(64) },
      author,
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("STALE_DIGEST");
    expect(store.releaseCandidates[0]!.state).toBe("DRAFT");
  });

  it("invalidates approval after approver authentication or authorization changes", async () => {
    for (const epoch of [
      "authenticationEpoch",
      "authorizationEpoch",
    ] as const) {
      const approved = await approvedCandidate();
      approver[epoch] += 1;
      const response = await transition("publish", approved, author);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("APPROVAL_STALE");
      expect(store.schedules).toEqual([]);
      approver[epoch] -= 1;
    }
  });

  it("rejects expiry at every transition and never partially publishes", async () => {
    const { playlist, screen } = await fixture();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/release-candidates",
      headers: headers(author),
      payload: {
        ...payload(playlist.id, screen.id),
        expiresAt: new Date(Date.now() + 100).toISOString(),
      },
    });
    expect(created.statusCode).toBe(201);
    const candidate = created.json();
    await new Promise((resolve) => setTimeout(resolve, 150));
    for (const [operation, user] of [
      ["submit", author],
      ["approve", approver],
      ["publish", author],
    ] as const) {
      const response = await transition(operation, candidate, user);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("EXPIRED");
    }
    expect(store.schedules).toEqual([]);
    expect(store.releaseAssignments).toEqual([]);
  });

  it("conceals cross-tenant candidates and leaves the source untouched", async () => {
    const candidate = (await create()).json();
    const outsider: SessionUser = {
      ...approver,
      id: "00000000-0000-4000-8000-000000000014",
      email: "outsider@example.test",
      organizationId: "org-b",
    };
    store.users.push(outsider);
    const response = await transition("approve", candidate, outsider);
    expect(response.statusCode).toBe(404);
    expect(store.releaseCandidates[0]!.state).toBe("DRAFT");
  });

  it("exposes tenant-scoped review DTOs without approval security epochs", async () => {
    const approved = await approvedCandidate();
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/release-candidates",
      headers: { authorization: `Bearer ${issueToken(approver)}` },
    });
    const item = await app.inject({
      method: "GET",
      url: `/api/v1/release-candidates/${approved.id}`,
      headers: { authorization: `Bearer ${issueToken(approver)}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toEqual([item.json()]);
    expect(item.json()).toMatchObject({
      id: approved.id,
      state: "APPROVED",
      approval: { approverUserId: approver.id },
    });
    expect(item.body).not.toContain("authenticationEpoch");
    expect(item.body).not.toContain("authorizationEpoch");

    const outsider: SessionUser = {
      ...approver,
      id: "00000000-0000-4000-8000-000000000015",
      email: "reviewer-outsider@example.test",
      organizationId: "org-b",
    };
    store.users.push(outsider);
    const outsiderToken = issueToken(outsider);
    const concealedList = await app.inject({
      method: "GET",
      url: "/api/v1/release-candidates",
      headers: { authorization: `Bearer ${outsiderToken}` },
    });
    const concealedItem = await app.inject({
      method: "GET",
      url: `/api/v1/release-candidates/${approved.id}`,
      headers: { authorization: `Bearer ${outsiderToken}` },
    });
    expect(concealedList.json()).toEqual({ data: [] });
    expect(concealedItem.statusCode).toBe(404);
  });

  it("binds idempotency keys to operation, actor, candidate, and digest", async () => {
    const created = await create();
    const candidate = created.json();
    const key = crypto.randomUUID();
    expect(
      (await transition("submit", candidate, author, key)).statusCode,
    ).toBe(200);
    const replay = await transition("submit", candidate, author, key);
    expect(replay.statusCode).toBe(200);
    const changed = await transition(
      "submit",
      { ...candidate, digestSha256: "1".repeat(64) },
      author,
      key,
    );
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("compacts expired candidate response snapshots while retaining tombstones", async () => {
    const first = await create();
    expect(first.statusCode).toBe(201);
    const retained = store.releaseCandidateIdempotencyRecords[0]!;
    retained.expiresAt = "2020-01-01T00:00:00.000Z";

    const second = await create();
    expect(second.statusCode).toBe(201);
    expect(retained.response).toBeUndefined();
    expect(
      store.releaseCandidateIdempotencyRecords.some(
        (record) => record.keyHash === retained.keyHash,
      ),
    ).toBe(true);
  });

  it("fails closed when an idempotent candidate response loses its live reference", async () => {
    const created = await create();
    const candidate = created.json();
    const submitted = await transition("submit", candidate, author);
    expect(submitted.statusCode).toBe(200);
    const record = store.releaseCandidateIdempotencyRecords.find(
      ({ operation }) => operation === "submit",
    )!;
    record.response = { ...record.response!, id: crypto.randomUUID() };

    await expect(
      store.submitReleaseCandidateAndAudit(
        "org-a",
        candidate.id,
        candidate.digestSha256,
        { actorUserId: author.id },
        {
          keyHash: record.keyHash,
          requestDigestSha256: record.requestDigestSha256,
        },
      ),
    ).rejects.toThrow("Idempotent candidate response references are invalid");
  });

  it("retains near-expiry approval replay for 30 days before GC leaves a tombstone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const day0 = Date.parse("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(day0);
    const { playlist, screen } = await fixture();
    const created = await store.createReleaseCandidateAndAudit(
      "org-a",
      {
        ...payload(playlist.id, screen.id),
        expiresAt: new Date(day0 + 7 * 24 * 60 * 60_000).toISOString(),
      },
      { actorUserId: author.id },
      { mediaAllowedOrigins: ["https://media.example.test"] },
      { keyHash: "1".repeat(64), requestDigestSha256: "2".repeat(64) },
    );
    if (!created.completed) throw new Error(created.reason);
    vi.setSystemTime(day0 + 6 * 24 * 60 * 60_000);
    await store.submitReleaseCandidateAndAudit(
      "org-a",
      created.candidate.id,
      created.candidate.digestSha256,
      { actorUserId: author.id },
      { keyHash: "3".repeat(64), requestDigestSha256: "4".repeat(64) },
    );
    const approvalKey = {
      keyHash: "5".repeat(64),
      requestDigestSha256: "6".repeat(64),
    };
    await store.approveReleaseCandidateAndAudit(
      "org-a",
      created.candidate.id,
      created.candidate.digestSha256,
      { actorUserId: approver.id },
      approvalKey,
    );

    vi.setSystemTime(day0 + 30 * 24 * 60 * 60_000);
    await expect(
      store.approveReleaseCandidateAndAudit(
        "org-a",
        created.candidate.id,
        created.candidate.digestSha256,
        { actorUserId: approver.id },
        approvalKey,
      ),
    ).resolves.toMatchObject({ completed: true, replayed: true });

    vi.setSystemTime(day0 + 38 * 24 * 60 * 60_000);
    const fresh = await fixture();
    await store.createReleaseCandidateAndAudit(
      "org-a",
      {
        ...payload(fresh.playlist.id, fresh.screen.id),
        expiresAt: new Date(day0 + 39 * 24 * 60 * 60_000).toISOString(),
      },
      { actorUserId: author.id },
      { mediaAllowedOrigins: ["https://media.example.test"] },
      { keyHash: "7".repeat(64), requestDigestSha256: "8".repeat(64) },
    );
    expect(
      store.releaseCandidates.some(({ id }) => id === created.candidate.id),
    ).toBe(false);
    await expect(
      store.approveReleaseCandidateAndAudit(
        "org-a",
        created.candidate.id,
        created.candidate.digestSha256,
        { actorUserId: approver.id },
        approvalKey,
      ),
    ).resolves.toEqual({ completed: false, reason: "IDEMPOTENCY_KEY_EXPIRED" });
  });

  it("protects published sources and preserves immutable withdrawal history", async () => {
    const approved = await approvedCandidate();
    const published = await transition("publish", approved, author);
    expect(published.statusCode).toBe(200);
    const scheduleId = published.json().scheduleId as string;
    const release = store.releases.find(
      (record) => record.id === published.json().releaseId,
    )!;
    const assetId = release.items[0]!.asset.id;
    for (const url of [
      `/api/v1/media/${assetId}`,
      `/api/v1/playlists/${published.json().sourcePlaylistId}`,
    ]) {
      const deletion = await app.inject({
        method: "DELETE",
        url,
        headers: { authorization: `Bearer ${issueToken(approver)}` },
      });
      expect(deletion.statusCode).toBe(409);
      expect(deletion.json().error.code).toBe("RESOURCE_IN_USE");
    }
    const withdrawal = await app.inject({
      method: "DELETE",
      url: `/api/v1/schedules/${scheduleId}`,
      headers: { authorization: `Bearer ${issueToken(author)}` },
    });
    expect(withdrawal.statusCode).toBe(204);
    expect(store.releaseAssignments.map(({ state }) => state)).toEqual([
      "ASSIGNED",
      "WITHDRAWN",
    ]);
    await expect(
      store.activeOrdinaryReleases(
        "org-a",
        approved.screenIds[0],
        approved.schedule.startsAt,
      ),
    ).resolves.toEqual([]);
  });

  it("fails closed when publication policy changes or source media is invalid", async () => {
    const approved = await approvedCandidate();
    app.config.mediaAllowedOrigins.splice(0);
    const policyFailure = await transition("publish", approved, author);
    expect(policyFailure.statusCode).toBe(422);
    expect(policyFailure.json().error.code).toBe("ASSET_NOT_ALLOWED");
    expect(store.schedules).toEqual([]);
    expect(store.releaseAssignments).toEqual([]);

    app.config.mediaAllowedOrigins.push("https://media.example.test");
    const invalid = await fixture();
    store.media.find((asset) => asset.id === invalid.asset.id)!.expiresAt =
      "2020-01-01T00:00:00.000Z";
    const mediaFailure = await app.inject({
      method: "POST",
      url: "/api/v1/release-candidates",
      headers: headers(author),
      payload: payload(invalid.playlist.id, invalid.screen.id),
    });
    expect(mediaFailure.statusCode).toBe(422);
    expect(mediaFailure.json().error.code).toBe("ASSET_EXPIRED");
    expect(store.releaseCandidates).toHaveLength(1);
  });
});
