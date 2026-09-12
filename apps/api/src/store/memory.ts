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
  HeartbeatUpdateInput,
  LoginFailureInput,
  LoginFailureRecord,
  MediaDeliveryAuthorizationInput,
  LocationRecord,
  MediaRecord,
  PairingRecord,
  PairingClaimAuditContext,
  PairingCreateAuditContext,
  PairingCreateResult,
  AuditedPairingCreateResult,
  PairingAttemptRecord,
  PairingProofVerifier,
  ReenrollmentActivationResult,
  ScreenEnrollmentActivationIdempotencyInput,
  ScreenEnrollmentActivationResult,
  ScreenEnrollmentIdempotencyInput,
  ScreenEnrollmentRequestResult,
  PlaylistRecord,
  PublishedReleaseRecord,
  ReleaseAssignmentRecord,
  ReleaseAuditContext,
  ReleasePublicationPolicy,
  ScheduleRecord,
  SchedulePublicationInput,
  SchedulePublicationIdempotencyInput,
  SchedulePublicationIdempotencyRecord,
  SchedulePublicationResult,
  ScheduleWithdrawalResult,
  ScreenMutationInput,
  ScreenMutationPatch,
  ScreenRecord,
  SessionUser,
  SystemIdentityMutationAuditContext,
  UserMutationAuditContext,
  UserSessionCreateInput,
  UserSessionRecord,
} from "../domain/types.js";
import {
  SCHEDULE_PUBLICATION_IDEMPOTENCY_OPERATION,
  SCHEDULE_PUBLICATION_RESPONSE_RETENTION_MS,
  DATABASE_MAINTENANCE_BATCH_SIZE,
  DEVICE_AUTH_CHALLENGE_RETENTION_MS,
  DEVICE_ENROLLMENT_AUTHORITY_RETENTION_MS,
  LOGIN_FAILURE_MAX_RECORDS,
  LOGIN_FAILURE_RETENTION_MS,
} from "../domain/types.js";
import { matchesScheduleWindow } from "../utils/schedule.js";
import {
  assignmentSnapshotDigest,
  canonicalAssignmentSnapshot,
  canonicalReleaseSnapshot,
  canonicalUtcInstant,
  hasValidStoredAssignmentDigest,
  ReleaseSnapshotError,
  releaseSnapshotDigest,
} from "../releases/canonical.js";
import { mediaUrlMatchesAllowedOrigin } from "../utils/media-url.js";
import { mediaPublicationFailure } from "../utils/media-policy.js";
import { hasCapability } from "../authorization/policy.js";
import { CAPABILITIES } from "@screengoblin/contracts";
import { isApprovedPasswordHash, randomToken } from "../utils/crypto.js";
import { mediaStorageKey } from "../media/delivery.js";
import { immutableAuditRecord } from "../audit/integrity.js";

const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();

