import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  managementPlaylist,
  managementSchedule,
  managementScreen,
} from "../src/routes/management-dto.js";
import type {
  PlaylistRecord,
  ScheduleRecord,
  ScreenRecord,
} from "../src/domain/types.js";
import { buildApp } from "../src/app.js";
import { MemoryStore } from "../src/store/memory.js";
import { randomToken, sha256 } from "../src/utils/crypto.js";

const timestamps = {
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

describe("authenticated management response contracts", () => {
  it("preserves player-reported screen fields without exposing credentials", () => {
    const record: ScreenRecord = {
      id: "screen-1",
      organizationId: "organization-1",
      name: "Lobby",
      location: "First floor",
      status: "online",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: ["public"],
      installationId: "private-installation",
      deviceTokenHash: "private-hash",
      model: "Player model",
      osVersion: "14",
      playerVersion: "1.2.3",
      manifestVersion: "manifest-7",
      nowPlayingAssetId: "asset-7",
      uptimeSeconds: 120,
      freeStorageBytes: 4096,
      networkType: "ethernet",
      lastSeenAt: "2026-01-02T00:00:00.000Z",
      credentialRevokedAt: "2026-01-01T12:00:00.000Z",
      credentialGeneration: 4,
      ...timestamps,
    };

    const result = managementScreen(record);

    expect(result).toEqual({
      id: "screen-1",
      name: "Lobby",
      location: "First floor",
      status: "online",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: ["public"],
      model: "Player model",
      osVersion: "14",
      playerVersion: "1.2.3",
      manifestVersion: "manifest-7",
      nowPlayingAssetId: "asset-7",
      uptimeSeconds: 120,
      freeStorageBytes: 4096,
      networkType: "ethernet",
      lastSeenAt: "2026-01-02T00:00:00.000Z",
      ...timestamps,
    });
    expect(result).not.toHaveProperty("nowPlaying");
    expect(result).not.toHaveProperty("organizationId");
    expect(result).not.toHaveProperty("installationId");
    expect(result).not.toHaveProperty("deviceTokenHash");
    expect(result).not.toHaveProperty("credentialRevokedAt");
    expect(result).not.toHaveProperty("credentialGeneration");
  });

  it("orders playlist items by their declared position", () => {
    const itemWithInternalField = {
      id: "item-2",
      assetId: "asset-2",
      position: 2,
      durationSeconds: 9,
      internalNote: "must not cross the response boundary",
    };
    const record: PlaylistRecord = {
      id: "playlist-1",
      organizationId: "organization-1",
      name: "Rotation",
      description: "Declared content order",
      items: [
        itemWithInternalField,
        { id: "item-0", assetId: "asset-0", position: 0, durationSeconds: 15 },
      ],
      ...timestamps,
    };

    expect(managementPlaylist(record)).toEqual({
      id: "playlist-1",
      name: "Rotation",
      description: "Declared content order",
      items: [
        { id: "item-0", assetId: "asset-0", position: 0, durationSeconds: 15 },
        { id: "item-2", assetId: "asset-2", position: 2, durationSeconds: 9 },
      ],
      ...timestamps,
    });
  });

  it("preserves configured schedule fields without deriving operational state", () => {
    const record: ScheduleRecord = {
      id: "schedule-1",
      organizationId: "organization-1",
      playlistId: "playlist-1",
      name: "Weekday rotation",
      priority: "campaign",
      startsAt: "2026-02-01T08:00:00.000Z",
      endsAt: "2026-03-01T08:00:00.000Z",
      timezone: "America/Chicago",
      daysOfWeek: [1, 2, 3, 4, 5],
      dailyStartMinutes: 480,
      dailyEndMinutes: 1020,
      enabled: true,
      screenIds: ["screen-1", "screen-2"],
      releaseId: "release-1",
      assignmentId: "assignment-1",
      ...timestamps,
    };

    expect(managementSchedule(record)).toEqual({
      id: "schedule-1",
      playlistId: "playlist-1",
      name: "Weekday rotation",
      priority: "campaign",
      startsAt: "2026-02-01T08:00:00.000Z",
      endsAt: "2026-03-01T08:00:00.000Z",
      timezone: "America/Chicago",
      daysOfWeek: [1, 2, 3, 4, 5],
      dailyStartMinutes: 480,
      dailyEndMinutes: 1020,
      enabled: true,
      screenIds: ["screen-1", "screen-2"],
      releaseId: "release-1",
      assignmentId: "assignment-1",
      ...timestamps,
    });
  });
});

describe("authenticated management routes", () => {
  let app: FastifyInstance;
  let store: MemoryStore;
  let authorization: string;

  beforeEach(async () => {
    store = new MemoryStore();
    store.users.push({
      id: "00000000-0000-4000-8000-000000000001",
      email: "owner@example.test",
      name: "Owner",
      passwordHash: "unused",
      organizationId: "organization-1",
      role: "OWNER",
      authenticationEpoch: 0,
      authorizationEpoch: 0,
    });
    app = await buildApp({
      store,
      jwtSecret: "management-contract-test-secret-longer-than-32-chars",
      manifestSigningPrivateKey: Buffer.alloc(32, 7).toString("base64url"),
      pairingCodePepper: "management-contract-test-secret-longer-than-32-chars",
      deviceAuthMode: "development-bearer",
      mediaAllowedOrigins: ["https://media.example.test"],
    });
    const sessionId = randomToken();
    store.userSessions.push({
      id: "00000000-0000-4000-8000-000000000002",
      organizationId: "organization-1",
      userId: store.users[0]!.id,
      tokenHash: sha256(sessionId),
      authenticationEpoch: 0,
      authorizationEpoch: 0,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: timestamps.createdAt,
    });
    authorization = `Bearer ${app.jwt.sign({
      sub: store.users[0]!.id,
      email: store.users[0]!.email,
      organizationId: "organization-1",
      role: "OWNER",
      sessionId,
    })}`;
  });

  afterEach(async () => {
    await app.close();
  });

  it("serves whitelisted screen, playlist, and schedule list DTOs", async () => {
    store.screens.push({
      id: "screen-1",
      organizationId: "organization-1",
      name: "Lobby",
      location: "First floor",
      status: "online",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
      installationId: "private-installation",
      deviceTokenHash: "private-hash",
      nowPlayingAssetId: "asset-1",
      ...timestamps,
    });
    store.playlists.push({
      id: "playlist-1",
      organizationId: "organization-1",
      name: "Rotation",
      description: "",
      items: [],
      ...timestamps,
    });
    store.schedules.push({
      id: "schedule-1",
      organizationId: "organization-1",
      playlistId: "playlist-1",
      name: "Configured window",
      priority: "normal",
      startsAt: "2026-02-01T08:00:00.000Z",
      timezone: "UTC",
      daysOfWeek: [],
      enabled: false,
      screenIds: ["screen-1"],
      ...timestamps,
    });

    const [screens, playlists, schedules] = await Promise.all([
      app.inject({
        url: "/api/v1/screens",
        headers: { authorization },
      }),
      app.inject({
        url: "/api/v1/playlists",
        headers: { authorization },
      }),
      app.inject({
        url: "/api/v1/schedules",
        headers: { authorization },
      }),
    ]);

    expect(screens.statusCode).toBe(200);
    expect(screens.json().data[0]).toMatchObject({
      id: "screen-1",
      nowPlayingAssetId: "asset-1",
    });
    expect(screens.json().data[0]).not.toHaveProperty("nowPlaying");
    expect(screens.body).not.toContain("private-installation");
    expect(screens.body).not.toContain("private-hash");
    expect(playlists.json().data).toEqual([
      expect.objectContaining({ id: "playlist-1", name: "Rotation" }),
    ]);
    expect(schedules.json().data).toEqual([
      expect.objectContaining({
        id: "schedule-1",
        enabled: false,
        screenIds: ["screen-1"],
      }),
    ]);
  });

  it("serves whitelisted screen create and update responses", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/screens",
      headers: { authorization },
      payload: { name: "Created screen" },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: "Created screen" });
    expect(created.json()).not.toHaveProperty("organizationId");

    const stored = store.screens.find(
      (screen) => screen.id === created.json().id,
    )!;
    stored.installationId = "private-installation";
    stored.deviceTokenHash = "private-hash";
    stored.credentialGeneration = 7;
    stored.credentialRevokedAt = "2026-01-03T00:00:00.000Z";
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/screens/${stored.id}`,
      headers: { authorization },
      payload: { name: "Updated screen" },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      id: stored.id,
      name: "Updated screen",
    });
    for (const field of [
      "organizationId",
      "installationId",
      "deviceTokenHash",
      "credentialGeneration",
      "credentialRevokedAt",
    ]) {
      expect(updated.json()).not.toHaveProperty(field);
    }
    expect(updated.body).not.toContain("private-installation");
    expect(updated.body).not.toContain("private-hash");
  });

  it("serves whitelisted playlist and reviewed publication responses", async () => {
    const createdPlaylist = await app.inject({
      method: "POST",
      url: "/api/v1/playlists",
      headers: { authorization },
      payload: { name: "Created playlist", description: "", items: [] },
    });

    expect(createdPlaylist.statusCode).toBe(201);
    expect(createdPlaylist.json()).toMatchObject({ name: "Created playlist" });
    expect(createdPlaylist.json()).not.toHaveProperty("organizationId");

    const screen = await store.createScreen("organization-1", {
      name: "Schedule target",
      location: "",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const asset = await store.createMedia("organization-1", {
      name: "Schedule asset",
      kind: "image",
      mimeType: "image/png",
      url: "https://media.example.test/schedule.png",
      checksumSha256: "a".repeat(64),
      sizeBytes: 3,
    });
    const playlist = await store.createPlaylist("organization-1", {
      name: "Schedule source",
      description: "",
      items: [
        { id: "ignored", assetId: asset.id, position: 0, durationSeconds: 15 },
      ],
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/release-candidates",
      headers: {
        authorization,
        "idempotency-key": crypto.randomUUID(),
      },
      payload: {
        playlistId: playlist.id,
        name: "Published schedule",
        priority: "normal",
        startsAt: "2030-01-01T00:00:00.000Z",
        timezone: "UTC",
        daysOfWeek: [],
        enabled: true,
        screenIds: [screen.id],
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      },
    });
    expect(created.statusCode).toBe(201);
    const candidate = created.json();
    const submit = await app.inject({
      method: "POST",
      url: `/api/v1/release-candidates/${candidate.id}/submit`,
      headers: { authorization, "idempotency-key": crypto.randomUUID() },
      payload: { digestSha256: candidate.digestSha256 },
    });
    expect(submit.statusCode).toBe(200);

    const approverId = "00000000-0000-4000-8000-000000000003";
    store.users.push({
      id: approverId,
      email: "approver@example.test",
      name: "Approver",
      passwordHash: "unused",
      organizationId: "organization-1",
      role: "ADMIN",
      authenticationEpoch: 0,
      authorizationEpoch: 0,
    });
    const approverSessionId = randomToken();
    store.userSessions.push({
      id: "00000000-0000-4000-8000-000000000004",
      organizationId: "organization-1",
      userId: approverId,
      tokenHash: sha256(approverSessionId),
      authenticationEpoch: 0,
      authorizationEpoch: 0,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: timestamps.createdAt,
    });
    const approverAuthorization = `Bearer ${app.jwt.sign({
      sub: approverId,
      email: "approver@example.test",
      organizationId: "organization-1",
      role: "ADMIN",
      sessionId: approverSessionId,
    })}`;
    const approval = await app.inject({
      method: "POST",
      url: `/api/v1/release-candidates/${candidate.id}/approve`,
      headers: {
        authorization: approverAuthorization,
        "idempotency-key": crypto.randomUUID(),
      },
      payload: { digestSha256: candidate.digestSha256 },
    });
    expect(approval.statusCode).toBe(200);
    const published = await app.inject({
      method: "POST",
      url: `/api/v1/release-candidates/${candidate.id}/publish`,
      headers: { authorization, "idempotency-key": crypto.randomUUID() },
      payload: { digestSha256: candidate.digestSha256 },
    });

    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({
      sourcePlaylistId: playlist.id,
      releaseId: expect.any(String),
      assignmentId: expect.any(String),
      state: "PUBLISHED",
      items: [
        {
          asset: {
            id: asset.id,
            url: "https://media.example.test/schedule.png",
          },
        },
      ],
    });
    for (const privateField of [
      "organizationId",
      "storageKey",
      "authenticationEpoch",
      "authorizationEpoch",
    ]) {
      expect(published.body).not.toContain(privateField);
    }
  });
});
