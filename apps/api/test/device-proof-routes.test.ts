import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import {
  canonicalHeartbeatDigest,
  EMPTY_BODY_SHA256,
} from "../src/device-proof/canonical.js";
import { sha256Base64Url } from "../src/device-proof/crypto.js";
import { MemoryStore } from "../src/store/memory.js";

const jwtSecret = "test-secret-that-is-longer-than-thirty-two-characters";
const manifestSigningKey = Buffer.alloc(32, 7).toString("base64url");
const proofDomain = Buffer.from("ScreenGoblin device proof v1\0", "utf8");

interface ChallengeResponse {
  id: string;
  challenge: string;
  expiresAt: string;
}

interface ProofIdentity {
  algorithm: "ES256";
  publicKeySpki: string;
  keyId: string;
  securityLevel: "software";
}

interface PairingFixture {
  code: string;
  device: {
    installationId: string;
    model: string;
    osVersion: string;
    playerVersion: string;
  };
  identity: ProofIdentity;
  privateKey: KeyObject;
}

const signatureFor = (privateKey: KeyObject, challenge: string) =>
  sign(
    "sha256",
    Buffer.concat([proofDomain, Buffer.from(challenge, "base64url")]),
    privateKey,
  ).toString("base64url");

const proofHeaders = (
  screenId: string,
  keyId: string,
  challenge: ChallengeResponse,
  privateKey: KeyObject,
) => ({
  "x-screen-id": screenId,
  "x-device-key-id": keyId,
  "x-device-challenge-id": challenge.id,
  "x-device-challenge": challenge.challenge,
  "x-device-signature-format": "ES256-DER",
  "x-device-signature": signatureFor(privateKey, challenge.challenge),
});

