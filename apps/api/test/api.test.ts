import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  vi.useRealTimers();
});

const pairDevice = async (installationId: string) => {
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
  return store.createSchedule("org-a", {
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
  });
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
    await store.deleteSchedule("org-a", schedule.id);
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
  });

  it("publishes a signed withdrawal for an applicable empty playlist", async () => {
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

  it("publishes a signed withdrawal when every scheduled asset is expired", async () => {
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
    await store.createSchedule("org-a", {
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
