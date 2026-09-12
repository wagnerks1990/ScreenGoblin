import type {
  AuditRecord,
  ActiveOrdinaryRelease,
  DataStore,
  DeviceAuthChallengeRecord,
  DeviceCredentialEnrollment,
  DeviceCredentialRecord,
  DeviceCredentialRevokeAuditContext,
  DeviceProofInput,
  DeviceProofVerifier,
  EmergencyRecord,
  MediaRecord,
  PairingRecord,
  PairingClaimAuditContext,
  PairingCreateAuditContext,
  PairingCreateResult,
  PairingAttemptRecord,
  PairingProofVerifier,
  PlaylistRecord,
  PublishedReleaseRecord,
  ReleaseAssignmentRecord,
  ReleaseAuditContext,
  ReleasePublicationPolicy,
  ScheduleRecord,
  SchedulePublicationInput,
  SchedulePublicationResult,
  ScheduleWithdrawalResult,
  ScreenRecord,
  SessionUser,
} from "../domain/types.js";
import { matchesScheduleWindow } from "../utils/schedule.js";
import {
  assignmentSnapshotDigest,
  canonicalAssignmentSnapshot,
  canonicalReleaseSnapshot,
  ReleaseSnapshotError,
  releaseSnapshotDigest,
} from "../releases/canonical.js";
import { mediaUrlMatchesAllowedOrigin } from "../utils/media-url.js";
import { hasCapability } from "../authorization/policy.js";
import { CAPABILITIES } from "@screengoblin/contracts";
import { randomToken } from "../utils/crypto.js";

const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();

