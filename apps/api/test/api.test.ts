import { beforeEach, describe, expect, it } from "vitest";
import { hash } from "bcryptjs";
import { buildApp } from "../src/app.js";
import { MemoryStore } from "../src/store/memory.js";
import type { FastifyInstance } from "fastify";
import { MemoryRateLimitBudget } from "../src/utils/rate-limit.js";

const secret = "test-secret-that-is-longer-than-thirty-two-characters";
const signingKey = Buffer.alloc(32, 7).toString("base64url");
let app: FastifyInstance;
let store: MemoryStore;
let token: string;
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
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      email: "viewer@example.test",
      name: "Viewer",
      passwordHash: await hash("correct horse battery staple", 4),
      organizationId: "org-a",
      role: "VIEWER",
    },
  );
  app = await buildApp({
    store,
    jwtSecret: secret,
    manifestSigningPrivateKey: signingKey,
    pairingCodePepper: secret,
  });
  token = app.jwt.sign({
    sub: store.users[0]!.id,
    email: store.users[0]!.email,
    organizationId: "org-a",
    role: "OWNER",
  });
});

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
      redis: redis as never,
      rateLimitBudget: new MemoryRateLimitBudget(),
    });
    const ready = await redisApp.inject({ url: "/health/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.body).toBe("");
    await redisApp.close();
  });
  it("returns safe validation errors", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "bad", password: "x" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("VALIDATION_ERROR");
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
  });
  it("denies a viewer mutation", async () => {
    const viewer = app.jwt.sign({
      sub: store.users[1]!.id,
      email: store.users[1]!.email,
      organizationId: "org-a",
      role: "VIEWER",
    });
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/screens",
      headers: { authorization: `Bearer ${viewer}` },
      payload: { name: "Lobby" },
    });
    expect(r.statusCode).toBe(403);
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
  it("revokes an existing token after a user is disabled or their role changes", async () => {
    store.users[0]!.disabledAt = new Date().toISOString();
    const disabled = await app.inject({
      url: "/api/v1/screens",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(disabled.statusCode).toBe(401);
    expect(disabled.json().error.code).toBe("SESSION_REVOKED");

    delete store.users[0]!.disabledAt;
    store.users[0]!.role = "VIEWER";
    const downgraded = await app.inject({
      url: "/api/v1/screens",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(downgraded.statusCode).toBe(401);
    expect(downgraded.json().error.code).toBe("SESSION_REVOKED");
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
});

describe("device lifecycle", () => {
  it("limits repeated guesses of the same pairing code", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
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
});