export class MemoryStore implements DataStore {
  users: SessionUser[] = [];
  userSessions: UserSessionRecord[] = [];
  loginFailures: LoginFailureRecord[] = [];
  locations: LocationRecord[] = [];
  screens: ScreenRecord[] = [];
  media: MediaRecord[] = [];
  playlists: PlaylistRecord[] = [];
  schedules: ScheduleRecord[] = [];
  releases: PublishedReleaseRecord[] = [];
  releaseAssignments: ReleaseAssignmentRecord[] = [];
  idempotencyRecords: SchedulePublicationIdempotencyRecord[] = [];
  screenEnrollmentIdempotencyRecords: Array<{
    operation: "create" | "activate";
    organizationId: string;
    keyHash: string;
    actorUserId: string;
    requestDigestSha256: string;
    expiresAt: string;
    response?: Record<string, unknown>;
  }> = [];
  emergencies: EmergencyRecord[] = [];
  private readonly auditRecords: AuditRecord[] = [];
  pairings: PairingRecord[] = [];
  deviceCredentials: DeviceCredentialRecord[] = [];
  deviceAuthChallenges: DeviceAuthChallengeRecord[] = [];
  pairingAttempts: PairingAttemptRecord[] = [];
  usedDeviceKeyIds = new Set<string>();
  get audits(): readonly AuditRecord[] {
    return Object.freeze([...this.auditRecords]);
  }
  async ping() {}
  protected createDeviceAuthChallengeId() {
    return randomToken();
  }
  private pruneOldDeviceAuthChallenges(timestamp: string) {
    const cutoff = new Date(
      new Date(timestamp).getTime() - DEVICE_AUTH_CHALLENGE_RETENTION_MS,
    ).toISOString();
    const removable = this.deviceAuthChallenges
      .filter((challenge) => challenge.expiresAt <= cutoff)
      .sort(
        (a, b) =>
          a.expiresAt.localeCompare(b.expiresAt) || a.id.localeCompare(b.id),
      )
      .slice(0, DATABASE_MAINTENANCE_BATCH_SIZE);
    if (removable.length === 0) return;
    const ids = new Set(removable.map(({ id }) => id));
    this.deviceAuthChallenges = this.deviceAuthChallenges.filter(
      ({ id }) => !ids.has(id),
    );
  }
  private compactExpiredIdempotencyResponses(timestamp: string) {
    for (const record of this.idempotencyRecords
      .filter(
        (candidate) =>
          candidate.response !== undefined && candidate.expiresAt <= timestamp,
      )
      .sort(
        (a, b) =>
          a.expiresAt.localeCompare(b.expiresAt) ||
          a.keyHash.localeCompare(b.keyHash),
      )
      .slice(0, DATABASE_MAINTENANCE_BATCH_SIZE))
      delete record.response;
  }
  private revokePendingIssuerGrants(
    userId: string,
    organizationIds: readonly string[],
    timestamp: string,
  ) {
    for (const grant of this.pairings)
      if (
        organizationIds.includes(grant.organizationId) &&
        grant.authorizedByUserId === userId &&
        grant.status === "PENDING"
      ) {
        grant.status = "REVOKED";
        for (const attempt of this.pairingAttempts)
          if (attempt.pairingCodeId === grant.id && !attempt.boundCredentialId)
            attempt.cancelledAt ??= timestamp;
      }
  }
  private pruneDeviceEnrollmentAuthority(
    organizationId: string,
    timestamp: string,
    preserveIdempotencyKeyHash?: string,
  ) {
    for (const grant of this.pairings
      .filter(
        (candidate) =>
          candidate.organizationId === organizationId &&
          candidate.status === "PENDING" &&
          candidate.expiresAt <= timestamp,
      )
      .sort(
        (a, b) =>
          a.expiresAt.localeCompare(b.expiresAt) || a.id.localeCompare(b.id),
      )
      .slice(0, DATABASE_MAINTENANCE_BATCH_SIZE))
      grant.status = "EXPIRED";
    const cutoff = new Date(
      new Date(timestamp).getTime() - DEVICE_ENROLLMENT_AUTHORITY_RETENTION_MS,
    ).toISOString();
    const removedGrantIds = new Set(
      this.pairings
        .filter(
          (grant) =>
            grant.organizationId === organizationId &&
            grant.status !== "PENDING" &&
            grant.expiresAt <= cutoff,
        )
        .sort(
          (a, b) =>
            a.expiresAt.localeCompare(b.expiresAt) || a.id.localeCompare(b.id),
        )
        .slice(0, DATABASE_MAINTENANCE_BATCH_SIZE)
        .map((grant) => grant.id),
    );
    this.pairings = this.pairings.filter(
      (grant) => !removedGrantIds.has(grant.id),
    );
    this.pairingAttempts = this.pairingAttempts.filter(
      (attempt) => !removedGrantIds.has(attempt.pairingCodeId),
    );
    for (const record of this.screenEnrollmentIdempotencyRecords
      .filter(
        (record) =>
          record.organizationId === organizationId &&
          record.keyHash !== preserveIdempotencyKeyHash &&
          record.response !== undefined &&
          record.expiresAt <= timestamp,
      )
      .sort(
        (a, b) =>
          a.expiresAt.localeCompare(b.expiresAt) ||
          a.keyHash.localeCompare(b.keyHash),
      )
      .slice(0, DATABASE_MAINTENANCE_BATCH_SIZE))
      delete record.response;
  }
  protected buildAuditRecord(
    event: Omit<AuditRecord, "id" | "createdAt">,
  ): AuditRecord {
    return immutableAuditRecord(event, id(), now());
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
          user.passwordHash !== identity.passwordHash ||
          user.authenticationEpoch !== identity.authenticationEpoch,
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
  async recordLoginFailure(input: LoginFailureInput) {
    if (
      !/^[0-9a-f]{64}$/.test(input.accountKey) ||
      !/^[0-9a-f]{64}$/.test(input.sourceKey)
    )
      throw new Error("Login failure identifiers must be opaque SHA-256 HMACs");
    const occurredAt = now();
    const cutoff = new Date(
      Date.parse(occurredAt) - LOGIN_FAILURE_RETENTION_MS,
    ).toISOString();
    const retained = this.loginFailures
      .filter((event) => event.occurredAt >= cutoff)
      .sort(
        (left, right) =>
          left.occurredAt.localeCompare(right.occurredAt) ||
          left.id.localeCompare(right.id),
      )
      .slice(-(LOGIN_FAILURE_MAX_RECORDS - 1));
    this.loginFailures = [...retained, { id: id(), ...input, occurredAt }];
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
  async createUserSessionAndAudit(
    organizationId: string,
    input: UserSessionCreateInput,
    audit: UserMutationAuditContext,
  ) {
    const timestamp = now();
    const user = await this.findSessionUser(audit.actorUserId, organizationId);
    if (
      !user ||
      user.passwordHash !== input.expectedPasswordHash ||
      user.role !== input.expectedRole ||
      user.authenticationEpoch !== input.expectedAuthenticationEpoch ||
      user.authorizationEpoch !== input.expectedAuthorizationEpoch ||
      input.expiresAt <= timestamp
    )
      return { created: false, reason: "FORBIDDEN" } as const;
    const session: UserSessionRecord = {
      id: id(),
      organizationId,
      userId: user.id,
      tokenHash: input.tokenHash,
      authenticationEpoch: user.authenticationEpoch,
      authorizationEpoch: user.authorizationEpoch,
      expiresAt: input.expiresAt,
      createdAt: timestamp,
    };
    const auditRecord = this.buildAuditRecord({
      organizationId,
      actorUserId: user.id,
      actorType: "user",
      action: "auth.login_succeeded",
      entityType: "session",
      entityId: session.id,
      ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata: { expiresAt: session.expiresAt },
    });
    this.userSessions = [
      ...this.userSessions.filter(
        (candidate) => candidate.expiresAt > timestamp,
      ),
      session,
    ];
    this.auditRecords.push(auditRecord);
    return { created: true, session } as const;
  }
  async findActiveUserSession(
    userId: string,
    organizationId: string,
    tokenHash: string,
  ) {
    const timestamp = now();
    const session = this.userSessions.find(
      (candidate) =>
        candidate.userId === userId &&
        candidate.organizationId === organizationId &&
        candidate.tokenHash === tokenHash &&
        !candidate.revokedAt &&
        candidate.expiresAt > timestamp,
    );
    const user = session
      ? await this.findSessionUser(userId, organizationId)
      : null;
    return user &&
      user.authenticationEpoch === session?.authenticationEpoch &&
      user.authorizationEpoch === session.authorizationEpoch
      ? user
      : null;
  }
  async revokeUserSessionAndAudit(
    userId: string,
    organizationId: string,
    tokenHash: string,
    audit: UserMutationAuditContext,
  ) {
    const timestamp = now();
    const user = await this.findSessionUser(userId, organizationId);
    const session = this.userSessions.find(
      (candidate) =>
        candidate.userId === userId &&
        candidate.organizationId === organizationId &&
        candidate.tokenHash === tokenHash &&
        !candidate.revokedAt &&
        candidate.expiresAt > timestamp,
    );
    if (!user || !session || audit.actorUserId !== userId)
      return { revoked: false, reason: "NOT_FOUND" } as const;
    const auditRecord = this.buildAuditRecord({
      organizationId,
      actorUserId: userId,
      actorType: "user",
      action: "auth.logout",
      entityType: "session",
      entityId: session.id,
      ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata: {},
    });
    session.revokedAt = timestamp;
    this.auditRecords.push(auditRecord);
    return { revoked: true } as const;
  }
  private identityAudit(
    organizationId: string,
    action: string,
    entityType: string,
    entityId: string,
    audit: SystemIdentityMutationAuditContext,
    metadata: Record<string, unknown> = {},
  ) {
    const reason = this.identityMutationReason(audit);
    return this.buildAuditRecord({
      organizationId,
      actorType: "system",
      action,
      entityType,
      entityId,
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata: { reason, ...metadata },
    });
  }
  private identityMutationReason(audit: SystemIdentityMutationAuditContext) {
    const reason = audit.reason.trim();
    if (!reason || reason.length > 500)
      throw new Error(
        "Identity mutation reason must contain 1 to 500 characters",
      );
    return reason;
  }
  private hasOtherActiveOwner(organizationId: string, userId: string) {
    return this.users.some(
      (candidate) =>
        candidate.organizationId === organizationId &&
        candidate.id !== userId &&
        candidate.role === "OWNER" &&
        !candidate.disabledAt,
    );
  }
  async rotateUserPasswordAndAudit(
    userId: string,
    passwordHash: string,
    audit: SystemIdentityMutationAuditContext,
  ) {
    if (!isApprovedPasswordHash(passwordHash))
      throw new Error("An approved bcrypt password hash is required");
    this.identityMutationReason(audit);
    const memberships = this.users.filter((user) => user.id === userId);
    const organizationIds = [
      ...new Set(memberships.map((user) => user.organizationId)),
    ].sort();
    const epochs = new Set(memberships.map((user) => user.authenticationEpoch));
    if (organizationIds.length === 0 || epochs.size !== 1)
      return { updated: false, reason: "NOT_FOUND" } as const;
    const authenticationEpoch = memberships[0]!.authenticationEpoch + 1;
    const timestamp = now();
    const auditRecords = organizationIds.map((organizationId) =>
      this.identityAudit(
        organizationId,
        "identity.password_rotated",
        "user",
        userId,
        audit,
      ),
    );
    this.revokePendingIssuerGrants(userId, organizationIds, timestamp);
    this.users = this.users.map((user) =>
      user.id === userId
        ? { ...user, passwordHash, authenticationEpoch }
        : user,
    );
    this.userSessions = this.userSessions.map((session) =>
      session.userId === userId && !session.revokedAt
        ? { ...session, revokedAt: timestamp }
        : session,
    );
    this.auditRecords.push(...auditRecords);
    return { updated: true, affectedOrganizationIds: organizationIds } as const;
  }
  async disableUserAndAudit(
    userId: string,
    audit: SystemIdentityMutationAuditContext,
  ) {
    this.identityMutationReason(audit);
    const memberships = this.users.filter((user) => user.id === userId);
    const organizationIds = [
      ...new Set(memberships.map((user) => user.organizationId)),
    ].sort();
    const epochs = new Set(memberships.map((user) => user.authenticationEpoch));
    if (organizationIds.length === 0 || epochs.size !== 1)
      return { updated: false, reason: "NOT_FOUND" } as const;
    if (
      memberships.some(
        (membership) =>
          !membership.disabledAt &&
          membership.role === "OWNER" &&
          !this.hasOtherActiveOwner(membership.organizationId, userId),
      )
    )
      return {
        updated: false,
        reason: "OWNER_CONTINUITY_REQUIRED",
      } as const;
    const authenticationEpoch = memberships[0]!.authenticationEpoch + 1;
    const timestamp = now();
    const auditRecords = organizationIds.map((organizationId) =>
      this.identityAudit(
        organizationId,
        "identity.user_disabled",
        "user",
        userId,
        audit,
      ),
    );
    this.revokePendingIssuerGrants(userId, organizationIds, timestamp);
    this.users = this.users.map((user) =>
      user.id === userId
        ? {
            ...user,
            authenticationEpoch,
            disabledAt: timestamp,
          }
        : user,
    );
    this.userSessions = this.userSessions.map((session) =>
      session.userId === userId && !session.revokedAt
        ? { ...session, revokedAt: timestamp }
        : session,
    );
    this.auditRecords.push(...auditRecords);
    return { updated: true, affectedOrganizationIds: organizationIds } as const;
  }
  async changeMembershipRoleAndAudit(
    organizationId: string,
    userId: string,
    role: SessionUser["role"],
    audit: SystemIdentityMutationAuditContext,
  ) {
    this.identityMutationReason(audit);
    const membership = this.users.find(
      (user) => user.id === userId && user.organizationId === organizationId,
    );
    if (!membership) return { updated: false, reason: "NOT_FOUND" } as const;
    if (
      membership.role === "OWNER" &&
      role !== "OWNER" &&
      !membership.disabledAt &&
      !this.hasOtherActiveOwner(organizationId, userId)
    )
      return {
        updated: false,
        reason: "OWNER_CONTINUITY_REQUIRED",
      } as const;
    const timestamp = now();
    const auditRecord = this.identityAudit(
      organizationId,
      "identity.membership_role_changed",
      "membership",
      `${organizationId}:${userId}`,
      audit,
      { previousRole: membership.role, role },
    );
    this.revokePendingIssuerGrants(userId, [organizationId], timestamp);
    this.users = this.users.map((user) =>
      user.id === userId && user.organizationId === organizationId
        ? {
            ...user,
            role,
            authorizationEpoch: user.authorizationEpoch + 1,
          }
        : user,
    );
    this.userSessions = this.userSessions.map((session) =>
      session.userId === userId &&
      session.organizationId === organizationId &&
      !session.revokedAt
        ? { ...session, revokedAt: timestamp }
        : session,
    );
    this.auditRecords.push(auditRecord);
    return { updated: true } as const;
  }
  async removeMembershipAndAudit(
    organizationId: string,
    userId: string,
    audit: SystemIdentityMutationAuditContext,
  ) {
    this.identityMutationReason(audit);
    const membership = this.users.find(
      (user) => user.id === userId && user.organizationId === organizationId,
    );
    if (!membership) return { updated: false, reason: "NOT_FOUND" } as const;
    if (
      membership.role === "OWNER" &&
      !membership.disabledAt &&
      !this.hasOtherActiveOwner(organizationId, userId)
    )
      return {
        updated: false,
        reason: "OWNER_CONTINUITY_REQUIRED",
      } as const;
    const timestamp = now();
    const auditRecord = this.identityAudit(
      organizationId,
      "identity.membership_removed",
      "membership",
      `${organizationId}:${userId}`,
      audit,
      { previousRole: membership.role },
    );
    this.revokePendingIssuerGrants(userId, [organizationId], timestamp);
    this.userSessions = this.userSessions.map((session) =>
      session.userId === userId &&
      session.organizationId === organizationId &&
      !session.revokedAt
        ? { ...session, revokedAt: timestamp }
        : session,
    );
    this.users = this.users.filter(
      (user) => user.id !== userId || user.organizationId !== organizationId,
    );
    this.auditRecords.push(auditRecord);
    return { updated: true } as const;
  }
  private publicScreen(screen: ScreenRecord): ScreenRecord {
    const safe = { ...screen };
    delete safe.deviceTokenHash;
    const location = screen.locationId
      ? this.locations.find(
          (candidate) =>
            candidate.id === screen.locationId &&
            candidate.organizationId === screen.organizationId,
        )
      : undefined;
    if (location) safe.locationName = location.name;
    else delete safe.locationName;
    return safe;
  }
  private activeActor(
    org: string,
    actorUserId: string,
    roles: SessionUser["role"][],
  ) {
    return this.users.find(
      (user) =>
        user.id === actorUserId &&
        user.organizationId === org &&
        !user.disabledAt &&
        roles.includes(user.role),
    );
  }
  async listLocations(org: string) {
    return this.locations
      .filter((location) => location.organizationId === org)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((location) => ({ ...location }));
  }
  async createLocationAndAudit(
    org: string,
    name: string,
    audit: UserMutationAuditContext,
  ) {
    if (!this.activeActor(org, audit.actorUserId, ["OWNER", "ADMIN"]))
      return { created: false, reason: "FORBIDDEN" } as const;
    if (
      this.locations.some(
        (location) => location.organizationId === org && location.name === name,
      )
    )
      return { created: false, reason: "DUPLICATE" } as const;
    const timestamp = now();
    const location: LocationRecord = {
      id: id(),
      organizationId: org,
      name,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const auditRecord = this.buildAuditRecord({
      organizationId: org,
      actorUserId: audit.actorUserId,
      actorType: "user",
      action: "location.created",
      entityType: "location",
      entityId: location.id,
      ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata: { name },
    });
    this.locations.push(location);
    this.auditRecords.push(auditRecord);
    return { created: true, value: { ...location } } as const;
  }
  async updateLocationAndAudit(
    org: string,
    locationId: string,
    name: string,
    audit: UserMutationAuditContext,
  ) {
    if (!this.activeActor(org, audit.actorUserId, ["OWNER", "ADMIN"]))
      return { updated: false, reason: "FORBIDDEN" } as const;
    const location = this.locations.find(
      (candidate) =>
        candidate.organizationId === org && candidate.id === locationId,
    );
    if (!location) return { updated: false, reason: "NOT_FOUND" } as const;
    if (
      this.locations.some(
        (candidate) =>
          candidate.organizationId === org &&
          candidate.id !== locationId &&
          candidate.name === name,
      )
    )
      return { updated: false, reason: "DUPLICATE" } as const;
    const updatedAt = now();
    const auditRecord = this.buildAuditRecord({
      organizationId: org,
      actorUserId: audit.actorUserId,
      actorType: "user",
      action: "location.updated",
      entityType: "location",
      entityId: locationId,
      ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata: { previousName: location.name, name },
    });
    location.name = name;
    location.updatedAt = updatedAt;
    this.auditRecords.push(auditRecord);
    return { updated: true, value: { ...location } } as const;
  }
  async deleteLocationAndAudit(
    org: string,
    locationId: string,
    audit: UserMutationAuditContext,
  ) {
    if (!this.activeActor(org, audit.actorUserId, ["OWNER", "ADMIN"]))
      return { deleted: false, reason: "FORBIDDEN" } as const;
    const index = this.locations.findIndex(
      (candidate) =>
        candidate.organizationId === org && candidate.id === locationId,
    );
    if (index < 0) return { deleted: false, reason: "NOT_FOUND" } as const;
    if (
      this.screens.some(
        (screen) =>
          screen.organizationId === org && screen.locationId === locationId,
      )
    )
      return { deleted: false, reason: "IN_USE" } as const;
    const auditRecord = this.buildAuditRecord({
      organizationId: org,
      actorUserId: audit.actorUserId,
      actorType: "user",
      action: "location.deleted",
      entityType: "location",
      entityId: locationId,
      ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata: { name: this.locations[index]!.name },
    });
    this.locations.splice(index, 1);
    this.auditRecords.push(auditRecord);
    return { deleted: true } as const;
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
  async createScreen(org: string, data: ScreenMutationInput) {
    const t = now();
    const { locationId, ...screenData } = data;
    const x: ScreenRecord = {
      id: id(),
      organizationId: org,
      status: "offline",
      ...screenData,
      ...(locationId ? { locationId } : {}),
      createdAt: t,
      updatedAt: t,
    };
    this.screens.push(x);
    return x;
  }
  async createScreenAndAudit(
    org: string,
    data: ScreenMutationInput,
    audit: UserMutationAuditContext,
  ) {
    if (!this.activeActor(org, audit.actorUserId, ["OWNER", "ADMIN"]))
      return { created: false, reason: "FORBIDDEN" } as const;
    if (
      data.locationId &&
      !this.locations.some(
        (location) =>
          location.organizationId === org && location.id === data.locationId,
      )
    )
      return { created: false, reason: "INVALID_LOCATION" } as const;
    const timestamp = now();
    const { locationId, ...screenData } = data;
    const screen: ScreenRecord = {
      id: id(),
      organizationId: org,
      status: "offline",
      ...screenData,
      ...(locationId ? { locationId } : {}),
      tags: [...new Set(data.tags)],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const auditRecord = this.buildAuditRecord({
      organizationId: org,
      actorUserId: audit.actorUserId,
      actorType: "user",
      action: "screen.created",
      entityType: "screen",
      entityId: screen.id,
      ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata: { name: screen.name },
    });
    this.screens.push(screen);
    this.auditRecords.push(auditRecord);
    return { created: true, value: this.publicScreen(screen) } as const;
  }
  async updateScreen(org: string, screenId: string, data: ScreenMutationPatch) {
    const x = this.screens.find(
      (screen) => screen.organizationId === org && screen.id === screenId,
    );
    if (!x) return null;
    const { locationId, ...changes } = data;
    Object.assign(x, changes, { updatedAt: now() });
    if (locationId === null) delete x.locationId;
    else if (locationId !== undefined) x.locationId = locationId;
    return x;
  }
  async updateScreenAndAudit(
    org: string,
    screenId: string,
    data: ScreenMutationPatch,
    audit: UserMutationAuditContext,
  ) {
    if (!this.activeActor(org, audit.actorUserId, ["OWNER", "ADMIN"]))
      return { updated: false, reason: "FORBIDDEN" } as const;
    const screen = this.screens.find(
      (candidate) =>
        candidate.organizationId === org && candidate.id === screenId,
    );
    if (!screen) return { updated: false, reason: "NOT_FOUND" } as const;
    if (
      data.locationId &&
      !this.locations.some(
        (location) =>
          location.organizationId === org && location.id === data.locationId,
      )
    )
      return { updated: false, reason: "INVALID_LOCATION" } as const;
    const auditRecord = this.buildAuditRecord({
      organizationId: org,
      actorUserId: audit.actorUserId,
      actorType: "user",
      action: "screen.updated",
      entityType: "screen",
      entityId: screenId,
      ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata: {},
    });
    const { locationId, ...changes } = data;
    Object.assign(
      screen,
      changes,
      data.tags ? { tags: [...new Set(data.tags)] } : {},
      { updatedAt: now() },
    );
    if (locationId === null) delete screen.locationId;
    else if (locationId !== undefined) screen.locationId = locationId;
    this.auditRecords.push(auditRecord);
    return { updated: true, value: this.publicScreen(screen) } as const;
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
  async deleteScreenAndAudit(
    org: string,
    screenId: string,
    audit: DeviceCredentialRevokeAuditContext,
  ) {
    const actor = this.users.find(
      (u) =>
        u.id === audit.actorUserId && u.organizationId === org && !u.disabledAt,
    );
    if (actor?.role !== "OWNER" && actor?.role !== "ADMIN")
      return "FORBIDDEN" as const;
    const screen = this.screens.find(
      (x) => x.id === screenId && x.organizationId === org,
    );
    if (!screen) return "NOT_FOUND" as const;
    const auditRecord = this.buildAuditRecord({
      organizationId: org,
      actorUserId: audit.actorUserId,
      actorType: "user",
      action: "screen.decommissioned",
      entityType: "screen",
      entityId: screenId,
      ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata: {},
    });
    const timestamp = now();
    for (const credential of this.deviceCredentials) {
      if (
        credential.organizationId === org &&
        credential.screenId === screenId
      ) {
        credential.detached = true;
        credential.revokedAt ??= timestamp;
        for (const challenge of this.deviceAuthChallenges)
          if (
            challenge.credentialId === credential.id &&
            !challenge.consumedAt &&
            challenge.expiresAt > timestamp
          )
            challenge.consumedAt = timestamp;
      }
    }
    for (const grant of this.pairings)
      if (grant.targetScreenId === screenId && grant.status === "PENDING")
        grant.status = "REVOKED";
    this.screens = this.screens.filter((x) => x !== screen);
    this.auditRecords.push(auditRecord);
    return "DELETED" as const;
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
  ): Promise<AuditedPairingCreateResult> {
    if (!this.activeActor(org, audit.actorUserId, ["OWNER", "ADMIN"]))
      return { created: false, reason: "FORBIDDEN" };
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
    this.auditRecords.push(auditRecord);
    return { created: true, pairing };
  }
  async requestScreenReenrollmentAndAudit(
    org: string,
    screenId: string,
    codeHash: string,
    expiresAt: string,
    reason: string,
    audit: PairingCreateAuditContext,
  ) {
    const actor = this.users.find(
      (u) =>
        u.id === audit.actorUserId && u.organizationId === org && !u.disabledAt,
    );
    if (actor?.role !== "OWNER" && actor?.role !== "ADMIN")
      return { created: false as const, reason: "FORBIDDEN" as const };
    const screen = this.screens.find(
      (s) => s.id === screenId && s.organizationId === org,
    );
    if (!screen)
      return { created: false as const, reason: "NOT_FOUND" as const };
    const timestamp = now();
    if (
      this.pairings.some(
        (p) =>
          p.status === "PENDING" &&
          p.expiresAt > timestamp &&
          p.codeHash === codeHash,
      )
    )
      return { created: false as const, reason: "CODE_COLLISION" as const };
    const priorCredential = this.deviceCredentials.find(
      (credential) =>
        credential.organizationId === org &&
        credential.screenId === screenId &&
        !credential.detached,
    );
    const generation = (screen.credentialGeneration ?? 0) + 1;
    const pairing: PairingRecord = {
      id: id(),
      organizationId: org,
      codeHash,
      expiresAt,
      status: "PENDING",
      purpose: "REENROLL",
      targetScreenId: screenId,
      targetScreenReferenceId: screenId,
      expectedGeneration: generation,
      authorizedByUserId: audit.actorUserId,
      authorizedByMembershipId:
        actor.membershipId ?? `${actor.organizationId}:${actor.id}`,
      authorizedByAuthenticationEpoch: actor.authenticationEpoch,
      authorizedByAuthorizationEpoch: actor.authorizationEpoch,
      requestReason: reason,
      createdAt: timestamp,
      ...(priorCredential ? { priorCredentialId: priorCredential.id } : {}),
    };
    const auditRecord = this.buildAuditRecord({
      organizationId: org,
      actorUserId: audit.actorUserId,
      actorType: "user",
      action: "device.reenrollment.requested",
      entityType: "screen",
      entityId: screenId,
      ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata: {
        grantId: pairing.id,
        expectedGeneration: pairing.expectedGeneration,
        reason,
      },
    });
    this.pruneDeviceEnrollmentAuthority(org, timestamp);
    for (const p of this.pairings) {
      if (p.targetScreenId === screenId && p.status === "PENDING") {
        p.status = "REVOKED";
        for (const attempt of this.pairingAttempts)
          if (attempt.pairingCodeId === p.id && !attempt.boundCredentialId)
            attempt.cancelledAt = timestamp;
      }
    }
    for (const credential of this.deviceCredentials) {
      if (
        credential.organizationId === org &&
        credential.screenId === screenId &&
        !credential.detached
      ) {
        credential.revokedAt ??= timestamp;
        credential.detached = true;
        for (const challenge of this.deviceAuthChallenges)
          if (
            challenge.credentialId === credential.id &&
            !challenge.consumedAt &&
            challenge.expiresAt > timestamp
          )
            challenge.consumedAt = timestamp;
      }
    }
    screen.credentialRevokedAt = timestamp;
    screen.deviceTokenHash = undefined;
    screen.credentialGeneration = generation;
    screen.status = "offline";
    delete screen.lastSeenAt;
    delete screen.manifestVersion;
    delete screen.nowPlayingAssetId;
    delete screen.uptimeSeconds;
    delete screen.freeStorageBytes;
    delete screen.networkType;
    this.pairings.push(pairing);
    this.auditRecords.push(auditRecord);
    return { created: true as const, pairing };
  }
  async requestScreenEnrollmentAndAudit(
    org: string,
    screenId: string,
    _expiresAt: string,
    reason: string,
    audit: PairingCreateAuditContext,
    idempotency: ScreenEnrollmentIdempotencyInput,
  ): Promise<ScreenEnrollmentRequestResult> {
    const actor = this.users.find(
      (u) =>
        u.id === audit.actorUserId && u.organizationId === org && !u.disabledAt,
    );
    if (actor?.role !== "OWNER" && actor?.role !== "ADMIN")
      return { created: false, reason: "FORBIDDEN" };
    const timestamp = now();
    const existing = this.screenEnrollmentIdempotencyRecords.find(
      (record) =>
        record.operation === "create" &&
        record.organizationId === org &&
        record.keyHash === idempotency.keyHash,
    );
    if (existing) {
      if (
        existing.actorUserId !== audit.actorUserId ||
        existing.requestDigestSha256 !== idempotency.requestDigestSha256
      )
        return { created: false, reason: "IDEMPOTENCY_KEY_REUSED" };
      if (existing.expiresAt <= timestamp)
        return { created: false, reason: "IDEMPOTENCY_KEY_EXPIRED" };
      if (!existing.response)
        return { created: false, reason: "IDEMPOTENCY_KEY_EXPIRED" };
      const pairing = this.pairings.find(
        (candidate) => candidate.id === existing.response!.grantId,
      );
      if (!pairing)
        return { created: false, reason: "IDEMPOTENCY_KEY_EXPIRED" };
      this.pruneDeviceEnrollmentAuthority(org, timestamp, idempotency.keyHash);
      return {
        created: true,
        pairing: { ...pairing },
        codeCounter: Number(existing.response.codeCounter),
        replayed: true,
      };
    }
    const target = this.screens.find(
      (candidate) =>
        candidate.id === screenId && candidate.organizationId === org,
    );
    if (!target) return { created: false, reason: "NOT_FOUND" };
    if (
      (target.credentialGeneration ?? 0) !== 0 ||
      target.installationId ||
      target.deviceTokenHash ||
      this.deviceCredentials.some(
        (credential) =>
          credential.organizationId === org && credential.screenId === screenId,
      )
    )
      return { created: false, reason: "SCREEN_NOT_ELIGIBLE" };
    const selected = idempotency.codeCandidates.find(
      ({ codeHash }) =>
        !this.pairings.some(
          (pairing) =>
            pairing.codeHash === codeHash &&
            pairing.status === "PENDING" &&
            pairing.expiresAt > timestamp,
        ),
    );
    if (!selected) return { created: false, reason: "CODE_COLLISION" };
    const pairing: PairingRecord = {
      id: id(),
      organizationId: org,
      codeHash: selected.codeHash,
      expiresAt: new Date(
        new Date(timestamp).getTime() + 10 * 60_000,
      ).toISOString(),
      status: "PENDING",
      purpose: "NEW_SCREEN",
      targetScreenId: screenId,
      targetScreenReferenceId: screenId,
      expectedGeneration: 0,
      authorizedByUserId: actor.id,
      authorizedByMembershipId:
        actor.membershipId ?? `${actor.organizationId}:${actor.id}`,
      authorizedByAuthenticationEpoch: actor.authenticationEpoch,
      authorizedByAuthorizationEpoch: actor.authorizationEpoch,
      requestReason: reason,
      createdAt: timestamp,
    };
    const auditRecord = this.buildAuditRecord({
      organizationId: org,
      actorUserId: actor.id,
      actorType: "user",
      action: "device.enrollment.requested",
      entityType: "screen",
      entityId: screenId,
      ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata: { grantId: pairing.id, expectedGeneration: 0, reason },
    });
    this.pruneDeviceEnrollmentAuthority(org, timestamp, idempotency.keyHash);
    for (const prior of this.pairings)
      if (
        prior.organizationId === org &&
        prior.targetScreenId === screenId &&
        prior.purpose === "NEW_SCREEN" &&
        prior.status === "PENDING"
      ) {
        prior.status = "REVOKED";
        for (const attempt of this.pairingAttempts)
          if (attempt.pairingCodeId === prior.id && !attempt.boundCredentialId)
            attempt.cancelledAt ??= timestamp;
      }
    this.pairings.push(pairing);
    this.auditRecords.push(auditRecord);
    this.screenEnrollmentIdempotencyRecords.push({
      operation: "create",
      organizationId: org,
      keyHash: idempotency.keyHash,
      actorUserId: actor.id,
      requestDigestSha256: idempotency.requestDigestSha256,
      expiresAt: new Date(
        new Date(timestamp).getTime() +
          DEVICE_ENROLLMENT_AUTHORITY_RETENTION_MS,
      ).toISOString(),
      response: { grantId: pairing.id, codeCounter: selected.counter },
    });
    return {
      created: true,
      pairing: { ...pairing },
      codeCounter: selected.counter,
    };
  }
  async getReenrollmentStatus(
    org: string,
    screenId: string,
    grantId: string,
    actorUserId: string,
    purpose: "NEW_SCREEN" | "REENROLL" = "REENROLL",
  ) {
    const actor = this.users.find(
      (u) => u.id === actorUserId && u.organizationId === org && !u.disabledAt,
    );
    if (actor?.role !== "OWNER" && actor?.role !== "ADMIN") return null;
    const grant = this.pairings.find(
      (p) =>
        p.id === grantId &&
        p.organizationId === org &&
        p.targetScreenId === screenId &&
        p.purpose === purpose,
    );
    if (!grant) return null;
    const candidates = this.pairingAttempts
      .filter(
        (a) => a.pairingCodeId === grantId && !!a.provedAt && !a.cancelledAt,
      )
      .map((a) => ({
        id: a.id,
        grantId: a.pairingCodeId,
        screenId,
        keyId: a.keyId,
        fingerprint: a.keyId,
        securityLevel: a.securityLevel,
        installationId: a.installationId!,
        model: a.model!,
        osVersion: a.osVersion!,
        playerVersion: a.playerVersion!,
        provedAt: a.provedAt!,
        expiresAt: a.expiresAt,
      }));
    return {
      grantId,
      screenId,
      status:
        grant.status === "PENDING" && grant.expiresAt <= now()
          ? ("EXPIRED" as const)
          : grant.status,
      expiresAt: grant.expiresAt,
      candidates,
    };
  }
  async activateReenrollmentCandidateAndAudit(
    org: string,
    screenId: string,
    grantId: string,
    candidateId: string,
    audit: PairingCreateAuditContext,
  ): Promise<ReenrollmentActivationResult> {
    const actor = this.users.find(
      (u) =>
        u.id === audit.actorUserId && u.organizationId === org && !u.disabledAt,
    );
    if (actor?.role !== "OWNER" && actor?.role !== "ADMIN")
      return { activated: false, reason: "FORBIDDEN" };
    const attempt = this.pairingAttempts.find(
      (a) => a.id === candidateId && a.organizationId === org,
    );
    const grant = this.pairings.find(
      (p) =>
        p.id === grantId &&
        p.id === attempt?.pairingCodeId &&
        p.targetScreenId === screenId &&
        p.purpose === "REENROLL",
    );
    const issuer = this.users.find(
      (u) =>
        u.id === grant?.authorizedByUserId &&
        u.organizationId === org &&
        !u.disabledAt,
    );
    if (
      grant &&
      (!issuer ||
        (issuer.role !== "OWNER" && issuer.role !== "ADMIN") ||
        (issuer.membershipId ?? `${org}:${issuer.id}`) !==
          grant.authorizedByMembershipId ||
        issuer.authenticationEpoch !== grant.authorizedByAuthenticationEpoch ||
        issuer.authorizationEpoch !== grant.authorizedByAuthorizationEpoch)
    )
      return { activated: false, reason: "STALE" };
    if (
      (attempt?.consumedAt || attempt?.activatedAt) &&
      attempt.boundCredentialId
    ) {
      const credential = this.deviceCredentials.find(
        (c) => c.id === attempt.boundCredentialId,
      );
      const screen = this.screens.find(
        (s) => s.id === screenId && s.organizationId === org,
      );
      return credential &&
        screen &&
        !credential.revokedAt &&
        !credential.detached &&
        screen.credentialGeneration === (grant?.expectedGeneration ?? -2) + 1
        ? {
            activated: true,
            credential: { ...credential },
            screen: this.publicScreen(screen),
          }
        : { activated: false, reason: "STALE" };
    }
    if (!attempt || !grant || !attempt.provedAt || attempt.cancelledAt)
      return { activated: false, reason: "NOT_FOUND" };
    const screen = this.screens.find(
      (s) => s.id === screenId && s.organizationId === org,
    );
    if (
      !screen ||
      grant.status !== "PENDING" ||
      grant.expiresAt <= now() ||
      grant.expectedGeneration !== (screen.credentialGeneration ?? 0)
    )
      return { activated: false, reason: "STALE" };
    if (
      this.deviceCredentials.some((c) => c.keyId === attempt.keyId) ||
      this.usedDeviceKeyIds.has(attempt.keyId)
    )
      return { activated: false, reason: "STALE" };
    const timestamp = now();
    const credential: DeviceCredentialRecord = {
      id: id(),
      organizationId: org,
      screenId,
      detached: false,
      keyId: attempt.keyId,
      publicKeySpki: attempt.publicKeySpki,
      algorithm: "ES256",
      securityLevel: attempt.securityLevel,
      ...(attempt.credentialExpiresAt
        ? { expiresAt: attempt.credentialExpiresAt }
        : {}),
      createdAt: timestamp,
    };
    const auditRecord = this.buildAuditRecord({
      organizationId: org,
      actorUserId: audit.actorUserId,
      actorType: "user",
      action: "device.reenrollment.activated",
      entityType: "screen",
      entityId: screenId,
      ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata: {
        grantId: grant.id,
        candidateId,
        credentialId: credential.id,
        keyId: credential.keyId,
        reason: grant.requestReason,
      },
    });
    Object.assign(screen, {
      installationId: attempt.installationId,
      model: attempt.model,
      osVersion: attempt.osVersion,
      playerVersion: attempt.playerVersion,
      credentialRevokedAt: undefined,
      deviceTokenHash: undefined,
      credentialGeneration: (screen.credentialGeneration ?? 0) + 1,
      status: "offline",
      updatedAt: timestamp,
    });
    delete screen.lastSeenAt;
    delete screen.manifestVersion;
    delete screen.nowPlayingAssetId;
    delete screen.uptimeSeconds;
    delete screen.freeStorageBytes;
    delete screen.networkType;
    this.deviceCredentials.push(credential);
    this.usedDeviceKeyIds.add(credential.keyId);
    attempt.activatedAt = timestamp;
    attempt.boundCredentialId = credential.id;
    grant.status = "CLAIMED";
    grant.screenId = screenId;
    for (const a of this.pairingAttempts)
      if (a.pairingCodeId === grant.id && a.id !== attempt.id)
        a.cancelledAt ??= timestamp;
    for (const p of this.pairings)
      if (p.targetScreenId === screenId && p.status === "PENDING")
        p.status = "REVOKED";
    this.auditRecords.push(auditRecord);
    return { activated: true, screen: this.publicScreen(screen), credential };
  }
  async activateScreenEnrollmentCandidateAndAudit(
    org: string,
    screenId: string,
    grantId: string,
    candidateId: string,
    fingerprint: string,
    audit: PairingCreateAuditContext,
    idempotency: ScreenEnrollmentActivationIdempotencyInput,
  ): Promise<ScreenEnrollmentActivationResult> {
    const actor = this.users.find(
      (user) =>
        user.id === audit.actorUserId &&
        user.organizationId === org &&
        !user.disabledAt,
    );
    if (actor?.role !== "OWNER" && actor?.role !== "ADMIN")
      return { activated: false, reason: "FORBIDDEN" };
    const timestamp = now();
    const existing = this.screenEnrollmentIdempotencyRecords.find(
      (record) =>
        record.operation === "activate" &&
        record.organizationId === org &&
        record.keyHash === idempotency.keyHash,
    );
    if (existing) {
      if (
        existing.actorUserId !== actor.id ||
        existing.requestDigestSha256 !== idempotency.requestDigestSha256
      )
        return { activated: false, reason: "IDEMPOTENCY_KEY_REUSED" };
      if (existing.expiresAt <= timestamp)
        return { activated: false, reason: "IDEMPOTENCY_KEY_EXPIRED" };
      if (!existing.response)
        return { activated: false, reason: "IDEMPOTENCY_KEY_EXPIRED" };
      const credential = this.deviceCredentials.find(
        (value) => value.id === existing.response!.credentialId,
      );
      const target = this.screens.find(
        (value) => value.id === screenId && value.organizationId === org,
      );
      if (!credential || !target) return { activated: false, reason: "STALE" };
      const screen = this.publicScreen(target);
      this.pruneDeviceEnrollmentAuthority(org, timestamp, idempotency.keyHash);
      return {
        activated: true,
        credential: { ...credential },
        screen,
        replayed: true,
      };
    }
    const target = this.screens.find(
      (value) => value.id === screenId && value.organizationId === org,
    );
    const grant = this.pairings.find(
      (value) =>
        value.id === grantId &&
        value.organizationId === org &&
        value.targetScreenId === screenId &&
        value.purpose === "NEW_SCREEN",
    );
    const attempt = this.pairingAttempts.find(
      (value) =>
        value.id === candidateId &&
        value.organizationId === org &&
        value.pairingCodeId === grantId,
    );
    if (!target || !grant || !attempt)
      return { activated: false, reason: "NOT_FOUND" };
    if (attempt.keyId !== fingerprint)
      return { activated: false, reason: "FINGERPRINT_MISMATCH" };
    const issuer = this.users.find(
      (user) =>
        user.id === grant.authorizedByUserId &&
        user.organizationId === org &&
        !user.disabledAt,
    );
    if (
      !issuer ||
      (issuer.role !== "OWNER" && issuer.role !== "ADMIN") ||
      (issuer.membershipId ?? `${org}:${issuer.id}`) !==
        grant.authorizedByMembershipId ||
      issuer.authenticationEpoch !== grant.authorizedByAuthenticationEpoch ||
      issuer.authorizationEpoch !== grant.authorizedByAuthorizationEpoch ||
      grant.status !== "PENDING" ||
      grant.expiresAt <= timestamp ||
      !attempt.provedAt ||
      attempt.cancelledAt ||
      attempt.activatedAt ||
      (target.credentialGeneration ?? 0) !== grant.expectedGeneration ||
      grant.expectedGeneration !== 0 ||
      target.installationId ||
      target.deviceTokenHash ||
      this.deviceCredentials.some(
        (credential) =>
          credential.organizationId === org && credential.screenId === screenId,
      ) ||
      this.usedDeviceKeyIds.has(attempt.keyId)
    )
      return { activated: false, reason: "STALE" };
    const credential: DeviceCredentialRecord = {
      id: id(),
      organizationId: org,
      screenId,
      detached: false,
      keyId: attempt.keyId,
      publicKeySpki: attempt.publicKeySpki,
      algorithm: "ES256",
      securityLevel: attempt.securityLevel,
      ...(attempt.credentialExpiresAt
        ? { expiresAt: attempt.credentialExpiresAt }
        : {}),
      createdAt: timestamp,
    };
    const auditRecord = this.buildAuditRecord({
      organizationId: org,
      actorUserId: actor.id,
      actorType: "user",
      action: "device.enrollment.activated",
      entityType: "screen",
      entityId: screenId,
      ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata: {
        grantId,
        candidateId,
        credentialId: credential.id,
        keyId: credential.keyId,
        reason: grant.requestReason,
      },
    });
    this.pruneDeviceEnrollmentAuthority(org, timestamp, idempotency.keyHash);
    Object.assign(target, {
      installationId: attempt.installationId,
      model: attempt.model,
      osVersion: attempt.osVersion,
      playerVersion: attempt.playerVersion,
      credentialRevokedAt: undefined,
      deviceTokenHash: undefined,
      credentialGeneration: 1,
      status: "offline",
      updatedAt: timestamp,
    });
    delete target.lastSeenAt;
    delete target.manifestVersion;
    delete target.nowPlayingAssetId;
    delete target.uptimeSeconds;
    delete target.freeStorageBytes;
    delete target.networkType;
    this.deviceCredentials.push(credential);
    this.usedDeviceKeyIds.add(credential.keyId);
    attempt.activatedAt = timestamp;
    attempt.boundCredentialId = credential.id;
    grant.status = "CLAIMED";
    grant.claimedAt = timestamp;
    grant.screenId = screenId;
    for (const candidate of this.pairingAttempts)
      if (candidate.pairingCodeId === grantId && candidate.id !== candidateId)
        candidate.cancelledAt ??= timestamp;
    for (const competitor of this.pairings)
      if (
        competitor.id !== grantId &&
        competitor.organizationId === org &&
        competitor.targetScreenId === screenId &&
        competitor.status === "PENDING"
      ) {
        competitor.status = "REVOKED";
        for (const candidate of this.pairingAttempts)
          if (
            candidate.pairingCodeId === competitor.id &&
            !candidate.boundCredentialId
          )
            candidate.cancelledAt ??= timestamp;
      }
    this.auditRecords.push(auditRecord);
    this.screenEnrollmentIdempotencyRecords.push({
      operation: "activate",
      organizationId: org,
      keyHash: idempotency.keyHash,
      actorUserId: actor.id,
      requestDigestSha256: idempotency.requestDigestSha256,
      expiresAt: new Date(
        new Date(timestamp).getTime() +
          DEVICE_ENROLLMENT_AUTHORITY_RETENTION_MS,
      ).toISOString(),
      response: { credentialId: credential.id },
    });
    return { activated: true, screen: this.publicScreen(target), credential };
  }
  async cancelScreenReenrollmentAndAudit(
    org: string,
    screenId: string,
    grantId: string,
    audit: PairingCreateAuditContext,
    purpose: "NEW_SCREEN" | "REENROLL" = "REENROLL",
  ) {
    const actor = this.users.find(
      (u) =>
        u.id === audit.actorUserId && u.organizationId === org && !u.disabledAt,
    );
    if (actor?.role !== "OWNER" && actor?.role !== "ADMIN")
      return { cancelled: false as const, reason: "FORBIDDEN" as const };
    const grant = this.pairings.find(
      (p) =>
        p.id === grantId &&
        p.organizationId === org &&
        p.targetScreenId === screenId &&
        p.purpose === purpose &&
        p.status === "PENDING",
    );
    if (!grant)
      return { cancelled: false as const, reason: "NOT_FOUND" as const };
    const auditRecord = this.buildAuditRecord({
      organizationId: org,
      actorUserId: audit.actorUserId,
      actorType: "user",
      action:
        purpose === "REENROLL"
          ? "device.reenrollment.cancelled"
          : "device.enrollment.cancelled",
      entityType: "screen",
      entityId: screenId,
      metadata: { grantId: grant.id },
    });
    const timestamp = now();
    grant.status = "REVOKED";
    for (const a of this.pairingAttempts)
      if (a.pairingCodeId === grant.id && !a.consumedAt)
        a.cancelledAt = timestamp;
    this.auditRecords.push(auditRecord);
    return { cancelled: true as const };
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
    prepared?: { screenId: string; timestamp: string },
  ): ScreenRecord | null {
    const p = this.claimablePairing(codeHash);
    if (!p) return null;
    const t = prepared?.timestamp ?? now();
    const x: ScreenRecord = {
      id: prepared?.screenId ?? id(),
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
  private claimablePairing(codeHash: string) {
    return this.pairings.find(
      (x) =>
        x.codeHash === codeHash &&
        (x.purpose ?? "NEW_SCREEN") === "NEW_SCREEN" &&
        !x.targetScreenId &&
        !x.authorizedByUserId &&
        x.status === "PENDING" &&
        x.expiresAt > now(),
    );
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
    const pairing = this.claimablePairing(codeHash);
    if (!pairing) return null;
    const metadata = {
      ...audit.metadata,
      installationId: device.installationId,
    };
    const prepared = { screenId: id(), timestamp: now() };
    const auditRecord = this.buildAuditRecord({
      organizationId: pairing.organizationId,
      actorType: "device",
      action: "device.paired",
      entityType: "screen",
      entityId: prepared.screenId,
      ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata,
    });
    const screen = this.claimPairingRecord(
      codeHash,
      device,
      tokenHash,
      prepared,
    );
    if (!screen) return null;
    this.auditRecords.push(auditRecord);
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
    const issuer = pairing?.authorizedByUserId
      ? this.users.find(
          (user) =>
            user.id === pairing.authorizedByUserId &&
            user.organizationId === pairing.organizationId &&
            !user.disabledAt,
        )
      : undefined;
    const issuerIsCurrent = pairing?.authorizedByUserId
      ? issuer &&
        (issuer.role === "OWNER" || issuer.role === "ADMIN") &&
        (!pairing.authorizedByMembershipId ||
          (issuer.membershipId ?? `${issuer.organizationId}:${issuer.id}`) ===
            pairing.authorizedByMembershipId) &&
        (pairing.authorizedByAuthenticationEpoch === undefined ||
          issuer.authenticationEpoch ===
            pairing.authorizedByAuthenticationEpoch) &&
        (pairing.authorizedByAuthorizationEpoch === undefined ||
          issuer.authorizationEpoch === pairing.authorizedByAuthorizationEpoch)
      : !pairing?.targetScreenId;
    const lifetime =
      new Date(input.expiresAt).getTime() - new Date(createdAt).getTime();
    if (
      !pairing ||
      !issuerIsCurrent ||
      lifetime <= 0 ||
      lifetime > 45_000 ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.credential.keyId) ||
      !/^[0-9a-f]{64}$/.test(input.challengeHashSha256) ||
      !/^[0-9a-f]{64}$/.test(input.transcriptDigestSha256) ||
      this.deviceCredentials.some(
        (candidate) => candidate.keyId === input.credential.keyId,
      ) ||
      this.usedDeviceKeyIds.has(input.credential.keyId) ||
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
    if (
      (attempt.consumedAt || attempt.activatedAt) &&
      attempt.boundCredentialId
    ) {
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
      (pairing.purpose === "REENROLL" || pairing.purpose === "NEW_SCREEN") &&
      attempt.provedAt &&
      !attempt.cancelledAt &&
      pairing.status === "PENDING" &&
      pairing.expiresAt > now()
    ) {
      return {
        paired: false as const,
        reason: "PENDING_APPROVAL" as const,
        grantId: pairing.id,
        candidateId: attempt.id,
        keyId: attempt.keyId,
        expiresAt: pairing.expiresAt,
      };
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
    if (pairing.purpose === "REENROLL" || pairing.purpose === "NEW_SCREEN") {
      const issuer = this.users.find(
        (user) =>
          user.id === pairing.authorizedByUserId &&
          user.organizationId === pairing.organizationId &&
          !user.disabledAt,
      );
      if (
        !pairing.targetScreenId ||
        (issuer?.role !== "OWNER" && issuer?.role !== "ADMIN") ||
        (pairing.authorizedByMembershipId !== undefined &&
          ((issuer.membershipId ?? `${issuer.organizationId}:${issuer.id}`) !==
            pairing.authorizedByMembershipId ||
            issuer.authenticationEpoch !==
              pairing.authorizedByAuthenticationEpoch ||
            issuer.authorizationEpoch !==
              pairing.authorizedByAuthorizationEpoch)) ||
        this.pairingAttempts.filter(
          (candidate) =>
            candidate.pairingCodeId === pairing.id &&
            !!candidate.provedAt &&
            !candidate.cancelledAt,
        ).length >= 4
      )
        return { paired: false as const, reason: "INVALID" as const };
      const provedAt = now();
      const auditRecord = this.buildAuditRecord({
        organizationId: pairing.organizationId,
        actorType: "device",
        action:
          pairing.purpose === "REENROLL"
            ? "device.reenrollment.candidate_proved"
            : "device.enrollment.candidate_proved",
        entityType: "screen",
        entityId: pairing.targetScreenId,
        ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
        ...(audit.requestId ? { requestId: audit.requestId } : {}),
        metadata: {
          grantId: pairing.id,
          candidateId: attempt.id,
          keyId: attempt.keyId,
          installationId: input.device.installationId,
        },
      });
      Object.assign(attempt, {
        provedAt,
        installationId: input.device.installationId,
        model: input.device.model,
        osVersion: input.device.osVersion,
        playerVersion: input.device.playerVersion,
      });
      this.auditRecords.push(auditRecord);
      return {
        paired: false as const,
        reason: "PENDING_APPROVAL" as const,
        grantId: pairing.id,
        candidateId: attempt.id,
        keyId: attempt.keyId,
        expiresAt: pairing.expiresAt,
      };
    }
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
    this.usedDeviceKeyIds.add(credential.keyId);
    pairing.status = "CLAIMED";
    pairing.screenId = screen.id;
    attempt.consumedAt = timestamp;
    attempt.boundCredentialId = credential.id;
    this.auditRecords.push(auditRecord);
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
      id: this.createDeviceAuthChallengeId(),
      organizationId: authenticated.credential.organizationId,
      credentialId: authenticated.credential.id,
      challengeHashSha256: input.challengeHashSha256,
      operation: input.operation,
      requestDigestSha256: input.requestDigestSha256,
      expiresAt: input.expiresAt,
      createdAt,
    };
    this.pruneOldDeviceAuthChallenges(createdAt);
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
    const credentialGeneration = active?.screen.credentialGeneration ?? 0;
    if (
      !active ||
      !challenge ||
      challenge.consumedAt ||
      challenge.expiresAt <= now() ||
      challenge.challengeHashSha256 !== input.challengeHashSha256 ||
      challenge.operation !== input.operation ||
      challenge.requestDigestSha256 !== input.requestDigestSha256
    )
      return null;
    if (!(await verify({ ...active.credential }))) return null;
    const currentActive = this.activeDeviceCredential(input.credentialId);
    const currentChallenge = this.deviceAuthChallenges.find(
      (candidate) => candidate.id === input.challengeId,
    );
    const consumedAt = now();
    if (
      !currentActive ||
      currentActive.credential !== active.credential ||
      currentActive.screen !== active.screen ||
      (currentActive.screen.credentialGeneration ?? 0) !==
        credentialGeneration ||
      currentChallenge !== challenge ||
      (currentActive.credential.expiresAt !== undefined &&
        currentActive.credential.expiresAt <= consumedAt) ||
      challenge.credentialId !== input.credentialId ||
      challenge.organizationId !== currentActive.credential.organizationId ||
      challenge.consumedAt ||
      challenge.expiresAt <= consumedAt ||
      challenge.challengeHashSha256 !== input.challengeHashSha256 ||
      challenge.operation !== input.operation ||
      challenge.requestDigestSha256 !== input.requestDigestSha256
    )
      return null;
    challenge.consumedAt = consumedAt;
    return currentActive;
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
    data: HeartbeatUpdateInput,
    verify: DeviceProofVerifier,
  ) {
    const active = await this.consumeDeviceProof(input, verify);
    if (!active)
      return {
        authenticated: false as const,
        reason: "INVALID_PROOF" as const,
      };
    Object.assign(active.screen, {
      playerVersion: data.playerVersion,
      uptimeSeconds: data.uptimeSeconds,
      freeStorageBytes: data.freeStorageBytes,
      networkType: data.networkType,
      status: "online",
      lastSeenAt: now(),
      updatedAt: now(),
    });
    if (data.manifestVersion === null) delete active.screen.manifestVersion;
    else active.screen.manifestVersion = data.manifestVersion;
    if (data.nowPlayingAssetId === null) delete active.screen.nowPlayingAssetId;
    else active.screen.nowPlayingAssetId = data.nowPlayingAssetId;
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
    const credential =
      this.deviceCredentials.find(
        (candidate) =>
          candidate.screenId === screenId &&
          candidate.organizationId === org &&
          !candidate.detached,
      ) ??
      this.deviceCredentials.find(
        (candidate) =>
          candidate.screenId === screenId &&
          candidate.organizationId === org &&
          !!candidate.revokedAt,
      );
    const screen = this.screens.find(
      (candidate) =>
        candidate.id === screenId && candidate.organizationId === org,
    );
    if (!screen)
      return { revoked: false as const, reason: "NOT_FOUND" as const };
    if (!credential || credential.revokedAt) {
      const pending = this.pairings.filter(
        (grant) =>
          grant.organizationId === org &&
          grant.targetScreenId === screenId &&
          grant.status === "PENDING",
      );
      if (pending.length === 0)
        return credential
          ? { revoked: false as const, reason: "ALREADY_REVOKED" as const }
          : { revoked: false as const, reason: "NOT_FOUND" as const };
      const reassertedAt = now();
      const auditRecord = this.buildAuditRecord({
        organizationId: org,
        actorUserId: audit.actorUserId,
        actorType: "user",
        action: "device.credential.revocation_reasserted",
        entityType: credential ? "device_credential" : "screen",
        entityId: credential?.id ?? screenId,
        ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
        ...(audit.requestId ? { requestId: audit.requestId } : {}),
        metadata: { screenId, cancelledGrantIds: pending.map((x) => x.id) },
      });
      for (const grant of pending) {
        grant.status = "REVOKED";
        for (const attempt of this.pairingAttempts)
          if (attempt.pairingCodeId === grant.id && !attempt.consumedAt)
            attempt.cancelledAt = reassertedAt;
      }
      screen.credentialGeneration = (screen.credentialGeneration ?? 0) + 1;
      screen.credentialRevokedAt = reassertedAt;
      screen.deviceTokenHash = undefined;
      screen.status = "offline";
      delete screen.lastSeenAt;
      delete screen.manifestVersion;
      delete screen.nowPlayingAssetId;
      delete screen.uptimeSeconds;
      delete screen.freeStorageBytes;
      delete screen.networkType;
      this.auditRecords.push(auditRecord);
      return {
        revoked: true as const,
        ...(credential ? { credential: { ...credential } } : {}),
      };
    }
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
    credential.detached = true;
    screen.credentialRevokedAt = revokedAt;
    screen.deviceTokenHash = undefined;
    screen.credentialGeneration = (screen.credentialGeneration ?? 0) + 1;
    screen.status = "offline";
    delete screen.lastSeenAt;
    delete screen.manifestVersion;
    delete screen.nowPlayingAssetId;
    delete screen.uptimeSeconds;
    delete screen.freeStorageBytes;
    delete screen.networkType;
    for (const challenge of this.deviceAuthChallenges) {
      if (
        challenge.credentialId === credential.id &&
        !challenge.consumedAt &&
        challenge.expiresAt > revokedAt
      )
        challenge.consumedAt = revokedAt;
    }
    for (const grant of this.pairings) {
      if (grant.targetScreenId === screenId && grant.status === "PENDING") {
        grant.status = "REVOKED";
        for (const attempt of this.pairingAttempts)
          if (attempt.pairingCodeId === grant.id && !attempt.consumedAt)
            attempt.cancelledAt = revokedAt;
      }
    }
    this.auditRecords.push(auditRecord);
    return { revoked: true as const, credential: { ...credential } };
  }
  async heartbeat(screenId: string, data: HeartbeatUpdateInput) {
    const x = this.screens.find((s) => s.id === screenId);
    if (!x) return null;
    Object.assign(x, {
      playerVersion: data.playerVersion,
      uptimeSeconds: data.uptimeSeconds,
      freeStorageBytes: data.freeStorageBytes,
      networkType: data.networkType,
      status: "online",
      lastSeenAt: now(),
      updatedAt: now(),
    });
    if (data.manifestVersion === null) delete x.manifestVersion;
    else x.manifestVersion = data.manifestVersion;
    if (data.nowPlayingAssetId === null) delete x.nowPlayingAssetId;
    else x.nowPlayingAssetId = data.nowPlayingAssetId;
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
    const assetId = id();
    const x: MediaRecord = {
      id: assetId,
      organizationId: org,
      ...data,
      storageKey: mediaStorageKey(org, assetId, data.checksumSha256),
      createdAt: t,
      updatedAt: t,
    };
    this.media.push(x);
    return x;
  }
  async createMediaAndAudit(
    org: string,
    data: Omit<
      MediaRecord,
      "id" | "organizationId" | "createdAt" | "updatedAt"
    >,
    audit: UserMutationAuditContext,
  ) {
    if (
      !this.activeActor(org, audit.actorUserId, ["OWNER", "ADMIN", "PUBLISHER"])
    )
      return { created: false, reason: "FORBIDDEN" } as const;
    const timestamp = now();
    const assetId = id();
    const media: MediaRecord = {
      id: assetId,
      organizationId: org,
      ...data,
      storageKey: mediaStorageKey(org, assetId, data.checksumSha256),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const auditRecord = this.buildAuditRecord({
      organizationId: org,
      actorUserId: audit.actorUserId,
      actorType: "user",
      action: "media.created",
      entityType: "media",
      entityId: media.id,
      ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata: { name: media.name },
    });
    this.media.push(media);
    this.auditRecords.push(auditRecord);
    return { created: true, value: media } as const;
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
  async deleteMediaAndAudit(
    org: string,
    assetId: string,
    audit: UserMutationAuditContext,
  ) {
    if (
      !this.activeActor(org, audit.actorUserId, ["OWNER", "ADMIN", "PUBLISHER"])
    )
      return { deleted: false, reason: "FORBIDDEN" } as const;
    if (
      !this.media.some(
        (asset) => asset.organizationId === org && asset.id === assetId,
      )
    )
      return { deleted: false, reason: "NOT_FOUND" } as const;
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
      return { deleted: false, reason: "IN_USE" } as const;
    const auditRecord = this.buildAuditRecord({
      organizationId: org,
      actorUserId: audit.actorUserId,
      actorType: "user",
      action: "media.deleted",
      entityType: "media",
      entityId: assetId,
      ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata: {},
    });
    this.media = this.media.filter(
      (asset) => !(asset.organizationId === org && asset.id === assetId),
    );
    this.auditRecords.push(auditRecord);
    return { deleted: true } as const;
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
  async createPlaylistAndAudit(
    org: string,
    data: Pick<PlaylistRecord, "name" | "description" | "items">,
    audit: UserMutationAuditContext,
  ) {
    if (
      !this.activeActor(org, audit.actorUserId, ["OWNER", "ADMIN", "PUBLISHER"])
    )
      return { created: false, reason: "FORBIDDEN" } as const;
    if (
      data.items.some(
        (item) =>
          !this.media.some(
            (asset) =>
              asset.organizationId === org && asset.id === item.assetId,
          ),
      )
    )
      return { created: false, reason: "INVALID_ASSET" } as const;
    const timestamp = now();
    const playlist: PlaylistRecord = {
      id: id(),
      organizationId: org,
      ...data,
      items: data.items.map((item) => ({ ...item, id: id() })),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const auditRecord = this.buildAuditRecord({
      organizationId: org,
      actorUserId: audit.actorUserId,
      actorType: "user",
      action: "playlist.created",
      entityType: "playlist",
      entityId: playlist.id,
      ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata: { itemCount: playlist.items.length },
    });
    this.playlists.push(playlist);
    this.auditRecords.push(auditRecord);
    return { created: true, value: playlist } as const;
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
  async deletePlaylistAndAudit(
    org: string,
    playlistId: string,
    audit: UserMutationAuditContext,
  ) {
    if (
      !this.activeActor(org, audit.actorUserId, ["OWNER", "ADMIN", "PUBLISHER"])
    )
      return { deleted: false, reason: "FORBIDDEN" } as const;
    if (
      !this.playlists.some(
        (playlist) =>
          playlist.organizationId === org && playlist.id === playlistId,
      )
    )
      return { deleted: false, reason: "NOT_FOUND" } as const;
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
      return { deleted: false, reason: "IN_USE" } as const;
    const auditRecord = this.buildAuditRecord({
      organizationId: org,
      actorUserId: audit.actorUserId,
      actorType: "user",
      action: "playlist.deleted",
      entityType: "playlist",
      entityId: playlistId,
      ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata: {},
    });
    this.playlists = this.playlists.filter(
      (playlist) =>
        !(playlist.organizationId === org && playlist.id === playlistId),
    );
    this.auditRecords.push(auditRecord);
    return { deleted: true } as const;
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
      startsAt: canonicalUtcInstant(data.startsAt),
      ...(data.endsAt ? { endsAt: canonicalUtcInstant(data.endsAt) } : {}),
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
    idempotency: SchedulePublicationIdempotencyInput,
  ): Promise<SchedulePublicationResult> {
    if (
      !/^[0-9a-f]{64}$/.test(idempotency.keyHash) ||
      !/^[0-9a-f]{64}$/.test(idempotency.requestDigestSha256)
    )
      throw new Error("Canonical publication idempotency hashes are required");
    const actor = this.users.find(
      (candidate) =>
        candidate.id === audit.actorUserId &&
        candidate.organizationId === org &&
        !candidate.disabledAt,
    );
    if (!hasCapability(actor?.role, CAPABILITIES.releasePublish))
      return { published: false, reason: "FORBIDDEN" };
    const timestamp = now();
    const existingIdempotency = this.idempotencyRecords.find(
      (candidate) =>
        candidate.organizationId === org &&
        candidate.operation === SCHEDULE_PUBLICATION_IDEMPOTENCY_OPERATION &&
        candidate.keyHash === idempotency.keyHash,
    );
    if (existingIdempotency) {
      if (
        existingIdempotency.actorUserId !== audit.actorUserId ||
        existingIdempotency.requestDigestSha256 !==
          idempotency.requestDigestSha256
      )
        return { published: false, reason: "IDEMPOTENCY_KEY_REUSED" };
      if (
        existingIdempotency.expiresAt <= timestamp ||
        !existingIdempotency.response
      ) {
        return { published: false, reason: "IDEMPOTENCY_KEY_EXPIRED" };
      }
      const schedule = structuredClone(existingIdempotency.response);
      const release = this.releases.find(
        (candidate) =>
          candidate.organizationId === org &&
          candidate.id === schedule.releaseId,
      );
      const assignment = this.releaseAssignments.find(
        (candidate) =>
          candidate.organizationId === org &&
          candidate.id === schedule.assignmentId,
      );
      if (!release || !assignment)
        throw new Error("Idempotent publication references are missing");
      this.compactExpiredIdempotencyResponses(timestamp);
      return { published: true, schedule, release, assignment, replayed: true };
    }
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
    const mediaFailure = mediaPublicationFailure(sourceAssets, new Date());
    if (mediaFailure) return { published: false, reason: mediaFailure };

    let snapshot;
    try {
      snapshot = canonicalReleaseSnapshot(playlist, sourceAssets);
    } catch (error) {
      if (error instanceof ReleaseSnapshotError)
        return { published: false, reason: error.reason };
      throw error;
    }

    const digestSha256 = releaseSnapshotDigest(snapshot);
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
      startsAt: canonicalUtcInstant(data.startsAt),
      ...(data.endsAt ? { endsAt: canonicalUtcInstant(data.endsAt) } : {}),
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
      const result = {
        published: true,
        schedule: duplicateSchedule,
        release: duplicateRelease,
        assignment: duplicateAssignment,
      } as const;
      this.rememberSchedulePublication(
        org,
        audit,
        idempotency,
        result,
        timestamp,
      );
      this.compactExpiredIdempotencyResponses(timestamp);
      return result;
    }
    const schedule: ScheduleRecord = {
      id: scheduleId,
      organizationId: org,
      ...data,
      startsAt: frozenSchedule.startsAt,
      ...(frozenSchedule.endsAt ? { endsAt: frozenSchedule.endsAt } : {}),
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
    this.auditRecords.push(auditRecord);
    const result = { published: true, schedule, release, assignment } as const;
    this.rememberSchedulePublication(
      org,
      audit,
      idempotency,
      result,
      timestamp,
    );
    this.compactExpiredIdempotencyResponses(timestamp);
    return result;
  }

  private rememberSchedulePublication(
    org: string,
    audit: ReleaseAuditContext,
    idempotency: SchedulePublicationIdempotencyInput,
    response: Extract<SchedulePublicationResult, { published: true }>,
    createdAt: string,
  ) {
    this.idempotencyRecords.push({
      organizationId: org,
      operation: SCHEDULE_PUBLICATION_IDEMPOTENCY_OPERATION,
      keyHash: idempotency.keyHash,
      actorUserId: audit.actorUserId,
      requestDigestSha256: idempotency.requestDigestSha256,
      response: structuredClone(response.schedule),
      createdAt,
      expiresAt: new Date(
        new Date(createdAt).getTime() +
          SCHEDULE_PUBLICATION_RESPONSE_RETENTION_MS,
      ).toISOString(),
    });
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
    this.auditRecords.push(auditRecord);
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
      return release && hasValidStoredAssignmentDigest(assignment, release)
        ? [{ release, assignment }]
        : [];
    });
  }
  async authorizeMediaDelivery(
    input: MediaDeliveryAuthorizationInput,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1)
      return false;
    const at = new Date(input.at);
    if (!Number.isFinite(at.getTime())) return false;
    const assignment = this.releaseAssignments.find(
      (candidate) =>
        candidate.id === input.assignmentId &&
        candidate.organizationId === input.organizationId,
    );
    if (
      !assignment ||
      assignment.digestSha256 !== input.assignmentDigestSha256 ||
      assignment.state !== "ASSIGNED" ||
      this.latestAssignment(assignment.scheduleId)?.id !== assignment.id ||
      !assignment.screenIds.includes(input.screenId) ||
      !assignment.schedule.enabled ||
      assignment.schedule.startsAt > input.at ||
      (assignment.schedule.endsAt && assignment.schedule.endsAt <= input.at) ||
      !matchesScheduleWindow(assignment.schedule, at)
    )
      return false;
    const release = this.releases.find(
      (candidate) =>
        candidate.id === assignment.releaseId &&
        candidate.organizationId === input.organizationId,
    );
    if (!release || !hasValidStoredAssignmentDigest(assignment, release))
      return false;
    return Boolean(
      release.items.some(
        (item) =>
          item.asset.id === input.assetId &&
          item.asset.storageKey === input.storageKey &&
          item.asset.checksumSha256 === input.checksumSha256 &&
          item.asset.sizeBytes === input.sizeBytes &&
          (!item.asset.expiresAt || item.asset.expiresAt > input.at),
      ),
    );
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
  async activateEmergencyAndAudit(
    org: string,
    data: Pick<
      EmergencyRecord,
      "title" | "message" | "backgroundColor" | "targetScreenIds" | "expiresAt"
    >,
    audit: UserMutationAuditContext,
  ) {
    const actor = this.activeActor(org, audit.actorUserId, ["OWNER", "ADMIN"]);
    if (!hasCapability(actor?.role, CAPABILITIES.emergencyActivate))
      return { activated: false, reason: "FORBIDDEN" } as const;
    const targetScreenIds = [...new Set(data.targetScreenIds)].sort();
    if (
      targetScreenIds.some(
        (screenId) =>
          !this.screens.some(
            (screen) => screen.organizationId === org && screen.id === screenId,
          ),
      )
    )
      return { activated: false, reason: "INVALID_SCREEN" } as const;
    const timestamp = now();
    const emergency: EmergencyRecord = {
      id: id(),
      organizationId: org,
      createdById: audit.actorUserId,
      startsAt: timestamp,
      ...data,
      targetScreenIds,
      createdAt: timestamp,
    };
    const auditRecord = this.buildAuditRecord({
      organizationId: org,
      actorUserId: audit.actorUserId,
      actorType: "user",
      action: "emergency.activated",
      entityType: "emergency",
      entityId: emergency.id,
      ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata: {
        targetCount: targetScreenIds.length,
        expiresAt: emergency.expiresAt,
      },
    });
    this.emergencies.push(emergency);
    this.auditRecords.push(auditRecord);
    return { activated: true, emergency } as const;
  }
  async clearEmergencyAndAudit(
    org: string,
    overrideId: string,
    audit: UserMutationAuditContext,
  ) {
    const actor = this.activeActor(org, audit.actorUserId, ["OWNER", "ADMIN"]);
    if (!hasCapability(actor?.role, CAPABILITIES.emergencyClear))
      return { cleared: false, reason: "FORBIDDEN" } as const;
    const emergency = this.emergencies.find(
      (candidate) =>
        candidate.organizationId === org && candidate.id === overrideId,
    );
    if (!emergency) return { cleared: false, reason: "NOT_FOUND" } as const;
    const auditRecord = this.buildAuditRecord({
      organizationId: org,
      actorUserId: audit.actorUserId,
      actorType: "user",
      action: "emergency.cleared",
      entityType: "emergency",
      entityId: overrideId,
      ...(audit.ipAddress ? { ipAddress: audit.ipAddress } : {}),
      ...(audit.requestId ? { requestId: audit.requestId } : {}),
      metadata: {},
    });
    emergency.clearedAt = now();
    this.auditRecords.push(auditRecord);
    return { cleared: true, emergency } as const;
  }
  async listAudits(org: string, limit: number) {
    return this.auditRecords
      .filter((x) => x.organizationId === org)
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
      )
      .slice(0, limit);
  }
  async audit(event: Omit<AuditRecord, "id" | "createdAt">) {
    this.auditRecords.push(this.buildAuditRecord(event));
  }
}