export class MemoryStore implements DataStore {
  users: SessionUser[] = [];
  screens: ScreenRecord[] = [];
  media: MediaRecord[] = [];
  playlists: PlaylistRecord[] = [];
  schedules: ScheduleRecord[] = [];
  releases: PublishedReleaseRecord[] = [];
  releaseAssignments: ReleaseAssignmentRecord[] = [];
  emergencies: EmergencyRecord[] = [];
  audits: AuditRecord[] = [];
  pairings: PairingRecord[] = [];
  deviceCredentials: DeviceCredentialRecord[] = [];
  deviceAuthChallenges: DeviceAuthChallengeRecord[] = [];
  pairingAttempts: PairingAttemptRecord[] = [];
  async ping() {}
  protected buildAuditRecord(
    event: Omit<AuditRecord, "id" | "createdAt">,
  ): AuditRecord {
    return { id: id(), ...event, createdAt: now() };
  }
  async findUserByEmail(email: string) {
    const normalizedEmail = email.toLowerCase();
    const matches = this.users.filter(
      (user) => user.email.toLowerCase() === normalizedEmail,
    );
    const userIds = new Set(matches.map((user) => user.id));
    if (userIds.size !== 1 || matches.some((user) => user.disabledAt))
      return null;
    const identity = matches[0]!;
    if (
      matches.some(
        (user) =>
          user.email !== identity.email ||
          user.name !== identity.name ||
          user.passwordHash !== identity.passwordHash,
      ) ||
      new Set(matches.map((user) => user.organizationId)).size !==
        matches.length
    )
      return null;
    return (
      matches.sort((a, b) =>
        a.organizationId.localeCompare(b.organizationId),
      )[0] ?? null
    );
  }
  async findSessionUser(userId: string, organizationId: string) {
    return (
      this.users.find(
        (u) =>
          u.id === userId &&
          u.organizationId === organizationId &&
          !u.disabledAt,
      ) ?? null
    );
  }
  private publicScreen(screen: ScreenRecord): ScreenRecord {
    const safe = { ...screen };
    delete safe.deviceTokenHash;
    return safe;
  }
  async listScreens(org: string) {
    return this.screens
      .filter((x) => x.organizationId === org)
      .map((x) => this.publicScreen(x));
  }
  async getScreen(org: string, screenId: string) {
    return (
      this.screens
        .filter((x) => x.organizationId === org && x.id === screenId)
        .map((x) => this.publicScreen(x))[0] ?? null
    );
  }
  async createScreen(
    org: string,
    data: Pick<
      ScreenRecord,
      "name" | "location" | "orientation" | "resolution" | "tags"
    >,
  ) {
    const t = now();
    const x: ScreenRecord = {
      id: id(),
      organizationId: org,
      status: "offline",
      ...data,
      createdAt: t,
      updatedAt: t,
    };
    this.screens.push(x);
    return x;
  }
  async updateScreen(
    org: string,
    screenId: string,
    data: Partial<
      Pick<
        ScreenRecord,
        "name" | "location" | "orientation" | "resolution" | "tags"
      >
    >,
  ) {
    const x = this.screens.find(
      (screen) => screen.organizationId === org && screen.id === screenId,
    );
    if (!x) return null;
    Object.assign(x, data, { updatedAt: now() });
    return x;
  }
  async deleteScreen(org: string, screenId: string) {
    const n = this.screens.length;
    this.screens = this.screens.filter(
      (x) => !(x.organizationId === org && x.id === screenId),
    );
    for (const credential of this.deviceCredentials) {
      if (credential.organizationId === org && credential.screenId === screenId)
        credential.detached = true;
    }
    return n !== this.screens.length;
  }
  async createPairing(org: string, codeHash: string, expiresAt: string) {
    const result = await this.tryCreatePairing(org, codeHash, expiresAt);
    if (!result.created) throw new Error("Pairing code collision");
    return result.pairing;
  }
  async tryCreatePairing(
    org: string,
    codeHash: string,
    expiresAt: string,
  ): Promise<PairingCreateResult> {
    const currentTime = now();
    for (const pairing of this.pairings) {
      if (
        pairing.codeHash === codeHash &&
        pairing.status === "PENDING" &&
        pairing.expiresAt <= currentTime
      ) {
        pairing.status = "EXPIRED";
      }
    }
    if (
      this.pairings.some(
        (pairing) =>
          pairing.codeHash === codeHash && pairing.status === "PENDING",
      )
    ) {
      return { created: false, reason: "CODE_COLLISION" };
    }
    const x: PairingRecord = {
      id: id(),
      organizationId: org,
      codeHash,
      expiresAt,
      status: "PENDING",
    };
    this.pairings.push(x);
    return { created: true, pairing: x };
  }
  async tryCreatePairingAndAudit(
    org: string,
    codeHash: string,
    expiresAt: string,
    audit: PairingCreateAuditContext,
  ): Promise<PairingCreateResult> {
    const currentTime = now();
    const expired = this.pairings.filter(
      (pairing) =>
        pairing.codeHash === codeHash &&
        pairing.status === "PENDING" &&
        pairing.expiresAt <= currentTime,
    );
    if (
      this.pairings.some(
        (pairing) =>
          pairing.codeHash === codeHash &&
          pairing.status === "PENDING" &&
          pairing.expiresAt > currentTime,
      )
    ) {
      return { created: false, reason: "CODE_COLLISION" };
    }
    const pairing: PairingRecord = {
      id: id(),
      organizationId: org,
      codeHash,
      expiresAt,
      status: "PENDING",
    };
    // Build the required audit before changing either in-memory collection.
    // This preserves transaction-like behavior for test doubles that reject it.
    const auditRecord = this.buildAuditRecord({
      organizationId: org,
      actorUserId: audit.actorUserId,
      actorType: "user",
      action: "pairing.created",
      entityType: "pairing",
      entityId: pairing.id,
      ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata: { expiresAt },
    });
    for (const existing of expired) existing.status = "EXPIRED";
    this.pairings.push(pairing);
    this.audits.push(auditRecord);
    return { created: true, pairing };
  }
  private claimPairingRecord(
    codeHash: string,
    device: {
      installationId: string;
      model: string;
      osVersion: string;
      playerVersion: string;
    },
    tokenHash: string,
  ): ScreenRecord | null {
    const p = this.pairings.find(
      (x) =>
        x.codeHash === codeHash &&
        x.status === "PENDING" &&
        x.expiresAt > now(),
    );
    if (!p) return null;
    const t = now();
    const x: ScreenRecord = {
      id: id(),
      organizationId: p.organizationId,
      name: `New screen ${device.installationId.slice(-6)}`,
      location: "Unassigned",
      status: "online",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
      ...device,
      deviceTokenHash: tokenHash,
      lastSeenAt: t,
      createdAt: t,
      updatedAt: t,
    };
    this.screens.push(x);
    p.status = "CLAIMED";
    p.screenId = x.id;
    return x;
  }
  async claimPairing(
    codeHash: string,
    device: {
      installationId: string;
      model: string;
      osVersion: string;
      playerVersion: string;
    },
    tokenHash: string,
  ) {
    return this.claimPairingRecord(codeHash, device, tokenHash);
  }
  async claimPairingAndAudit(
    codeHash: string,
    device: {
      installationId: string;
      model: string;
      osVersion: string;
      playerVersion: string;
    },
    tokenHash: string,
    audit: PairingClaimAuditContext,
  ) {
    const screen = this.claimPairingRecord(codeHash, device, tokenHash);
    if (!screen) return null;
    this.audits.push({
      id: id(),
      organizationId: screen.organizationId,
      actorType: "device",
      action: "device.paired",
      entityType: "screen",
      entityId: screen.id,
      ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata: {
        ...audit.metadata,
        installationId: device.installationId,
      },
      createdAt: now(),
    });
    return screen;
  }
  async issuePairingChallenge(input: {
    codeHash: string;
    credential: DeviceCredentialEnrollment;
    challengeHashSha256: string;
    transcriptDigestSha256: string;
    expiresAt: string;
  }) {
    const pairing = this.pairings.find(
      (candidate) =>
        candidate.codeHash === input.codeHash &&
        candidate.status === "PENDING" &&
        candidate.expiresAt > now(),
    );
    const createdAt = now();
    const lifetime =
      new Date(input.expiresAt).getTime() - new Date(createdAt).getTime();
    if (
      !pairing ||
      lifetime <= 0 ||
      lifetime > 45_000 ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.credential.keyId) ||
      !/^[0-9a-f]{64}$/.test(input.challengeHashSha256) ||
      !/^[0-9a-f]{64}$/.test(input.transcriptDigestSha256) ||
      this.deviceCredentials.some(
        (candidate) => candidate.keyId === input.credential.keyId,
      ) ||
      this.pairingAttempts.some(
        (candidate) =>
          candidate.challengeHashSha256 === input.challengeHashSha256,
      ) ||
      this.pairingAttempts.filter(
        (candidate) =>
          candidate.pairingCodeId === pairing.id &&
          candidate.keyId === input.credential.keyId &&
          !candidate.consumedAt &&
          candidate.expiresAt > createdAt,
      ).length >= 4
    )
      return null;
    const attempt: PairingAttemptRecord = {
      id: randomToken(),
      organizationId: pairing.organizationId,
      pairingCodeId: pairing.id,
      keyId: input.credential.keyId,
      publicKeySpki: input.credential.publicKeySpki,
      algorithm: input.credential.algorithm,
      securityLevel: input.credential.securityLevel,
      ...(input.credential.expiresAt
        ? { credentialExpiresAt: input.credential.expiresAt }
        : {}),
      challengeHashSha256: input.challengeHashSha256,
      transcriptDigestSha256: input.transcriptDigestSha256,
      expiresAt: input.expiresAt,
      createdAt,
    };
    this.pairingAttempts.push(attempt);
    return { ...attempt };
  }
  async claimPairingWithCredentialAndAudit(
    input: {
      codeHash: string;
      pairingAttemptId: string;
      challengeHashSha256: string;
      transcriptDigestSha256: string;
      keyId: string;
      device: {
        installationId: string;
        model: string;
        osVersion: string;
        playerVersion: string;
      };
    },
    verify: PairingProofVerifier,
    audit: PairingClaimAuditContext,
  ) {
    const attempt = this.pairingAttempts.find(
      (candidate) => candidate.id === input.pairingAttemptId,
    );
    const pairing = this.pairings.find(
      (candidate) =>
        candidate.id === attempt?.pairingCodeId &&
        candidate.organizationId === attempt?.organizationId &&
        candidate.codeHash === input.codeHash,
    );
    if (
      !attempt ||
      !pairing ||
      attempt.challengeHashSha256 !== input.challengeHashSha256 ||
      attempt.transcriptDigestSha256 !== input.transcriptDigestSha256 ||
      attempt.keyId !== input.keyId ||
      !(await verify({
        keyId: attempt.keyId,
        publicKeySpki: attempt.publicKeySpki,
        algorithm: attempt.algorithm,
        securityLevel: attempt.securityLevel,
        ...(attempt.credentialExpiresAt
          ? { expiresAt: attempt.credentialExpiresAt }
          : {}),
      }))
    )
      return { paired: false as const, reason: "INVALID" as const };
    if (attempt.consumedAt && attempt.boundCredentialId) {
      const credential = this.deviceCredentials.find(
        (candidate) =>
          candidate.id === attempt.boundCredentialId &&
          !candidate.revokedAt &&
          (!candidate.expiresAt || candidate.expiresAt > now()),
      );
      const screen = credential
        ? this.screens.find(
            (candidate) =>
              candidate.id === credential.screenId &&
              candidate.organizationId === credential.organizationId,
          )
        : undefined;
      return credential && screen
        ? {
            paired: true as const,
            credential: { ...credential },
            screen: this.publicScreen(screen),
          }
        : { paired: false as const, reason: "INVALID" as const };
    }
    if (
      attempt.expiresAt <= now() ||
      pairing.expiresAt <= now() ||
      pairing.status !== "PENDING" ||
      this.deviceCredentials.some(
        (candidate) => candidate.keyId === attempt.keyId,
      )
    )
      return { paired: false as const, reason: "INVALID" as const };
    const timestamp = now();
    const screen: ScreenRecord = {
      id: id(),
      organizationId: pairing.organizationId,
      name: `New screen ${input.device.installationId.slice(-6)}`,
      location: "Unassigned",
      status: "online",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
      ...input.device,
      lastSeenAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const credential: DeviceCredentialRecord = {
      id: id(),
      organizationId: pairing.organizationId,
      screenId: screen.id,
      detached: false,
      keyId: attempt.keyId,
      publicKeySpki: attempt.publicKeySpki,
      algorithm: attempt.algorithm,
      securityLevel: attempt.securityLevel,
      ...(attempt.credentialExpiresAt
        ? { expiresAt: attempt.credentialExpiresAt }
        : {}),
      createdAt: timestamp,
    };
    const auditRecord = this.buildAuditRecord({
      organizationId: pairing.organizationId,
      actorType: "device",
      action: "device.paired",
      entityType: "screen",
      entityId: screen.id,
      ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata: {
        ...audit.metadata,
        installationId: input.device.installationId,
        credentialId: credential.id,
        keyId: credential.keyId,
      },
    });
    this.screens.push(screen);
    this.deviceCredentials.push(credential);
    pairing.status = "CLAIMED";
    pairing.screenId = screen.id;
    attempt.consumedAt = timestamp;
    attempt.boundCredentialId = credential.id;
    this.audits.push(auditRecord);
    return {
      paired: true as const,
      screen: this.publicScreen(screen),
      credential: { ...credential },
    };
  }
  async authenticateDevice(screenId: string) {
    const screen = this.screens.find(
      (x) => x.id === screenId && !x.credentialRevokedAt,
    );
    return screen?.deviceTokenHash
      ? { ...screen, deviceTokenHash: screen.deviceTokenHash }
      : null;
  }
  private activeDeviceCredential(
    credentialId: string,
  ): { credential: DeviceCredentialRecord; screen: ScreenRecord } | null {
    const credential = this.deviceCredentials.find(
      (candidate) =>
        candidate.id === credentialId &&
        !candidate.detached &&
        !candidate.revokedAt &&
        (!candidate.expiresAt || candidate.expiresAt > now()),
    );
    if (!credential) return null;
    const screen = this.screens.find(
      (candidate) =>
        candidate.id === credential.screenId &&
        candidate.organizationId === credential.organizationId,
    );
    return screen ? { credential, screen } : null;
  }
  async authenticateDeviceCredential(screenId: string, keyId: string) {
    const credential = this.deviceCredentials.find(
      (candidate) =>
        candidate.screenId === screenId && candidate.keyId === keyId,
    );
    const active = credential
      ? this.activeDeviceCredential(credential.id)
      : null;
    return active
      ? {
          authenticated: true as const,
          credential: { ...active.credential },
          screen: this.publicScreen(active.screen),
        }
      : { authenticated: false as const, reason: "INVALID_PROOF" as const };
  }
  async issueDeviceAuthChallenge(input: {
    screenId: string;
    keyId: string;
    challengeHashSha256: string;
    operation: "heartbeat" | "manifest";
    requestDigestSha256: string;
    expiresAt: string;
  }) {
    const authenticated = await this.authenticateDeviceCredential(
      input.screenId,
      input.keyId,
    );
    const createdAt = now();
    const lifetime =
      new Date(input.expiresAt).getTime() - new Date(createdAt).getTime();
    if (
      !authenticated.authenticated ||
      lifetime <= 0 ||
      lifetime > 60_000 ||
      !/^[0-9a-f]{64}$/.test(input.challengeHashSha256) ||
      !/^[0-9a-f]{64}$/.test(input.requestDigestSha256) ||
      this.deviceAuthChallenges.some(
        (candidate) =>
          candidate.challengeHashSha256 === input.challengeHashSha256,
      ) ||
      this.deviceAuthChallenges.filter(
        (candidate) =>
          candidate.credentialId === authenticated.credential.id &&
          candidate.operation === input.operation &&
          !candidate.consumedAt &&
          candidate.expiresAt > createdAt,
      ).length >= 4
    )
      return null;
    const challenge: DeviceAuthChallengeRecord = {
      id: randomToken(),
      organizationId: authenticated.credential.organizationId,
      credentialId: authenticated.credential.id,
      challengeHashSha256: input.challengeHashSha256,
      operation: input.operation,
      requestDigestSha256: input.requestDigestSha256,
      expiresAt: input.expiresAt,
      createdAt,
    };
    this.deviceAuthChallenges.push(challenge);
    return { ...challenge };
  }
  private async consumeDeviceProof(
    input: DeviceProofInput,
    verify: DeviceProofVerifier,
  ) {
    const active = this.activeDeviceCredential(input.credentialId);
    const challenge = this.deviceAuthChallenges.find(
      (candidate) =>
        candidate.id === input.challengeId &&
        candidate.credentialId === input.credentialId &&
        candidate.organizationId === active?.credential.organizationId,
    );
    if (
      !active ||
      !challenge ||
      challenge.consumedAt ||
      challenge.expiresAt <= now() ||
      challenge.challengeHashSha256 !== input.challengeHashSha256 ||
      challenge.operation !== input.operation ||
      challenge.requestDigestSha256 !== input.requestDigestSha256 ||
      !(await verify({ ...active.credential })) ||
      challenge.consumedAt
    )
      return null;
    challenge.consumedAt = now();
    return active;
  }
  async consumeDeviceAuthChallenge(
    input: DeviceProofInput,
    verify: DeviceProofVerifier,
  ) {
    const active = await this.consumeDeviceProof(input, verify);
    return active
      ? {
          authenticated: true as const,
          credential: { ...active.credential },
          screen: this.publicScreen(active.screen),
        }
      : { authenticated: false as const, reason: "INVALID_PROOF" as const };
  }
  async heartbeatWithDeviceProof(
    input: DeviceProofInput,
    data: Partial<ScreenRecord>,
    verify: DeviceProofVerifier,
  ) {
    const active = await this.consumeDeviceProof(input, verify);
    if (!active)
      return {
        authenticated: false as const,
        reason: "INVALID_PROOF" as const,
      };
    Object.assign(active.screen, data, {
      status: "online",
      lastSeenAt: now(),
      updatedAt: now(),
    });
    return {
      authenticated: true as const,
      credential: { ...active.credential },
      screen: this.publicScreen(active.screen),
    };
  }
  async revokeDeviceCredentialAndAudit(
    org: string,
    screenId: string,
    audit: DeviceCredentialRevokeAuditContext,
  ) {
    const actor = this.users.find(
      (candidate) =>
        candidate.id === audit.actorUserId &&
        candidate.organizationId === org &&
        !candidate.disabledAt,
    );
    if (actor?.role !== "OWNER" && actor?.role !== "ADMIN")
      return { revoked: false as const, reason: "FORBIDDEN" as const };
    const credential = this.deviceCredentials.find(
      (candidate) =>
        candidate.screenId === screenId &&
        candidate.organizationId === org &&
        !candidate.detached,
    );
    if (!credential)
      return { revoked: false as const, reason: "NOT_FOUND" as const };
    if (credential.revokedAt)
      return { revoked: false as const, reason: "ALREADY_REVOKED" as const };
    const revokedAt = now();
    const auditRecord = this.buildAuditRecord({
      organizationId: org,
      actorUserId: audit.actorUserId,
      actorType: "user",
      action: "device.credential.revoked",
      entityType: "device_credential",
      entityId: credential.id,
      ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata: { screenId: credential.screenId, keyId: credential.keyId },
    });
    credential.revokedAt = revokedAt;
    const screen = this.screens.find(
      (candidate) =>
        candidate.id === screenId && candidate.organizationId === org,
    );
    if (screen) screen.credentialRevokedAt = revokedAt;
    for (const challenge of this.deviceAuthChallenges) {
      if (
        challenge.credentialId === credential.id &&
        !challenge.consumedAt &&
        challenge.expiresAt > revokedAt
      )
        challenge.consumedAt = revokedAt;
    }
    this.audits.push(auditRecord);
    return { revoked: true as const, credential: { ...credential } };
  }
  async heartbeat(screenId: string, data: Partial<ScreenRecord>) {
    const x = this.screens.find((s) => s.id === screenId);
    if (!x) return null;
    Object.assign(x, data, {
      status: "online",
      lastSeenAt: now(),
      updatedAt: now(),
    });
    return x;
  }
  async listMedia(org: string) {
    return this.media.filter((x) => x.organizationId === org);
  }
  async createMedia(
    org: string,
    data: Omit<
      MediaRecord,
      "id" | "organizationId" | "createdAt" | "updatedAt"
    >,
  ) {
    const t = now();
    const x: MediaRecord = {
      id: id(),
      organizationId: org,
      ...data,
      createdAt: t,
      updatedAt: t,
    };
    this.media.push(x);
    return x;
  }
  async getMedia(org: string, assetId: string) {
    return (
      this.media.find((x) => x.organizationId === org && x.id === assetId) ??
      null
    );
  }
  async deleteMedia(org: string, assetId: string) {
    if (
      !this.media.some(
        (asset) => asset.organizationId === org && asset.id === assetId,
      )
    )
      return "NOT_FOUND" as const;
    if (
      this.playlists.some(
        (playlist) =>
          playlist.organizationId === org &&
          playlist.items.some((item) => item.assetId === assetId),
      ) ||
      this.releases.some(
        (release) =>
          release.organizationId === org &&
          release.items.some((item) => item.asset.id === assetId),
      )
    )
      return "IN_USE" as const;
    this.media = this.media.filter(
      (x) => !(x.organizationId === org && x.id === assetId),
    );
    return "DELETED" as const;
  }
  async listPlaylists(org: string) {
    return this.playlists.filter((x) => x.organizationId === org);
  }
  async createPlaylist(
    org: string,
    data: Pick<PlaylistRecord, "name" | "description" | "items">,
  ) {
    const t = now();
    const x: PlaylistRecord = {
      id: id(),
      organizationId: org,
      ...data,
      items: data.items.map((v) => ({ ...v, id: id() })),
      createdAt: t,
      updatedAt: t,
    };
    this.playlists.push(x);
    return x;
  }
  async getPlaylist(org: string, playlistId: string) {
    return (
      this.playlists.find(
        (x) => x.organizationId === org && x.id === playlistId,
      ) ?? null
    );
  }
  async deletePlaylist(org: string, playlistId: string) {
    if (
      !this.playlists.some(
        (playlist) =>
          playlist.organizationId === org && playlist.id === playlistId,
      )
    )
      return "NOT_FOUND" as const;
    if (
      this.schedules.some(
        (schedule) =>
          schedule.organizationId === org && schedule.playlistId === playlistId,
      ) ||
      this.releases.some(
        (release) =>
          release.organizationId === org &&
          release.sourcePlaylistId === playlistId,
      )
    )
      return "IN_USE" as const;
    this.playlists = this.playlists.filter(
      (x) => !(x.organizationId === org && x.id === playlistId),
    );
    return "DELETED" as const;
  }
  async listSchedules(org: string) {
    return this.schedules.filter((schedule) => {
      if (schedule.organizationId !== org) return false;
      if (!schedule.releaseId) return true;
      const latest = this.latestAssignment(schedule.id);
      return latest?.state !== "WITHDRAWN";
    });
  }
  async createSchedule(
    org: string,
    data: Omit<
      ScheduleRecord,
      "id" | "organizationId" | "createdAt" | "updatedAt"
    >,
  ) {
    const t = now();
    const x: ScheduleRecord = {
      id: id(),
      organizationId: org,
      ...data,
      createdAt: t,
      updatedAt: t,
    };
    this.schedules.push(x);
    return x;
  }
  async deleteSchedule(org: string, scheduleId: string) {
    const n = this.schedules.length;
    this.schedules = this.schedules.filter(
      (x) => !(x.organizationId === org && x.id === scheduleId),
    );
    return n !== this.schedules.length;
  }
  async publishScheduleAndAudit(
    org: string,
    data: SchedulePublicationInput,
    audit: ReleaseAuditContext,
    policy: ReleasePublicationPolicy,
  ): Promise<SchedulePublicationResult> {
    const actor = this.users.find(
      (candidate) =>
        candidate.id === audit.actorUserId &&
        candidate.organizationId === org &&
        !candidate.disabledAt,
    );
    if (!hasCapability(actor?.role, CAPABILITIES.releasePublish))
      return { published: false, reason: "FORBIDDEN" };
    const screenIds = [...new Set(data.screenIds)].sort();
    const playlist = this.playlists.find(
      (candidate) =>
        candidate.organizationId === org && candidate.id === data.playlistId,
    );
    if (!playlist) return { published: false, reason: "PLAYLIST_NOT_FOUND" };
    if (
      screenIds.some(
        (screenId) =>
          !this.screens.some(
            (screen) => screen.organizationId === org && screen.id === screenId,
          ),
      )
    )
      return { published: false, reason: "SCREEN_NOT_FOUND" };
    const sourceAssets = playlist.items.flatMap((item) => {
      const asset = this.media.find(
        (candidate) =>
          candidate.organizationId === org && candidate.id === item.assetId,
      );
      return asset ? [asset] : [];
    });
    if (
      sourceAssets.some(
        (asset) =>
          !mediaUrlMatchesAllowedOrigin(asset.url, policy.mediaAllowedOrigins),
      )
    )
      return { published: false, reason: "ASSET_NOT_ALLOWED" };

    let snapshot;
    try {
      snapshot = canonicalReleaseSnapshot(playlist, sourceAssets);
    } catch (error) {
      if (error instanceof ReleaseSnapshotError)
        return { published: false, reason: error.reason };
      throw error;
    }

    const digestSha256 = releaseSnapshotDigest(snapshot);
    const timestamp = now();
    const existingRelease = this.releases.find(
      (release) =>
        release.organizationId === org && release.digestSha256 === digestSha256,
    );
    const release: PublishedReleaseRecord = existingRelease ?? {
      id: id(),
      organizationId: org,
      sourcePlaylistId: snapshot.sourcePlaylistId,
      sourcePlaylistUpdatedAt: snapshot.sourcePlaylistUpdatedAt,
      playlistName: snapshot.playlistName,
      playlistDescription: snapshot.playlistDescription,
      digestSha256,
      items: snapshot.items,
      createdById: audit.actorUserId,
      createdAt: timestamp,
    };
    const scheduleId = id();
    const assignmentId = id();
    const frozenSchedule = {
      name: data.name,
      priority: data.priority,
      startsAt: data.startsAt,
      ...(data.endsAt ? { endsAt: data.endsAt } : {}),
      timezone: data.timezone,
      daysOfWeek: [...data.daysOfWeek],
      ...(data.dailyStartMinutes !== undefined
        ? { dailyStartMinutes: data.dailyStartMinutes }
        : {}),
      ...(data.dailyEndMinutes !== undefined
        ? { dailyEndMinutes: data.dailyEndMinutes }
        : {}),
      enabled: data.enabled,
    };
    const assignmentDigest = assignmentSnapshotDigest(
      canonicalAssignmentSnapshot({
        releaseDigestSha256: digestSha256,
        state: "ASSIGNED",
        schedule: frozenSchedule,
        screenIds,
      }),
    );
    const duplicateAssignment = this.releaseAssignments.find(
      (candidate) =>
        candidate.organizationId === org &&
        candidate.state === "ASSIGNED" &&
        candidate.digestSha256 === assignmentDigest &&
        this.latestAssignment(candidate.scheduleId)?.id === candidate.id,
    );
    if (duplicateAssignment) {
      const duplicateSchedule = this.schedules.find(
        (candidate) =>
          candidate.organizationId === org &&
          candidate.id === duplicateAssignment.scheduleId,
      );
      const duplicateRelease = this.releases.find(
        (candidate) =>
          candidate.organizationId === org &&
          candidate.id === duplicateAssignment.releaseId,
      );
      if (!duplicateSchedule || !duplicateRelease)
        throw new Error("Immutable release assignment references are missing");
      return {
        published: true,
        schedule: duplicateSchedule,
        release: duplicateRelease,
        assignment: duplicateAssignment,
      };
    }
    const schedule: ScheduleRecord = {
      id: scheduleId,
      organizationId: org,
      ...data,
      screenIds,
      releaseId: release.id,
      assignmentId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const assignment: ReleaseAssignmentRecord = {
      id: assignmentId,
      organizationId: org,
      releaseId: release.id,
      scheduleId,
      screenIds,
      state: "ASSIGNED",
      schedule: frozenSchedule,
      digestSha256: assignmentDigest,
      createdById: audit.actorUserId,
      createdAt: timestamp,
    };
    const auditRecord = this.buildAuditRecord({
      organizationId: org,
      actorUserId: audit.actorUserId,
      actorType: "user",
      action: "release.published",
      entityType: "published_release",
      entityId: release.id,
      ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata: {
        scheduleId,
        assignmentId,
        digestSha256,
        assignmentDigestSha256: assignmentDigest,
        screenCount: assignment.screenIds.length,
      },
    });

    if (!existingRelease) this.releases.push(release);
    this.schedules.push(schedule);
    this.releaseAssignments.push(assignment);
    this.audits.push(auditRecord);
    return { published: true, schedule, release, assignment };
  }

  async withdrawScheduleAndAudit(
    org: string,
    scheduleId: string,
    audit: ReleaseAuditContext,
  ): Promise<ScheduleWithdrawalResult> {
    const actor = this.users.find(
      (candidate) =>
        candidate.id === audit.actorUserId &&
        candidate.organizationId === org &&
        !candidate.disabledAt,
    );
    if (!hasCapability(actor?.role, CAPABILITIES.releaseWithdraw))
      return { withdrawn: false, reason: "FORBIDDEN" };
    const schedule = this.schedules.find(
      (candidate) =>
        candidate.organizationId === org && candidate.id === scheduleId,
    );
    if (!schedule?.releaseId) return { withdrawn: false, reason: "NOT_FOUND" };
    const previous = this.latestAssignment(scheduleId);
    if (!previous) return { withdrawn: false, reason: "NOT_FOUND" };
    if (previous.state === "WITHDRAWN")
      return { withdrawn: false, reason: "ALREADY_WITHDRAWN" };
    const release = this.releases.find(
      (candidate) =>
        candidate.organizationId === org && candidate.id === schedule.releaseId,
    );
    if (!release) return { withdrawn: false, reason: "NOT_FOUND" };

    const assignment: ReleaseAssignmentRecord = {
      id: id(),
      organizationId: org,
      releaseId: schedule.releaseId,
      scheduleId,
      screenIds: [...previous.screenIds],
      state: "WITHDRAWN",
      schedule: {
        ...previous.schedule,
        daysOfWeek: [...previous.schedule.daysOfWeek],
      },
      digestSha256: assignmentSnapshotDigest(
        canonicalAssignmentSnapshot({
          releaseDigestSha256: release.digestSha256,
          state: "WITHDRAWN",
          schedule: previous.schedule,
          screenIds: previous.screenIds,
          previousAssignmentId: previous.id,
        }),
      ),
      previousAssignmentId: previous.id,
      createdById: audit.actorUserId,
      createdAt: now(),
    };
    const auditRecord = this.buildAuditRecord({
      organizationId: org,
      actorUserId: audit.actorUserId,
      actorType: "user",
      action: "release.withdrawn",
      entityType: "release_assignment",
      entityId: assignment.id,
      ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata: {
        scheduleId,
        releaseId: schedule.releaseId,
        previousAssignmentId: previous.id,
        screenCount: assignment.screenIds.length,
      },
    });
    this.releaseAssignments.push(assignment);
    this.audits.push(auditRecord);
    return { withdrawn: true, assignment };
  }

  private latestAssignment(
    scheduleId: string,
  ): ReleaseAssignmentRecord | undefined {
    for (let index = this.releaseAssignments.length - 1; index >= 0; index--) {
      const assignment = this.releaseAssignments[index];
      if (assignment?.scheduleId === scheduleId) return assignment;
    }
    return undefined;
  }

  async activeOrdinaryReleases(
    org: string,
    screenId: string,
    at: string,
  ): Promise<ActiveOrdinaryRelease[]> {
    const instant = new Date(at);
    return this.schedules.flatMap((schedule) => {
      if (schedule.organizationId !== org || !schedule.releaseId) return [];
      const assignment = this.latestAssignment(schedule.id);
      if (
        !assignment ||
        assignment.organizationId !== org ||
        assignment.state !== "ASSIGNED" ||
        !assignment.screenIds.includes(screenId) ||
        !assignment.schedule.enabled ||
        assignment.schedule.startsAt > at ||
        (assignment.schedule.endsAt && assignment.schedule.endsAt <= at) ||
        !matchesScheduleWindow(assignment.schedule, instant)
      )
        return [];
      const release = this.releases.find(
        (candidate) =>
          candidate.organizationId === org &&
          candidate.id === assignment.releaseId,
      );
      return release ? [{ release, assignment }] : [];
    });
  }
  async activeSchedules(org: string, screenId: string, at: string) {
    const d = new Date(at);
    return this.schedules.filter(
      (x) =>
        x.organizationId === org &&
        x.screenIds.includes(screenId) &&
        x.enabled &&
        x.startsAt <= at &&
        (!x.endsAt || x.endsAt > at) &&
        matchesScheduleWindow(x, d),
    );
  }
  async activeEmergency(org: string, screenId: string, at: string) {
    return (
      this.emergencies.find(
        (x) =>
          x.organizationId === org &&
          x.targetScreenIds.includes(screenId) &&
          x.startsAt <= at &&
          x.expiresAt > at &&
          !x.clearedAt,
      ) ?? null
    );
  }
  async createEmergency(
    org: string,
    userId: string,
    data: Pick<
      EmergencyRecord,
      "title" | "message" | "backgroundColor" | "targetScreenIds" | "expiresAt"
    >,
  ) {
    const t = now();
    const x: EmergencyRecord = {
      id: id(),
      organizationId: org,
      createdById: userId,
      startsAt: t,
      ...data,
      createdAt: t,
    };
    this.emergencies.push(x);
    return x;
  }
  async clearEmergency(org: string, overrideId: string) {
    const x = this.emergencies.find(
      (e) => e.organizationId === org && e.id === overrideId,
    );
    if (!x) return null;
    x.clearedAt = now();
    return x;
  }
  async listAudits(org: string, limit: number) {
    return this.audits
      .filter((x) => x.organizationId === org)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
  async audit(event: Omit<AuditRecord, "id" | "createdAt">) {
    this.audits.push(this.buildAuditRecord(event));
  }
}