describe("proof-v1 device routes", () => {
  let app: FastifyInstance;
  let store: MemoryStore;
  let ownerToken: string;

  beforeEach(async () => {
    store = new MemoryStore();
    store.users.push({
      id: "00000000-0000-4000-8000-000000000001",
      email: "owner@example.test",
      name: "Owner",
      passwordHash: "unused",
      organizationId: "org-a",
      role: "OWNER",
    });
    app = await buildApp({
      store,
      jwtSecret,
      manifestSigningPrivateKey: manifestSigningKey,
      pairingCodePepper: jwtSecret,
      deviceAuthMode: "proof-v1",
      mediaAllowedOrigins: ["https://media.example.test"],
    });
    ownerToken = app.jwt.sign({
      sub: store.users[0]!.id,
      email: store.users[0]!.email,
      organizationId: "org-a",
      role: "OWNER",
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const pairingFixture = async (): Promise<PairingFixture> => {
    const pairingCode = await app.inject({
      method: "POST",
      url: "/api/v1/pairing-codes",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(pairingCode.statusCode).toBe(201);

    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const spki = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
    const keyId = sha256Base64Url(spki);
    return {
      code: pairingCode.json<{ code: string }>().code,
      device: {
        installationId: keyId,
        model: "Proof route test player",
        osVersion: "14",
        playerVersion: "0.1.0",
      },
      identity: {
        algorithm: "ES256",
        publicKeySpki: spki.toString("base64url"),
        keyId,
        securityLevel: "software",
      },
      privateKey,
    };
  };

  const pair = async (fixture: PairingFixture) => {
    const request = {
      code: fixture.code,
      device: fixture.device,
      identity: fixture.identity,
    };
    const challengeResponse = await app.inject({
      method: "POST",
      url: "/api/v1/device/pair/challenge",
      payload: request,
    });
    expect(challengeResponse.statusCode).toBe(201);
    const challenge = challengeResponse.json<ChallengeResponse>();
    expect(challenge.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const remaining = Date.parse(challenge.expiresAt) - Date.now();
    expect(remaining).toBeGreaterThan(20_000);
    expect(remaining).toBeLessThanOrEqual(30_000);
    const payload = {
      ...request,
      pairingProof: {
        challengeId: challenge.id,
        challenge: challenge.challenge,
        keyId: fixture.identity.keyId,
        signatureFormat: "ES256-DER" as const,
        signature: signatureFor(fixture.privateKey, challenge.challenge),
      },
    };
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/device/pair",
      payload,
    });
    expect(response.statusCode).toBe(201);
    return { payload, credentials: response.json<Record<string, unknown>>() };
  };

  const issueChallenge = async (
    screenId: string,
    keyId: string,
    operation: "heartbeat" | "manifest",
    bodySha256: string,
  ) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/device/challenges",
      headers: {
        "x-screen-id": screenId,
        "x-device-key-id": keyId,
      },
      payload: { operation, bodySha256 },
    });
    expect(response.statusCode).toBe(201);
    return response.json<ChallengeResponse>();
  };

  it("pairs in two stages without a bearer and recovers an identical final retry", async () => {
    const fixture = await pairingFixture();
    const first = await pair(fixture);

    expect(first.credentials).toMatchObject({
      authMode: "proof-v1",
      keyId: fixture.identity.keyId,
    });
    expect(first.credentials).not.toHaveProperty("deviceToken");

    const retry = await app.inject({
      method: "POST",
      url: "/api/v1/device/pair",
      payload: first.payload,
    });
    expect(retry.statusCode).toBe(201);
    expect(retry.json()).toEqual(first.credentials);
    expect(store.screens).toHaveLength(1);
    expect(store.deviceCredentials).toHaveLength(1);
    expect(
      store.audits.filter((audit) => audit.action === "device.paired"),
    ).toHaveLength(1);
  });

  it("clears omitted playback fields in a fresh heartbeat snapshot", async () => {
    const fixture = await pairingFixture();
    const { credentials } = await pair(fixture);
    const screenId = credentials.screenId as string;
    const sendHeartbeat = async (payload: {
      installationId: string;
      playerVersion: string;
      manifestVersion?: string;
      nowPlayingAssetId?: string;
      uptimeSeconds: number;
      freeStorageBytes: number;
      networkType: string;
      occurredAt: string;
    }) => {
      const challenge = await issueChallenge(
        screenId,
        fixture.identity.keyId,
        "heartbeat",
        canonicalHeartbeatDigest(payload),
      );
      return app.inject({
        method: "POST",
        url: "/api/v1/device/heartbeat",
        headers: proofHeaders(
          screenId,
          fixture.identity.keyId,
          challenge,
          fixture.privateKey,
        ),
        payload,
      });
    };

    const initial = {
      installationId: fixture.identity.keyId,
      playerVersion: "0.1.1",
      manifestVersion: "release-7",
      nowPlayingAssetId: "asset-7",
      uptimeSeconds: 120,
      freeStorageBytes: 1_000_000,
      networkType: "wifi",
      occurredAt: new Date().toISOString(),
    };
    expect((await sendHeartbeat(initial)).statusCode).toBe(200);
    expect(store.screens[0]).toMatchObject({
      manifestVersion: "release-7",
      nowPlayingAssetId: "asset-7",
    });

    const cleared = {
      installationId: fixture.identity.keyId,
      playerVersion: "0.1.2",
      uptimeSeconds: 180,
      freeStorageBytes: 900_000,
      networkType: "ethernet",
      occurredAt: new Date(Date.now() + 1).toISOString(),
    };
    const response = await sendHeartbeat(cleared);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accepted: true });
    expect(store.screens[0]).not.toHaveProperty("manifestVersion");
    expect(store.screens[0]).not.toHaveProperty("nowPlayingAssetId");
    expect(store.screens[0]).toMatchObject({
      playerVersion: "0.1.2",
      uptimeSeconds: 180,
      freeStorageBytes: 900_000,
      networkType: "ethernet",
    });
  });

  it("accepts a heartbeat proof once and rejects its replay", async () => {
    const fixture = await pairingFixture();
    const { credentials } = await pair(fixture);
    const screenId = credentials.screenId as string;
    const heartbeat = {
      installationId: fixture.identity.keyId,
      playerVersion: "0.1.1",
      manifestVersion: "release-7",
      uptimeSeconds: 120,
      freeStorageBytes: 1_000_000,
      networkType: "wifi",
      occurredAt: new Date().toISOString(),
    };
    const challenge = await issueChallenge(
      screenId,
      fixture.identity.keyId,
      "heartbeat",
      canonicalHeartbeatDigest(heartbeat),
    );
    const request = {
      method: "POST" as const,
      url: "/api/v1/device/heartbeat",
      headers: proofHeaders(
        screenId,
        fixture.identity.keyId,
        challenge,
        fixture.privateKey,
      ),
      payload: heartbeat,
    };

    const accepted = await app.inject(request);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ accepted: true });
    expect(store.screens[0]).toMatchObject({
      playerVersion: "0.1.1",
      manifestVersion: "release-7",
      uptimeSeconds: 120,
    });

    const replay = await app.inject(request);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe("DEVICE_UNAUTHORIZED");
  });

  it("serves a manifest with proof, revokes once, and returns dummy challenges afterward", async () => {
    const fixture = await pairingFixture();
    const { payload: pairingPayload, credentials } = await pair(fixture);
    const screenId = credentials.screenId as string;
    const manifestChallenge = await issueChallenge(
      screenId,
      fixture.identity.keyId,
      "manifest",
      EMPTY_BODY_SHA256,
    );
    const manifest = await app.inject({
      method: "GET",
      url: "/api/v1/device/manifest",
      headers: proofHeaders(
        screenId,
        fixture.identity.keyId,
        manifestChallenge,
        fixture.privateKey,
      ),
    });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json()).toMatchObject({
      screenId,
      requestChallengeId: manifestChallenge.id,
    });

    const auditsBeforeRevocation = store.audits.length;
    const revoke = () =>
      app.inject({
        method: "POST",
        url: `/api/v1/screens/${screenId}/device-credential/revoke`,
        headers: { authorization: `Bearer ${ownerToken}` },
      });
    expect((await revoke()).statusCode).toBe(204);
    expect((await revoke()).statusCode).toBe(204);
    expect(store.audits).toHaveLength(auditsBeforeRevocation + 1);

    const revokedPairingRetry = await app.inject({
      method: "POST",
      url: "/api/v1/device/pair",
      payload: pairingPayload,
    });
    expect(revokedPairingRetry.statusCode).toBe(404);

    const dummyResponse = await app.inject({
      method: "POST",
      url: "/api/v1/device/challenges",
      headers: {
        "x-screen-id": screenId,
        "x-device-key-id": fixture.identity.keyId,
      },
      payload: { operation: "manifest", bodySha256: EMPTY_BODY_SHA256 },
    });
    expect(dummyResponse.statusCode).toBe(201);
    const dummy = dummyResponse.json<ChallengeResponse>();
    expect(dummy).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expiresAt: expect.any(String),
    });

    const denied = await app.inject({
      method: "GET",
      url: "/api/v1/device/manifest",
      headers: proofHeaders(
        screenId,
        fixture.identity.keyId,
        dummy,
        fixture.privateKey,
      ),
    });
    expect(denied.statusCode).toBe(401);
    expect(denied.json().error.code).toBe("DEVICE_UNAUTHORIZED");
  });

  it("stages targeted re-enrollment until the exact proved candidate is activated", async () => {
    const original = await pair(await pairingFixture());
    const screenId = String(original.credentials.screenId);
    const requestGrant = await app.inject({
      method: "POST",
      url: `/api/v1/screens/${screenId}/device-reenrollment`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { reason: "Replace a failed player securely" },
    });
    expect(requestGrant.statusCode).toBe(201);
    expect(requestGrant.headers["cache-control"]).toBe("no-store");
    const firstGrant = requestGrant.json<{
      grantId: string;
      code: string;
      generation: number;
    }>();
    expect(firstGrant.generation).toBe(1);
    const replacementGrant = await app.inject({
      method: "POST",
      url: `/api/v1/screens/${screenId}/device-reenrollment`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { reason: "Retry after the first response was lost" },
    });
    expect(replacementGrant.statusCode).toBe(201);
    const grant = replacementGrant.json<{
      grantId: string;
      code: string;
      generation: number;
    }>();
    expect(grant.grantId).not.toBe(firstGrant.grantId);
    expect(grant.generation).toBe(2);
    const superseded = await app.inject({
      method: "GET",
      url: `/api/v1/screens/${screenId}/device-reenrollment/${firstGrant.grantId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(superseded.json()).toMatchObject({
      status: "revoked",
      candidates: [],
    });

    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const spki = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
    const replacementKeyId = sha256Base64Url(spki);
    const request = {
      code: grant.code,
      device: {
        installationId: replacementKeyId,
        model: "Replacement player",
        osVersion: "15",
        playerVersion: "0.2.0",
      },
      identity: {
        algorithm: "ES256" as const,
        publicKeySpki: spki.toString("base64url"),
        keyId: replacementKeyId,
        securityLevel: "software" as const,
      },
    };
    const challengeResponse = await app.inject({
      method: "POST",
      url: "/api/v1/device/pair/challenge",
      payload: request,
    });
    const challenge = challengeResponse.json<ChallengeResponse>();
    const proofPayload = {
      ...request,
      pairingProof: {
        challengeId: challenge.id,
        challenge: challenge.challenge,
        keyId: replacementKeyId,
        signatureFormat: "ES256-DER" as const,
        signature: signatureFor(privateKey, challenge.challenge),
      },
    };
    const prove = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/device/pair",
        payload: proofPayload,
      });
    const pending = await prove();
    expect(pending.statusCode).toBe(202);
    const candidate = pending.json<{
      status: string;
      grantId: string;
      candidateId: string;
      keyId: string;
      fingerprint: string;
    }>();
    expect(candidate).toMatchObject({
      status: "pending-approval",
      grantId: grant.grantId,
      keyId: replacementKeyId,
      fingerprint: replacementKeyId,
    });
    expect((await prove()).statusCode).toBe(202);
    expect(
      store.audits.filter(
        (audit) => audit.action === "device.reenrollment.candidate_proved",
      ),
    ).toHaveLength(1);

    const status = await app.inject({
      method: "GET",
      url: `/api/v1/screens/${screenId}/device-reenrollment/${grant.grantId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(status.statusCode).toBe(200);
    expect(status.headers["cache-control"]).toBe("no-store");
    expect(status.json()).toMatchObject({
      grantId: grant.grantId,
      screenId,
      status: "pending",
      candidates: [
        {
          id: candidate.candidateId,
          fingerprint: replacementKeyId,
          device: { model: "Replacement player" },
        },
      ],
    });

    const activated = await app.inject({
      method: "POST",
      url: `/api/v1/screens/${screenId}/device-reenrollment/${grant.grantId}/candidates/${candidate.candidateId}/activate`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json()).toMatchObject({
      grantId: grant.grantId,
      screenId,
      candidateId: candidate.candidateId,
      keyId: replacementKeyId,
      status: "activated",
    });
    const final = await prove();
    expect(final.statusCode).toBe(201);
    expect(final.json()).toMatchObject({
      authMode: "proof-v1",
      screenId,
      keyId: replacementKeyId,
    });

    const laterGrant = await app.inject({
      method: "POST",
      url: `/api/v1/screens/${screenId}/device-reenrollment`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { reason: "Contain this replacement before another attempt" },
    });
    expect(laterGrant.statusCode).toBe(201);
    const laterGrantId = laterGrant.json<{ grantId: string }>().grantId;
    const reassert = await app.inject({
      method: "POST",
      url: `/api/v1/screens/${screenId}/device-credential/revoke`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(reassert.statusCode).toBe(204);
    const cancelled = await app.inject({
      method: "GET",
      url: `/api/v1/screens/${screenId}/device-reenrollment/${laterGrantId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(cancelled.json()).toMatchObject({ status: "revoked" });
  });

  it("reasserts containment for a pending legacy screen without credential history", async () => {
    const screen = await store.createScreen("org-a", {
      name: "Legacy display",
      location: "Lobby",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
    });
    const requested = await app.inject({
      method: "POST",
      url: `/api/v1/screens/${screen.id}/device-reenrollment`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { reason: "Contain a legacy device replacement" },
    });
    expect(requested.statusCode).toBe(201);
    const grantId = requested.json<{ grantId: string }>().grantId;
    const revoked = await app.inject({
      method: "POST",
      url: `/api/v1/screens/${screen.id}/device-credential/revoke`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(revoked.statusCode).toBe(204);
    expect(
      store.pairings.find((pairing) => pairing.id === grantId)?.status,
    ).toBe("REVOKED");
    expect(
      store.screens.find((candidate) => candidate.id === screen.id)
        ?.credentialGeneration,
    ).toBe(2);
  });
});
