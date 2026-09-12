import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hash } from "bcryptjs";
import { buildApp } from "../src/app.js";
import { MemoryStore } from "../src/store/memory.js";
import type { FastifyInstance } from "fastify";
import {
  MemoryRateLimitBudget,
  opaqueSecurityEventKey,
} from "../src/utils/rate-limit.js";
import { MEDIA_MAX_ASSET_BYTES } from "@screengoblin/contracts";
import { randomToken, sha256 } from "../src/utils/crypto.js";
import { LOGIN_FAILURE_MAX_RECORDS } from "../src/domain/types.js";
import type { SessionUser } from "../src/domain/types.js";
import { verifyMediaCapability } from "../src/media/delivery.js";

const secret = "test-secret-that-is-longer-than-thirty-two-characters";
const signingKey = Buffer.alloc(32, 7).toString("base64url");
const capabilityClaims = (url: string) => {
  const capability = new URL(url).searchParams.get("capability");
  if (!capability) throw new Error("Manifest item has no media capability");
  const claims = verifyMediaCapability(capability, secret);
  if (!claims) throw new Error("Manifest media capability is invalid");
  return claims;
};
let app: FastifyInstance;
let store: MemoryStore;
let token: string;
const issueTestToken = (
  user: SessionUser,
  storedExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(),
) => {
  const sessionId = randomToken();
  store.userSessions.push({
    id: crypto.randomUUID(),
    organizationId: user.organizationId,
    userId: user.id,
    tokenHash: sha256(sessionId),
    authenticationEpoch: user.authenticationEpoch,
    authorizationEpoch: user.authorizationEpoch,
    expiresAt: storedExpiresAt,
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
beforeEach(async () => {
  store = new MemoryStore();
  store.users.push(
    {
      id: "00000000-0000-4000-8000-000000000001",
      email: "admin@example.test",
      name: "Admin",
      passwordHash: await hash("correct horse battery staple", 4),
      organizationId: "org-a",
      role: "OWNER",
      authenticationEpoch: 0,
      authorizationEpoch: 0,
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      email: "viewer@example.test",
      name: "Viewer",
      passwordHash: await hash("correct horse battery staple", 4),
      organizationId: "org-a",
      role: "VIEWER",
      authenticationEpoch: 0,
      authorizationEpoch: 0,
    },
  );
  app = await buildApp({
    store,
    jwtSecret: secret,
    manifestSigningPrivateKey: signingKey,
    pairingCodePepper: secret,
    deviceAuthMode: "development-bearer",
    publicApiUrl: "https://signage.example.test",
    mediaAllowedOrigins: ["https://media.example.test"],
    legacyMediaRegistrationEnabled: true,
  });
  token = issueTestToken(store.users[0]!);
});

afterEach(() => {
  vi.useRealTimers();
});

const pairDevice = async (installationId: string) => {
  token = issueTestToken(store.users[0]!);
  const code = (
    await app.inject({
      method: "POST",
      url: "/api/v1/pairing-codes",
      headers: { authorization: `Bearer ${token}` },
    })
  ).json().code;
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/device/pair",
    payload: {
      code,
      device: {
        installationId,
        model: "Test player",
        osVersion: "14",
        playerVersion: "0.1.0",
      },
    },
  });
  expect(response.statusCode).toBe(201);
  const credentials = response.json();
  return {
    screenId: credentials.screenId as string,
    headers: {
      "x-screen-id": credentials.screenId as string,
      "x-device-token": credentials.deviceToken as string,
    },
  };
};

const scheduledPlaylist = async (
  screenId: string,
  overrides: Partial<Parameters<MemoryStore["createSchedule"]>[1]> = {},
) => {
  const asset = await store.createMedia("org-a", {
    name: "Welcome",
    kind: "image",
    mimeType: "image/png",
    url: "https://media.example.test/welcome.png",
    checksumSha256: "a".repeat(64),
    sizeBytes: 1024,
  });
  const playlist = await store.createPlaylist("org-a", {
    name: "Lobby",
    description: "",
    items: [
      { id: "ignored", assetId: asset.id, position: 0, durationSeconds: 15 },
    ],
  });
  const result = await store.publishScheduleAndAudit(
    "org-a",
    {
      playlistId: playlist.id,
      name: "School day",
      priority: "normal",
      startsAt: "2026-09-14T00:00:00.000Z",
      endsAt: "2026-09-15T00:00:00.000Z",
      timezone: "America/New_York",
      daysOfWeek: [1],
      dailyStartMinutes: 9 * 60,
      dailyEndMinutes: 17 * 60,
      enabled: true,
      screenIds: [screenId],
      ...overrides,
    },
    { actorUserId: store.users[0]!.id },
    { mediaAllowedOrigins: ["https://media.example.test"] },
  );
  if (!result.published)
    throw new Error(`Schedule fixture failed: ${result.reason}`);
  return result.schedule;
};

describe("health and error contract", () => {
  it("reports liveness and readiness", async () => {
    const live = await app.inject({ url: "/health/live" });
    const ready = await app.inject({ url: "/health/ready" });
    expect(live.statusCode).toBe(204);
    expect(ready.statusCode).toBe(204);
    expect(live.body).toBe("");
    expect(ready.body).toBe("");
    expect(live.headers["cache-control"]).toBe("no-store");
    expect(ready.headers["cache-control"]).toBe("no-store");
  });
  it("does not identify the dependency that failed readiness", async () => {
    store.ping = async () => {
      throw new Error("sensitive database detail");
    };
    const ready = await app.inject({ url: "/health/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.body).toBe("");
    expect(ready.body).not.toContain("database");
  });
  it("requires Redis when production request protection is enabled", async () => {
    await expect(
      buildApp({
        store,
        jwtSecret: secret,
        manifestSigningPrivateKey: signingKey,
        pairingCodePepper: secret,
        deviceAuthMode: "development-bearer",
        requireRedis: true,
      }),
    ).rejects.toThrow("Redis is required");
  });
  it("includes Redis in readiness without exposing its failure", async () => {
    const redis = {
      defineCommand(name: string) {
        Object.assign(this, { [name]: () => undefined });
      },
      ping: async () => {
        throw new Error("sensitive redis detail");
      },
    };
    const redisApp = await buildApp({
      store,
      jwtSecret: secret,
      manifestSigningPrivateKey: signingKey,
      pairingCodePepper: secret,
      deviceAuthMode: "development-bearer",
      redis: redis as never,
      rateLimitBudget: new MemoryRateLimitBudget(),
    });
    const ready = await redisApp.inject({ url: "/health/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.body).toBe("");
    await redisApp.close();
  });
  it("returns safe validation errors with server-owned request IDs", async () => {
    const hostileRequestId = "attacker-chosen-duplicate";
    const responses = await Promise.all(
      Array.from({ length: 2 }, () =>
        app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          headers: { "x-request-id": hostileRequestId },
          payload: { email: "bad", password: "x" },
        }),
      ),
    );
    const requestIds = responses.map(
      (response) => response.json().requestId as string,
    );

    for (const response of responses) {
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_ERROR");
    }
    expect(requestIds[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(requestIds[1]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(requestIds[0]).not.toBe(requestIds[1]);
    expect(requestIds).not.toContain(hostileRequestId);
  });
});

describe("authentication and organization RBAC", () => {
  it("logs in without returning password material", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "admin@example.test",
        password: "correct horse battery staple",
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().accessToken).toBeTypeOf("string");
    expect(r.body).not.toContain("passwordHash");
  });
  it("records indistinguishable known and unknown failures without raw identifiers", async () => {
    const attempt = (email: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email, password: "incorrect password" },
      });
    const knownEmail = "admin@example.test";
    const unknownEmail = "missing@example.test";
    const [known, unknown] = await Promise.all([
      attempt(knownEmail),
      attempt(unknownEmail),
    ]);
    expect(known.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(known.json().error).toEqual(unknown.json().error);
    expect(store.loginFailures).toHaveLength(2);
    expect(store.loginFailures.map((event) => event.reason)).toEqual([
      "INVALID_CREDENTIALS",
      "INVALID_CREDENTIALS",
    ]);
    expect(store.loginFailures.map((event) => event.accountKey).sort()).toEqual(
      [
        opaqueSecurityEventKey(secret, "login-failure-account", knownEmail),
        opaqueSecurityEventKey(secret, "login-failure-account", unknownEmail),
      ].sort(),
    );
    expect(
      new Set(store.loginFailures.map((event) => event.sourceKey)).size,
    ).toBe(1);
    const stored = JSON.stringify(store.loginFailures);
    expect(stored).not.toContain(knownEmail);
    expect(stored).not.toContain(unknownEmail);
    expect(stored).not.toContain("127.0.0.1");
    expect(stored).not.toContain("incorrect password");
  });

  it("fails sign-in closed and uniformly when failure telemetry is unavailable", async () => {
    store.recordLoginFailure = async () => {
      throw new Error("telemetry unavailable");
    };
    const attempt = (email: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email, password: "incorrect password" },
      });
    const [known, unknown] = await Promise.all([
      attempt("admin@example.test"),
      attempt("missing@example.test"),
    ]);
    expect(known.statusCode).toBe(503);
    expect(unknown.statusCode).toBe(503);
    expect(known.json().error).toEqual(unknown.json().error);
    expect(known.json().error.code).toBe("AUTH_TELEMETRY_UNAVAILABLE");
  });

  it("bounds in-memory failure retention while preserving the newest event", async () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    store.loginFailures.push({
      id: "expired-login-failure",
      accountKey: "a".repeat(64),
      sourceKey: "b".repeat(64),
      reason: "INVALID_CREDENTIALS",
      occurredAt: old,
    });
    for (let index = 0; index < LOGIN_FAILURE_MAX_RECORDS; index += 1) {
      store.loginFailures.push({
        id: `bounded-${index.toString().padStart(5, "0")}`,
        accountKey: "a".repeat(64),
        sourceKey: "b".repeat(64),
        reason: "INVALID_CREDENTIALS",
        occurredAt: new Date().toISOString(),
      });
    }
    await store.recordLoginFailure({
      accountKey: "c".repeat(64),
      sourceKey: "d".repeat(64),
      reason: "RATE_LIMITED",
    });
    expect(store.loginFailures).toHaveLength(LOGIN_FAILURE_MAX_RECORDS);
    expect(
      store.loginFailures.some((event) => event.id === "expired-login-failure"),
    ).toBe(false);
    expect(store.loginFailures.at(-1)).toMatchObject({
      accountKey: "c".repeat(64),
      sourceKey: "d".repeat(64),
      reason: "RATE_LIMITED",
    });
  });

  it("stores only a hash of the bounded session identity and prunes expiry", async () => {
    store.userSessions.push({
      id: "expired-session",
      organizationId: "org-a",
      userId: store.users[0]!.id,
      tokenHash: "f".repeat(64),
      authenticationEpoch: store.users[0]!.authenticationEpoch,
      authorizationEpoch: store.users[0]!.authorizationEpoch,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      createdAt: new Date(Date.now() - 2_000).toISOString(),
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "admin@example.test",
        password: "correct horse battery staple",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().expiresIn).toBe(3_600);
    const decoded = app.jwt.decode(response.json().accessToken) as {
      sessionId: string;
    };
    const session = store.userSessions.find(
      (candidate) => candidate.tokenHash === sha256(decoded.sessionId),
    );
    expect(session).toBeDefined();
    expect(session?.tokenHash).not.toBe(decoded.sessionId);
    expect(
      store.userSessions.some(
        (candidate) => candidate.id === "expired-session",
      ),
    ).toBe(false);
    expect(response.body).not.toContain(decoded.sessionId);
    expect(store.audits.at(-1)).toMatchObject({
      action: "auth.login_succeeded",
      entityType: "session",
      entityId: session?.id,
      metadata: { expiresAt: session?.expiresAt },
    });
  });

  it("rejects legacy and expired session identities", async () => {
    const legacy = app.jwt.sign({
      sub: store.users[0]!.id,
      email: store.users[0]!.email,
      organizationId: "org-a",
      role: "OWNER",
    } as never);
    const expired = issueTestToken(
      store.users[0]!,
      new Date(Date.now() - 1_000).toISOString(),
    );
    for (const candidate of [legacy, expired]) {
      const response = await app.inject({
        url: "/api/v1/auth/me",
        headers: { authorization: `Bearer ${candidate}` },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("SESSION_REVOKED");
    }
  });

  it("revokes only the current session and handles concurrent logout safely", async () => {
    const login = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: {
          email: "admin@example.test",
          password: "correct horse battery staple",
        },
      });
    const [first, second] = await Promise.all([login(), login()]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstToken = first.json().accessToken as string;
    const secondToken = second.json().accessToken as string;
    const firstSessionId = (app.jwt.decode(firstToken) as { sessionId: string })
      .sessionId;
    const firstSession = store.userSessions.find(
      (candidate) => candidate.tokenHash === sha256(firstSessionId),
    );

    const logout = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers: { authorization: `Bearer ${firstToken}` },
      });
    const logoutResponses = await Promise.all([logout(), logout()]);
    expect(
      logoutResponses.some((response) => response.statusCode === 204),
    ).toBe(true);
    expect(
      logoutResponses.every((response) =>
        [204, 401].includes(response.statusCode),
      ),
    ).toBe(true);
    expect(
      store.audits.filter(
        (event) =>
          event.action === "auth.logout" && event.entityId === firstSession?.id,
      ),
    ).toHaveLength(1);

    const revoked = await app.inject({
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${firstToken}` },
    });
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json().error.code).toBe("SESSION_REVOKED");

    const stillActive = await app.inject({
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${secondToken}` },
    });
    expect(stillActive.statusCode).toBe(200);
    expect(stillActive.body).not.toContain("sessionId");
  });

  it("revokes every session after password rotation and keeps login failures generic", async () => {
    const login = (password: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "admin@example.test", password },
      });
    const [first, second] = await Promise.all([
      login("correct horse battery staple"),
      login("correct horse battery staple"),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const newPasswordHash = await hash("rotated horse battery staple", 12);

    await expect(
      store.rotateUserPasswordAndAudit(store.users[0]!.id, newPasswordHash, {
        reason: "Test password reset",
        requestId: "password-reset-test",
      }),
    ).resolves.toMatchObject({ updated: true });

    for (const accessToken of [
      first.json().accessToken as string,
      second.json().accessToken as string,
    ]) {
      const response = await app.inject({
        url: "/api/v1/auth/me",
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("SESSION_REVOKED");
    }
    const oldPassword = await login("correct horse battery staple");
    const wrongPassword = await login("definitely incorrect password");
    expect(oldPassword.statusCode).toBe(401);
    expect(oldPassword.json().error).toEqual(wrongPassword.json().error);
    expect((await login("rotated horse battery staple")).statusCode).toBe(200);
    const audit = store.audits.find(
      (event) => event.action === "identity.password_rotated",
    );
    expect(audit).toMatchObject({
      actorType: "system",
      entityId: store.users[0]!.id,
      metadata: { reason: "Test password reset" },
    });
    expect(JSON.stringify(audit)).not.toContain(newPasswordHash);
  });

  it("limits login attempts for the same normalized account", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: {
          email:
            attempt % 2 === 0
              ? "MISSING@EXAMPLE.TEST"
              : " missing@example.test ",
          password: "incorrect password",
        },
      });
      expect(response.statusCode).toBe(401);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "missing@example.test",
        password: "incorrect password",
      },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("RATE_LIMITED");
    expect(store.loginFailures).toHaveLength(11);
    expect(
      store.loginFailures.filter((event) => event.reason === "RATE_LIMITED"),
    ).toHaveLength(1);
    expect(
      new Set(store.loginFailures.map((event) => event.accountKey)).size,
    ).toBe(1);
  });
  it("denies a viewer mutation", async () => {
    const viewer = issueTestToken(store.users[1]!);
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/screens",
      headers: { authorization: `Bearer ${viewer}` },
      payload: { name: "Lobby" },
    });
    expect(r.statusCode).toBe(403);
  });
  it("exposes organization-wide location classifications without claiming scoped authorization", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/locations",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Main campus" },
    });
    expect(created.statusCode).toBe(201);
    const location = created.json();

    const classified = await app.inject({
      method: "POST",
      url: "/api/v1/screens",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "Lobby",
        location: "Legacy lobby",
        locationId: location.id,
      },
    });
    expect(classified.statusCode).toBe(201);
    expect(classified.json()).toMatchObject({
      location: "Legacy lobby",
      locationId: location.id,
      locationName: "Main campus",
    });

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/v1/locations/${location.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Main building" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({
      id: location.id,
      name: "Main building",
    });

    const viewer = issueTestToken(store.users[1]!);
    const listed = await app.inject({
      url: "/api/v1/locations",
      headers: { authorization: `Bearer ${viewer}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      authorizationScope: "organization-role",
      data: [{ id: location.id, name: "Main building" }],
    });
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/locations",
      headers: { authorization: `Bearer ${viewer}` },
      payload: { name: "Denied" },
    });
    expect(denied.statusCode).toBe(403);

    const inUse = await app.inject({
      method: "DELETE",
      url: `/api/v1/locations/${location.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json().error.code).toBe("RESOURCE_IN_USE");

    const unclassified = await app.inject({
      method: "PATCH",
      url: `/api/v1/screens/${classified.json().id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { locationId: null },
    });
    expect(unclassified.statusCode).toBe(200);
    expect(unclassified.json()).toMatchObject({ location: "Legacy lobby" });
    expect(unclassified.json()).not.toHaveProperty("locationId");
    expect(unclassified.json()).not.toHaveProperty("locationName");

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/locations/${location.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(removed.statusCode).toBe(204);
  });

  it("rejects cross-tenant screen classifications without partial writes", async () => {
    store.locations.push({
      id: "00000000-0000-4000-8000-000000000099",
      organizationId: "org-b",
      name: "Foreign",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/screens",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "Wrong tenant",
        locationId: "00000000-0000-4000-8000-000000000099",
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("INVALID_LOCATION");
    expect(store.screens).toEqual([]);
    expect(store.audits).toEqual([]);
  });
  it("persists distinct server-owned IDs for audited mutations", async () => {
    const hostileRequestId = "attacker-chosen-duplicate";
    const createScreen = (name: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/screens",
        headers: {
          authorization: `Bearer ${token}`,
          "x-request-id": hostileRequestId,
        },
        payload: {
          name,
          location: "Lobby",
          orientation: "landscape",
          resolution: "1920x1080",
          tags: [],
        },
      });

    const responses = await Promise.all([
      createScreen("Request ID one"),
      createScreen("Request ID two"),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([
      201, 201,
    ]);
    const requestIds = store.audits
      .filter((event) => event.action === "screen.created")
      .map((event) => event.requestId);
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(requestIds[1]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(requestIds[0]).not.toBe(requestIds[1]);
    expect(requestIds).not.toContain(hostileRequestId);
  });

  it("does not expose a different organization's screen", async () => {
    await store.createScreen("org-b", {
      name: "Secret",
      location: "",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const r = await app.inject({
      url: "/api/v1/screens",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.json().data).toEqual([]);
  });
  it("accepts Prisma-style opaque CUID route identifiers", async () => {
    const r = await app.inject({
      url: "/api/v1/screens/cmh5w8x9a0001sgscreen",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(404);
  });
  it("does not revive sessions after disablement or a role demote-restore cycle", async () => {
    await store.disableUserAndAudit(store.users[0]!.id, {
      reason: "Test offboarding",
    });
    const disabled = await app.inject({
      url: "/api/v1/screens",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(disabled.statusCode).toBe(401);
    expect(disabled.json().error.code).toBe("SESSION_REVOKED");

    const viewerToken = issueTestToken(store.users[1]!);
    await store.changeMembershipRoleAndAudit(
      "org-a",
      store.users[1]!.id,
      "ADMIN",
      { reason: "Temporary promotion" },
    );
    await store.changeMembershipRoleAndAudit(
      "org-a",
      store.users[1]!.id,
      "VIEWER",
      { reason: "Restore original role" },
    );
    const restored = await app.inject({
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(restored.statusCode).toBe(401);
    expect(restored.json().error.code).toBe("SESSION_REVOKED");
  });

  it("marks management responses as non-cacheable", async () => {
    const response = await app.inject({
      url: "/api/v1/screens",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("persists screen metadata updates without exposing internal credentials", async () => {
    const created = await store.createScreen("org-a", {
      name: "Lobby",
      location: "First floor",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/screens/${created.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Main Lobby" },
    });
    expect(response.statusCode).toBe(200);
    expect((await store.getScreen("org-a", created.id))?.name).toBe(
      "Main Lobby",
    );
  });

  it("preserves invalid-asset errors from the transactional playlist write", async () => {
    const asset = await store.createMedia("org-a", {
      name: "Concurrent removal",
      kind: "image",
      mimeType: "image/png",
      url: "https://media.example.test/concurrent.png",
      checksumSha256: "a".repeat(64),
      sizeBytes: 3,
    });
    store.createPlaylistAndAudit = async () => ({
      created: false,
      reason: "INVALID_ASSET",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/playlists",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "Concurrent playlist",
        description: "",
        items: [{ assetId: asset.id, position: 0, durationSeconds: 15 }],
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("INVALID_ASSET");
    expect(store.playlists).toEqual([]);
  });

  it("does not fall back to the split audit API for ordinary mutations", async () => {
    store.audit = async () => {
      throw new Error("split audit API must not be called");
    };

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/screens",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "Atomic screen",
        location: "Lobby",
        orientation: "landscape",
        resolution: "1920x1080",
        tags: [],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(store.screens).toHaveLength(1);
    expect(store.audits).toMatchObject([
      {
        action: "screen.created",
        entityType: "screen",
        entityId: response.json().id,
      },
    ]);
  });
});

describe("immutable ordinary release publication", () => {
  const schedulePayload = (playlistId: string, screenId: string) => ({
    playlistId,
    name: "School day",
    priority: "normal" as const,
    startsAt: "2026-09-14T00:00:00.000Z",
    endsAt: "2026-09-15T00:00:00.000Z",
    timezone: "America/New_York",
    daysOfWeek: [1],
    dailyStartMinutes: 9 * 60,
    dailyEndMinutes: 17 * 60,
    enabled: true,
    screenIds: [screenId],
  });

  it("enforces the release capability compatibility matrix", async () => {
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
      sizeBytes: 3,
    });
    const playlist = await store.createPlaylist("org-a", {
      name: "Role matrix",
      description: "",
      items: [
        { id: "ignored", assetId: asset.id, position: 0, durationSeconds: 15 },
      ],
    });

    let publishedScheduleId = "";
    for (const role of ["OWNER", "ADMIN", "PUBLISHER"] as const) {
      store.users[0]!.role = role;
      const roleToken = issueTestToken(store.users[0]!);
      const publication = await app.inject({
        method: "POST",
        url: "/api/v1/schedules",
        headers: { authorization: `Bearer ${roleToken}` },
        payload: {
          ...schedulePayload(playlist.id, screen.id),
          name: `${role} publication`,
        },
      });
      expect(publication.statusCode).toBe(201);
      publishedScheduleId ||= publication.json().id;
      const withdrawal = await app.inject({
        method: "DELETE",
        url: `/api/v1/schedules/${publication.json().id}`,
        headers: { authorization: `Bearer ${roleToken}` },
      });
      expect(withdrawal.statusCode).toBe(204);
    }

    store.users[0]!.role = "VIEWER";
    const viewerToken = issueTestToken(store.users[0]!);
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/schedules",
      headers: { authorization: `Bearer ${viewerToken}` },
      payload: {
        ...schedulePayload(playlist.id, screen.id),
        name: "Viewer publication",
      },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("FORBIDDEN");
    const deniedWithdrawal = await app.inject({
      method: "DELETE",
      url: `/api/v1/schedules/${publishedScheduleId}`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(deniedWithdrawal.statusCode).toBe(403);
    expect(deniedWithdrawal.json().error.code).toBe("FORBIDDEN");
    expect(store.schedules).toHaveLength(3);
    expect(store.releaseAssignments).toHaveLength(6);
    expect(store.audits).toHaveLength(6);
  });

  it("atomically publishes a frozen release, assignment, schedule, and audit", async () => {
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
      sizeBytes: 3,
    });
    const playlist = await store.createPlaylist("org-a", {
      name: "Lobby playlist",
      description: "",
      items: [
        { id: "ignored", assetId: asset.id, position: 0, durationSeconds: 15 },
      ],
    });
    store.audit = async () => {
      throw new Error("standalone audit must not be used for publication");
    };

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/schedules",
      headers: { authorization: `Bearer ${token}` },
      payload: schedulePayload(playlist.id, screen.id),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      playlistId: playlist.id,
      releaseId: store.releases[0]!.id,
      assignmentId: store.releaseAssignments[0]!.id,
    });
    expect(store.releases[0]!.items[0]!.asset).toMatchObject({
      id: asset.id,
      url: asset.url,
      checksumSha256: asset.checksumSha256,
    });
    expect(store.audits).toContainEqual(
      expect.objectContaining({
        action: "release.published",
        entityId: store.releases[0]!.id,
        metadata: expect.objectContaining({
          assignmentId: store.releaseAssignments[0]!.id,
          digestSha256: store.releases[0]!.digestSha256,
        }),
      }),
    );
  });

  it("reuses an identical active assignment instead of publishing a conflict", async () => {
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
      sizeBytes: 3,
    });
    const playlist = await store.createPlaylist("org-a", {
      name: "Lobby playlist",
      description: "",
      items: [
        { id: "ignored", assetId: asset.id, position: 0, durationSeconds: 15 },
      ],
    });
    const request = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/schedules",
        headers: { authorization: `Bearer ${token}` },
        payload: schedulePayload(playlist.id, screen.id),
      });

    const first = await request();
    const second = await request();

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toMatchObject({
      id: first.json().id,
      releaseId: first.json().releaseId,
      assignmentId: first.json().assignmentId,
    });
    expect(store.schedules).toHaveLength(1);
    expect(store.releases).toHaveLength(1);
    expect(store.releaseAssignments).toHaveLength(1);
    expect(store.audits).toHaveLength(1);
  });

  it("reports a conflict instead of deleting published source records", async () => {
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
      sizeBytes: 3,
    });
    const playlist = await store.createPlaylist("org-a", {
      name: "Protected source",
      description: "",
      items: [
        { id: "ignored", assetId: asset.id, position: 0, durationSeconds: 15 },
      ],
    });
    const publication = await app.inject({
      method: "POST",
      url: "/api/v1/schedules",
      headers: { authorization: `Bearer ${token}` },
      payload: schedulePayload(playlist.id, screen.id),
    });
    expect(publication.statusCode).toBe(201);

    for (const url of [
      `/api/v1/media/${asset.id}`,
      `/api/v1/playlists/${playlist.id}`,
    ]) {
      const response = await app.inject({
        method: "DELETE",
        url,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("RESOURCE_IN_USE");
    }
    expect(await store.getMedia("org-a", asset.id)).not.toBeNull();
    expect(await store.getPlaylist("org-a", playlist.id)).not.toBeNull();
    expect(store.releases).toHaveLength(1);

    const screenDeletion = await app.inject({
      method: "DELETE",
      url: `/api/v1/screens/${screen.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(screenDeletion.statusCode).toBe(204);
    expect(await store.getScreen("org-a", screen.id)).toBeNull();
    expect(store.releaseAssignments[0]!.screenIds).toEqual([screen.id]);
  });

  it("fails closed without partially publishing empty or off-policy content", async () => {
    const screen = await store.createScreen("org-a", {
      name: "Lobby",
      location: "",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const empty = await store.createPlaylist("org-a", {
      name: "Empty",
      description: "",
      items: [],
    });
    const emptyResponse = await app.inject({
      method: "POST",
      url: "/api/v1/schedules",
      headers: { authorization: `Bearer ${token}` },
      payload: schedulePayload(empty.id, screen.id),
    });
    expect(emptyResponse.statusCode).toBe(422);
    expect(emptyResponse.json().error.code).toBe("EMPTY_RELEASE");

    const asset = await store.createMedia("org-a", {
      name: "Off policy",
      kind: "image",
      mimeType: "image/png",
      url: "https://legacy.example.test/image.png",
      checksumSha256: "b".repeat(64),
      sizeBytes: 3,
    });
    const offPolicy = await store.createPlaylist("org-a", {
      name: "Off policy",
      description: "",
      items: [
        { id: "ignored", assetId: asset.id, position: 0, durationSeconds: 15 },
      ],
    });
    const policyResponse = await app.inject({
      method: "POST",
      url: "/api/v1/schedules",
      headers: { authorization: `Bearer ${token}` },
      payload: schedulePayload(offPolicy.id, screen.id),
    });
    expect(policyResponse.statusCode).toBe(422);
    expect(policyResponse.json().error.code).toBe("MEDIA_ORIGIN_NOT_ALLOWED");
    expect(store.schedules).toEqual([]);
    expect(store.releases).toEqual([]);
    expect(store.releaseAssignments).toEqual([]);
    expect(store.audits).toEqual([]);
  });

  it("rejects expired, unsupported, and oversized aggregate releases atomically", async () => {
    const screen = await store.createScreen("org-a", {
      name: "Lobby",
      location: "",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const publish = (playlistId: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/schedules",
        headers: { authorization: `Bearer ${token}` },
        payload: schedulePayload(playlistId, screen.id),
      });
    const createSingleAssetPlaylist = async (
      name: string,
      overrides: Partial<Parameters<MemoryStore["createMedia"]>[1]>,
    ) => {
      const asset = await store.createMedia("org-a", {
        name,
        kind: "image",
        mimeType: "image/png",
        url: `https://media.example.test/${name}.png`,
        checksumSha256: "d".repeat(64),
        sizeBytes: 1,
        ...overrides,
      });
      return store.createPlaylist("org-a", {
        name,
        description: "",
        items: [
          {
            id: "ignored",
            assetId: asset.id,
            position: 0,
            durationSeconds: 10,
          },
        ],
      });
    };

    const expired = await createSingleAssetPlaylist("Expired", {
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    const expiredResponse = await publish(expired.id);
    expect(expiredResponse.statusCode).toBe(422);
    expect(expiredResponse.json().error.code).toBe("MEDIA_EXPIRED");

    const unsupported = await createSingleAssetPlaylist("Unsupported", {
      kind: "web",
      mimeType: "text/html",
    });
    const unsupportedResponse = await publish(unsupported.id);
    expect(unsupportedResponse.statusCode).toBe(422);
    expect(unsupportedResponse.json().error.code).toBe(
      "MEDIA_TYPE_NOT_SUPPORTED",
    );

    const aggregateAssets = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        store.createMedia("org-a", {
          name: `Large ${index}`,
          kind: "video",
          mimeType: "video/mp4",
          url: `https://media.example.test/large-${index}.mp4`,
          checksumSha256: String(index).repeat(64),
          sizeBytes: 128 * 1024 * 1024,
        }),
      ),
    );
    const aggregate = await store.createPlaylist("org-a", {
      name: "Aggregate too large",
      description: "",
      items: aggregateAssets.map((asset, position) => ({
        id: "ignored",
        assetId: asset.id,
        position,
        durationSeconds: 10,
      })),
    });
    const aggregateResponse = await publish(aggregate.id);
    expect(aggregateResponse.statusCode).toBe(422);
    expect(aggregateResponse.json().error.code).toBe("RELEASE_TOO_LARGE");
    expect(store.schedules).toEqual([]);
    expect(store.releases).toEqual([]);
    expect(store.releaseAssignments).toEqual([]);
    expect(store.audits).toEqual([]);
  });
});

describe("device lifecycle", () => {
  it("retries pairing-code collisions with a bounded allocation loop", async () => {
    const create = store.tryCreatePairingAndAudit.bind(store);
    let attempts = 0;
    store.tryCreatePairingAndAudit = async (...arguments_) => {
      attempts += 1;
      if (attempts < 3) return { created: false, reason: "CODE_COLLISION" };
      return create(...arguments_);
    };

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/pairing-codes",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().code).toMatch(/^\d{6}$/);
    expect(attempts).toBe(3);
  });

  it("fails safely after exhausting pairing-code allocation retries", async () => {
    let attempts = 0;
    store.tryCreatePairingAndAudit = async () => {
      attempts += 1;
      return { created: false, reason: "CODE_COLLISION" };
    };

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/pairing-codes",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("PAIRING_CODE_SPACE_EXHAUSTED");
    expect(attempts).toBe(8);
  });

  it("stops pairing-code allocation when transaction-time authority is lost", async () => {
    let attempts = 0;
    store.tryCreatePairingAndAudit = async () => {
      attempts += 1;
      return { created: false, reason: "FORBIDDEN" };
    };

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/pairing-codes",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
    expect(attempts).toBe(1);
  });

  it("limits repeated guesses of the same pairing code", async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/device/pair",
        payload: {
          code: "123456",
          device: {
            installationId: `installation-${attempt}`,
            model: "Test player",
            osVersion: "14",
            playerVersion: "0.1.0",
          },
        },
      });
      expect(response.statusCode).toBe(404);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/api/v1/device/pair",
      payload: {
        code: "123456",
        device: {
          installationId: "installation-final",
          model: "Test player",
          osVersion: "14",
          playerVersion: "0.1.0",
        },
      },
    });
    expect(limited.statusCode).toBe(429);
  });
  it("pairs, heartbeats, and receives a signed offline-safe manifest", async () => {
    const code = (
      await app.inject({
        method: "POST",
        url: "/api/v1/pairing-codes",
        headers: { authorization: `Bearer ${token}` },
      })
    ).json().code;
    const paired = await app.inject({
      method: "POST",
      url: "/api/v1/device/pair",
      payload: {
        code,
        device: {
          installationId: "installation-123",
          model: "Onn 4K Pro",
          osVersion: "14",
          playerVersion: "0.1.0",
        },
      },
    });
    expect(paired.statusCode).toBe(201);
    const credentials = paired.json();
    expect(credentials.apiBaseUrl).toBe(
      "https://signage.example.test/api/v1/device",
    );
    const headers = {
      "x-screen-id": credentials.screenId,
      "x-device-token": credentials.deviceToken,
    };
    const beat = await app.inject({
      method: "POST",
      url: "/api/v1/device/heartbeat",
      headers,
      payload: {
        installationId: "installation-123",
        playerVersion: "0.1.0",
        uptimeSeconds: 60,
        freeStorageBytes: 1_000_000,
        networkType: "ethernet",
        occurredAt: new Date().toISOString(),
      },
    });
    expect(beat.statusCode).toBe(200);
    const manifest = await app.inject({
      url: "/api/v1/device/manifest",
      headers,
    });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json()).toMatchObject({
      screenId: credentials.screenId,
      priority: "normal",
      withdrawn: true,
      items: [],
    });
    expect(manifest.json().signature).toBeTypeOf("string");
    expect(manifest.json().signatureAlgorithm).toBe("Ed25519");
    expect(credentials.manifestVerificationKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const screens = await app.inject({
      url: "/api/v1/screens",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(screens.body).not.toContain("deviceTokenHash");
  });
  it("claims a device and records its audit atomically", async () => {
    const code = (
      await app.inject({
        method: "POST",
        url: "/api/v1/pairing-codes",
        headers: { authorization: `Bearer ${token}` },
      })
    ).json().code;
    store.audit = async () => {
      throw new Error("standalone audit must not be used by device claim");
    };

    const paired = await app.inject({
      method: "POST",
      url: "/api/v1/device/pair",
      payload: {
        code,
        device: {
          installationId: "atomic-claim-device",
          model: "Test player",
          osVersion: "14",
          playerVersion: "0.1.0",
        },
      },
    });
    expect(paired.statusCode).toBe(201);
    expect(store.audits).toContainEqual(
      expect.objectContaining({
        action: "device.paired",
        entityId: paired.json().screenId,
        metadata: { installationId: "atomic-claim-device" },
      }),
    );
  });
  it("retains a stable semantic version across routine manifest polls", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-14T13:30:00.000Z"));
    const device = await pairDevice("stable-release-device");
    await scheduledPlaylist(device.screenId);

    const first = (
      await app.inject({
        url: "/api/v1/device/manifest",
        headers: device.headers,
      })
    ).json();
    vi.setSystemTime(new Date("2026-09-14T13:31:00.000Z"));
    const second = (
      await app.inject({
        url: "/api/v1/device/manifest",
        headers: device.headers,
      })
    ).json();

    expect(first).toMatchObject({ withdrawn: false, priority: "normal" });
    expect(first.items).toHaveLength(1);
    expect(second.version).toBe(first.version);
    expect(second.generatedAt).not.toBe(first.generatedAt);
    expect(second.validUntil).not.toBe(first.validUntil);
    expect(capabilityClaims(first.items[0].asset.url).expiresAt).toBe(
      first.validUntil,
    );
  });

  it("publishes a signed withdrawal when a schedule no longer applies", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-14T13:30:00.000Z"));
    const device = await pairDevice("withdrawal-device");
    const initialBlank = (
      await app.inject({
        url: "/api/v1/device/manifest",
        headers: device.headers,
      })
    ).json();
    const schedule = await scheduledPlaylist(device.screenId);
    const scheduled = (
      await app.inject({
        url: "/api/v1/device/manifest",
        headers: device.headers,
      })
    ).json();
    const scheduledMedia = new URL(scheduled.items[0].asset.url);
    const beforeWithdrawal = await app.inject({
      url: `${scheduledMedia.pathname}${scheduledMedia.search}`,
    });
    expect(beforeWithdrawal.statusCode).toBe(503);
    const deletion = await app.inject({
      method: "DELETE",
      url: `/api/v1/schedules/${schedule.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deletion.statusCode).toBe(204);
    const afterWithdrawal = await app.inject({
      url: `${scheduledMedia.pathname}${scheduledMedia.search}`,
    });
    expect(afterWithdrawal.statusCode).toBe(404);
    const withdrawn = (
      await app.inject({
        url: "/api/v1/device/manifest",
        headers: device.headers,
      })
    ).json();

    expect(scheduled).toMatchObject({ withdrawn: false });
    expect(scheduled.items).toHaveLength(1);
    expect(withdrawn).toMatchObject({
      screenId: device.screenId,
      priority: "normal",
      withdrawn: true,
      items: [],
      signatureAlgorithm: "Ed25519",
    });
    expect(withdrawn.signature).toBeTypeOf("string");
    expect(withdrawn.version).not.toBe(scheduled.version);
    expect(withdrawn.version).toBe(initialBlank.version);
    expect(store.releases).toHaveLength(1);
    expect(store.releaseAssignments.map((x) => x.state)).toEqual([
      "ASSIGNED",
      "WITHDRAWN",
    ]);
  });

  it("plays only frozen release facts after source and schedule mutation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-14T13:30:00.000Z"));
    const device = await pairDevice("immutable-release-device");
    const schedule = await scheduledPlaylist(device.screenId);
    const original = (
      await app.inject({
        url: "/api/v1/device/manifest",
        headers: device.headers,
      })
    ).json();

    store.playlists = [];
    store.media = [];
    const mutableSchedule = store.schedules.find((x) => x.id === schedule.id)!;
    mutableSchedule.priority = "priority";
    mutableSchedule.endsAt = "2026-09-14T13:00:00.000Z";
    mutableSchedule.screenIds = [];

    const afterSourceMutation = (
      await app.inject({
        url: "/api/v1/device/manifest",
        headers: device.headers,
      })
    ).json();
    expect(afterSourceMutation).toMatchObject({
      version: original.version,
      priority: "normal",
      withdrawn: false,
      playbackEndsAt: original.playbackEndsAt,
      items: original.items,
    });
  });

  it("withdraws legacy frozen web and unsupported media at manifest time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-14T13:30:00.000Z"));
    const device = await pairDevice("legacy-web-release-device");
    await scheduledPlaylist(device.screenId);
    const frozenAsset = store.releases[0]!.items[0]!.asset;

    frozenAsset.kind = "web";
    frozenAsset.mimeType = "text/html";
    const webManifest = (
      await app.inject({
        url: "/api/v1/device/manifest",
        headers: device.headers,
      })
    ).json();
    expect(webManifest).toMatchObject({
      priority: "normal",
      withdrawn: true,
      items: [],
    });

    frozenAsset.kind = "image";
    frozenAsset.mimeType = "image/svg+xml";
    const unsupportedManifest = (
      await app.inject({
        url: "/api/v1/device/manifest",
        headers: device.headers,
      })
    ).json();
    expect(unsupportedManifest).toMatchObject({
      priority: "normal",
      withdrawn: true,
      items: [],
    });

    frozenAsset.mimeType = "image/png";
    frozenAsset.url = "https://user:secret@media.example.test/legacy.png";
    const credentialedUrlManifest = (
      await app.inject({
        url: "/api/v1/device/manifest",
        headers: device.headers,
      })
    ).json();
    expect(credentialedUrlManifest).toMatchObject({
      priority: "normal",
      withdrawn: true,
      items: [],
    });
  });

  it("withdraws an entire frozen release when any item becomes ineligible", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-14T13:30:00.000Z"));
    const device = await pairDevice("whole-release-policy-device");
    const assets = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        store.createMedia("org-a", {
          name: `Frozen ${index}`,
          kind: "image",
          mimeType: "image/png",
          url: `https://media.example.test/frozen-${index}.png`,
          checksumSha256: index.toString(16).repeat(64),
          sizeBytes: 1,
        }),
      ),
    );
    const playlist = await store.createPlaylist("org-a", {
      name: "Whole frozen release",
      description: "",
      items: assets.map((asset, position) => ({
        id: "ignored",
        assetId: asset.id,
        position,
        durationSeconds: 10 + position,
      })),
    });
    const publication = await store.publishScheduleAndAudit(
      "org-a",
      {
        playlistId: playlist.id,
        name: "Whole release schedule",
        priority: "normal",
        startsAt: "2026-09-14T00:00:00.000Z",
        endsAt: "2026-09-15T00:00:00.000Z",
        timezone: "America/New_York",
        daysOfWeek: [1],
        dailyStartMinutes: 9 * 60,
        dailyEndMinutes: 17 * 60,
        enabled: true,
        screenIds: [device.screenId],
      },
      { actorUserId: store.users[0]!.id },
      { mediaAllowedOrigins: ["https://media.example.test"] },
    );
    expect(publication.published).toBe(true);

    const readManifest = async () =>
      (
        await app.inject({
          url: "/api/v1/device/manifest",
          headers: device.headers,
        })
      ).json();
    const initial = await readManifest();
    expect(initial).toMatchObject({ withdrawn: false });
    expect(
      initial.items.map((item: { asset: { name: string } }) => item.asset.name),
    ).toEqual(assets.map((asset) => asset.name));

    const original = { ...store.releases[0]!.items[1]!.asset };
    const corruptions = [
      { expiresAt: "2026-09-14T13:29:59.000Z" },
      { url: "https://other.example.test/frozen-1.png" },
      { url: "https://user:secret@media.example.test/frozen-1.png" },
      { url: "not-a-url" },
      { kind: "web" as const, mimeType: "text/html" },
      { checksumSha256: "invalid" },
      { sizeBytes: 0 },
    ];
    for (const corruption of corruptions) {
      store.releases[0]!.items[1]!.asset = {
        ...original,
        ...corruption,
      };
      expect(await readManifest()).toMatchObject({
        priority: "normal",
        withdrawn: true,
        items: [],
      });
    }

    for (const item of store.releases[0]!.items)
      item.asset.sizeBytes = MEDIA_MAX_ASSET_BYTES;
    expect(await readManifest()).toMatchObject({
      priority: "normal",
      withdrawn: true,
      items: [],
    });
  });

  it("carries the frozen asset expiry in the signed manifest", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-14T13:30:00.000Z"));
    const device = await pairDevice("expiring-release-device");
    await scheduledPlaylist(device.screenId);
    const expiresAt = "2026-09-14T13:32:00.000Z";
    store.releases[0]!.items[0]!.asset.expiresAt = expiresAt;

    const manifest = (
      await app.inject({
        url: "/api/v1/device/manifest",
        headers: device.headers,
      })
    ).json();
    expect(manifest.items[0].asset.expiresAt).toBe(expiresAt);
    expect(capabilityClaims(manifest.items[0].asset.url)).toMatchObject({
      assignmentId: store.releaseAssignments[0]!.id,
      assignmentDigestSha256: store.releaseAssignments[0]!.digestSha256,
      expiresAt,
    });
  });

  it("ignores legacy schedules that have no immutable release", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-14T13:30:00.000Z"));
    const device = await pairDevice("empty-playlist-device");
    const playlist = await store.createPlaylist("org-a", {
      name: "Empty lobby",
      description: "",
      items: [],
    });
    await store.createSchedule("org-a", {
      playlistId: playlist.id,
      name: "Empty school day",
      priority: "priority",
      startsAt: "2026-09-14T00:00:00.000Z",
      endsAt: "2026-09-15T00:00:00.000Z",
      timezone: "America/New_York",
      daysOfWeek: [1],
      dailyStartMinutes: 9 * 60,
      dailyEndMinutes: 17 * 60,
      enabled: true,
      screenIds: [device.screenId],
    });

    const manifest = (
      await app.inject({
        url: "/api/v1/device/manifest",
        headers: device.headers,
      })
    ).json();
    expect(manifest).toMatchObject({
      priority: "normal",
      withdrawn: true,
      items: [],
      signatureAlgorithm: "Ed25519",
    });
    expect(manifest).not.toHaveProperty("playbackEndsAt");
  });

  it("rejects publication when every scheduled asset is expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-14T13:30:00.000Z"));
    const device = await pairDevice("expired-playlist-device");
    const asset = await store.createMedia("org-a", {
      name: "Expired welcome",
      kind: "image",
      mimeType: "image/png",
      url: "https://media.example.test/expired.png",
      checksumSha256: "b".repeat(64),
      sizeBytes: 1024,
      expiresAt: "2026-09-14T13:29:00.000Z",
    });
    const playlist = await store.createPlaylist("org-a", {
      name: "Expired lobby",
      description: "",
      items: [
        { id: "ignored", assetId: asset.id, position: 0, durationSeconds: 15 },
      ],
    });
    const publication = await store.publishScheduleAndAudit(
      "org-a",
      {
        playlistId: playlist.id,
        name: "Expired school day",
        priority: "normal",
        startsAt: "2026-09-14T00:00:00.000Z",
        endsAt: "2026-09-15T00:00:00.000Z",
        timezone: "America/New_York",
        daysOfWeek: [1],
        dailyStartMinutes: 9 * 60,
        dailyEndMinutes: 17 * 60,
        enabled: true,
        screenIds: [device.screenId],
      },
      { actorUserId: store.users[0]!.id },
      { mediaAllowedOrigins: ["https://media.example.test"] },
    );
    expect(publication).toEqual({
      published: false,
      reason: "ASSET_EXPIRED",
    });
    expect(store.schedules).toEqual([]);
    expect(store.releases).toEqual([]);
    expect(store.releaseAssignments).toEqual([]);
    expect(
      store.audits.filter((audit) => audit.action === "release.published"),
    ).toEqual([]);
  });

  it("publishes the selected schedule end separately from the envelope lease", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-14T13:58:00.000Z"));
    const device = await pairDevice("absolute-expiry-device");
    await scheduledPlaylist(device.screenId, {
      endsAt: "2026-09-14T13:59:00.000Z",
      dailyEndMinutes: 17 * 60,
    });

    const manifest = (
      await app.inject({
        url: "/api/v1/device/manifest",
        headers: device.headers,
      })
    ).json();
    expect(manifest.playbackEndsAt).toBe("2026-09-14T13:59:00.000Z");
    expect(manifest.validUntil).toBe("2026-09-14T14:03:00.000Z");
    expect(capabilityClaims(manifest.items[0].asset.url).expiresAt).toBe(
      manifest.playbackEndsAt,
    );
  });

  it("publishes the next daily playback boundary in its time zone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-14T13:58:00.000Z"));
    const device = await pairDevice("daily-expiry-device");
    await scheduledPlaylist(device.screenId, {
      endsAt: "2026-09-14T20:00:00.000Z",
      dailyEndMinutes: 10 * 60,
    });

    const manifest = (
      await app.inject({
        url: "/api/v1/device/manifest",
        headers: device.headers,
      })
    ).json();
    expect(manifest.playbackEndsAt).toBe("2026-09-14T14:00:00.000Z");
    expect(manifest.validUntil).toBe("2026-09-14T14:03:00.000Z");
    expect(capabilityClaims(manifest.items[0].asset.url).expiresAt).toBe(
      manifest.playbackEndsAt,
    );
  });

  it("signs the first valid post-gap instant for a nonexistent daily end", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-08T06:30:00.000Z"));
    const device = await pairDevice("spring-forward-device");
    await scheduledPlaylist(device.screenId, {
      startsAt: "2026-03-08T00:00:00.000Z",
      endsAt: "2026-03-09T00:00:00.000Z",
      daysOfWeek: [0],
      dailyStartMinutes: 60,
      dailyEndMinutes: 2 * 60 + 30,
    });

    const manifest = (
      await app.inject({
        url: "/api/v1/device/manifest",
        headers: device.headers,
      })
    ).json();
    expect(manifest).toMatchObject({
      withdrawn: false,
      playbackEndsAt: "2026-03-08T07:00:00.000Z",
      signatureAlgorithm: "Ed25519",
    });
  });

  it("does not reactivate a schedule in the repeated fall-back hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T05:15:00.000Z"));
    const device = await pairDevice("fall-back-device");
    await scheduledPlaylist(device.screenId, {
      startsAt: "2026-11-01T00:00:00.000Z",
      endsAt: "2026-11-02T00:00:00.000Z",
      daysOfWeek: [0],
      dailyStartMinutes: 30,
      dailyEndMinutes: 90,
    });

    const firstOccurrence = (
      await app.inject({
        url: "/api/v1/device/manifest",
        headers: device.headers,
      })
    ).json();
    expect(firstOccurrence).toMatchObject({
      withdrawn: false,
      playbackEndsAt: "2026-11-01T05:30:00.000Z",
    });

    vi.setSystemTime(new Date("2026-11-01T06:15:00.000Z"));
    const repeatedHour = (
      await app.inject({
        url: "/api/v1/device/manifest",
        headers: device.headers,
      })
    ).json();
    expect(repeatedHour).toMatchObject({ withdrawn: true, items: [] });
  });
  it("rejects bad device credentials", async () => {
    const r = await app.inject({
      url: "/api/v1/device/manifest",
      headers: {
        "x-screen-id": crypto.randomUUID(),
        "x-device-token": "wrong",
      },
    });
    expect(r.statusCode).toBe(401);
  });
});

describe("media trust boundary", () => {
  it("hides deprecated metadata registration unless explicitly enabled", async () => {
    app.config.legacyMediaRegistrationEnabled = false;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/media",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "Caller asserted object",
        kind: "image",
        mimeType: "image/png",
        url: "https://media.example.test/image.png",
        checksumSha256: "a".repeat(64),
        sizeBytes: 1,
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("MEDIA_REGISTRATION_DISABLED");
    expect(store.media).toEqual([]);
  });

  it("accepts only supported kind and MIME pairs and disables web content", async () => {
    for (const payload of [
      {
        name: "Disabled web content",
        kind: "web",
        mimeType: "text/html",
        url: "https://media.example.test/page.html",
      },
      {
        name: "Mismatched image",
        kind: "image",
        mimeType: "video/mp4",
        url: "https://media.example.test/image.mp4",
      },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/media",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          ...payload,
          checksumSha256: "a".repeat(64),
          sizeBytes: 1,
        },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe("MEDIA_TYPE_NOT_SUPPORTED");
    }
    expect(store.media).toEqual([]);
  });

  it("canonicalizes checksums and requires bounded, unexpired media", async () => {
    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/media",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "Canonical image",
        kind: "image",
        mimeType: "image/png",
        url: "https://media.example.test/image.png",
        checksumSha256: "A".repeat(64),
        sizeBytes: 128 * 1024 * 1024,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().checksumSha256).toBe("a".repeat(64));
    expect(accepted.json()).not.toHaveProperty("storageKey");
    const listed = await app.inject({
      url: "/api/v1/media",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data[0]).not.toHaveProperty("storageKey");

    const oversized = await app.inject({
      method: "POST",
      url: "/api/v1/media",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "Oversized image",
        kind: "image",
        mimeType: "image/png",
        url: "https://media.example.test/large.png",
        checksumSha256: "b".repeat(64),
        sizeBytes: 128 * 1024 * 1024 + 1,
      },
    });
    expect(oversized.statusCode).toBe(400);

    const expired = await app.inject({
      method: "POST",
      url: "/api/v1/media",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "Expired image",
        kind: "image",
        mimeType: "image/png",
        url: "https://media.example.test/expired.png",
        checksumSha256: "c".repeat(64),
        sizeBytes: 1,
        expiresAt: new Date(Date.now() - 1).toISOString(),
      },
    });
    expect(expired.statusCode).toBe(422);
    expect(expired.json().error.code).toBe("MEDIA_EXPIRY_INVALID");
  });

  it("rejects executable and non-HTTPS media URLs", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/media",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "Unsafe web content",
        kind: "web",
        mimeType: "text/html",
        url: "javascript:alert(1)",
        checksumSha256: "0".repeat(64),
        sizeBytes: 1,
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("MEDIA_URL_NOT_ALLOWED");
  });

  it("rejects HTTPS media when no origin has been explicitly allowed", async () => {
    app.config.mediaAllowedOrigins.length = 0;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/media",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "Unlisted image",
        kind: "image",
        mimeType: "image/png",
        url: "https://media.example.test/image.png",
        checksumSha256: "0".repeat(64),
        sizeBytes: 1,
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("MEDIA_ORIGIN_NOT_ALLOWED");
  });

  it("accepts only an exact allowed origin", async () => {
    const allowed = await app.inject({
      method: "POST",
      url: "/api/v1/media",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "Approved image",
        kind: "image",
        mimeType: "image/png",
        url: "https://media.example.test/assets/image.png?version=1",
        checksumSha256: "1".repeat(64),
        sizeBytes: 1,
      },
    });
    expect(allowed.statusCode).toBe(201);

    const sibling = await app.inject({
      method: "POST",
      url: "/api/v1/media",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "Sibling image",
        kind: "image",
        mimeType: "image/png",
        url: "https://sub.media.example.test/image.png",
        checksumSha256: "2".repeat(64),
        sizeBytes: 1,
      },
    });
    expect(sibling.statusCode).toBe(422);
    expect(sibling.json().error.code).toBe("MEDIA_ORIGIN_NOT_ALLOWED");
  });

  it("rejects embedded credentials even on an allowed origin", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/media",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "Credentialed image",
        kind: "image",
        mimeType: "image/png",
        url: "https://user:password@media.example.test/image.png",
        checksumSha256: "3".repeat(64),
        sizeBytes: 1,
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(
      "MEDIA_URL_CREDENTIALS_NOT_ALLOWED",
    );
  });

  it("ignores a legacy unpublished schedule with off-allowlist media", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-14T13:30:00.000Z"));
    const device = await pairDevice("legacy-origin-device");
    const asset = await store.createMedia("org-a", {
      name: "Legacy external image",
      kind: "image",
      mimeType: "image/png",
      url: "https://legacy.example.test/image.png",
      checksumSha256: "4".repeat(64),
      sizeBytes: 1,
    });
    const playlist = await store.createPlaylist("org-a", {
      name: "Legacy external playlist",
      description: "",
      items: [
        { id: "ignored", assetId: asset.id, position: 0, durationSeconds: 15 },
      ],
    });
    await store.createSchedule("org-a", {
      playlistId: playlist.id,
      name: "Legacy external schedule",
      priority: "normal",
      startsAt: "2026-09-14T00:00:00.000Z",
      endsAt: "2026-09-15T00:00:00.000Z",
      timezone: "America/New_York",
      daysOfWeek: [1],
      dailyStartMinutes: 9 * 60,
      dailyEndMinutes: 17 * 60,
      enabled: true,
      screenIds: [device.screenId],
    });

    const manifest = (
      await app.inject({
        url: "/api/v1/device/manifest",
        headers: device.headers,
      })
    ).json();
    expect(manifest).toMatchObject({
      priority: "normal",
      withdrawn: true,
      items: [],
      signatureAlgorithm: "Ed25519",
    });
  });
});

describe("emergency safety gate", () => {
  it("is disabled by default", async () => {
    const screen = await store.createScreen("org-a", {
      name: "Lobby",
      location: "",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/emergencies",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Test",
        message: "This is only a drill",
        targetScreenIds: [screen.id],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe("FEATURE_DISABLED");
  });

  it("activates and clears through the audited emergency boundary", async () => {
    app.config.emergencyPublishingEnabled = true;
    const screen = await store.createScreen("org-a", {
      name: "Lobby",
      location: "",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const activated = await app.inject({
      method: "POST",
      url: "/api/v1/emergencies",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Drill",
        message: "Atomic emergency test",
        targetScreenIds: [screen.id, screen.id],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(activated.statusCode).toBe(201);
    expect(activated.json().targetScreenIds).toEqual([screen.id]);
    expect(store.audits[0]).toMatchObject({
      organizationId: "org-a",
      actorUserId: store.users[0]!.id,
      action: "emergency.activated",
      entityType: "emergency",
      metadata: { targetCount: 1 },
    });

    const cleared = await app.inject({
      method: "POST",
      url: `/api/v1/emergencies/${activated.json().id}/clear`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().clearedAt).toBeTypeOf("string");
    expect(store.audits[1]).toMatchObject({
      organizationId: "org-a",
      actorUserId: store.users[0]!.id,
      action: "emergency.cleared",
      entityType: "emergency",
      entityId: activated.json().id,
    });
  });

  it("maps emergency authorization, target, and tenant failures safely", async () => {
    app.config.emergencyPublishingEnabled = true;
    const local = await store.createScreen("org-a", {
      name: "Local",
      location: "",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const foreign = await store.createScreen("org-b", {
      name: "Foreign",
      location: "",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const viewer = issueTestToken(store.users[1]!);
    const payload = {
      title: "Denied drill",
      message: "Must not activate",
      targetScreenIds: [local.id],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/emergencies",
      headers: { authorization: `Bearer ${viewer}` },
      payload,
    });
    expect(denied.statusCode).toBe(403);

    const invalidTarget = await app.inject({
      method: "POST",
      url: "/api/v1/emergencies",
      headers: { authorization: `Bearer ${token}` },
      payload: { ...payload, targetScreenIds: [local.id, foreign.id] },
    });
    expect(invalidTarget.statusCode).toBe(422);
    expect(invalidTarget.json().error.code).toBe("INVALID_SCREEN");
    expect(store.emergencies).toEqual([]);
    expect(store.audits).toEqual([]);

    const missingClear = await app.inject({
      method: "POST",
      url: "/api/v1/emergencies/foreign-emergency/clear",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missingClear.statusCode).toBe(404);
  });
});
