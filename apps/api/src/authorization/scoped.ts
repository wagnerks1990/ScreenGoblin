import { createHash } from "node:crypto";
import {
  AUTHORIZATION_SCOPE_TYPES,
  CAPABILITIES,
  type Capability,
  type ScopedAuthorizationGrant,
  type ScopedAuthorizationScreenTarget,
} from "@screengoblin/contracts";
import { hasCapability } from "./policy.js";

const EVIDENCE_DOMAIN = "ScreenGoblin scoped authorization evidence v1\n";

const TARGET_SCOPED_CAPABILITIES = new Set<Capability>([
  CAPABILITIES.screenRead,
  CAPABILITIES.scheduleRead,
  CAPABILITIES.releaseCandidateRead,
  CAPABILITIES.releaseCandidateCreate,
  CAPABILITIES.releaseCandidateSubmit,
  CAPABILITIES.releaseApprove,
  CAPABILITIES.releasePublish,
  CAPABILITIES.releaseWithdraw,
  CAPABILITIES.screenCredentialRevoke,
  CAPABILITIES.screenCredentialReenroll,
]);

const ORGANIZATION_SCOPED_CAPABILITIES = new Set<Capability>([
  CAPABILITIES.locationRead,
  CAPABILITIES.mediaRead,
  CAPABILITIES.playlistRead,
]);

const knownCapabilities = new Set<unknown>(Object.values(CAPABILITIES));
const knownScopeTypes = new Set<unknown>(
  Object.values(AUTHORIZATION_SCOPE_TYPES),
);
const canonicalUtcInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type ScopedAuthorizationReason =
  | "ALLOWED"
  | "INVALID_CONTEXT"
  | "UNKNOWN_CAPABILITY"
  | "ROLE_CEILING_DENIED"
  | "TARGETS_REQUIRED"
  | "ORGANIZATION_SCOPE_REQUIRED"
  | "SCOPE_DENIED";

export interface ScopedAuthorizationEvaluationInput {
  organizationId: string;
  actorUserId: string;
  membershipId: string;
  role: unknown;
  authorizationEpoch: number;
  capability: unknown;
  evaluatedAt: string;
  grants: readonly ScopedAuthorizationGrant[];
  targets: readonly ScopedAuthorizationScreenTarget[];
}

export interface ScopedAuthorizationDecision {
  allowed: boolean;
  reason: ScopedAuthorizationReason;
  matchingGrantIds: string[];
  evidenceDigestSha256: string;
}

interface NormalizedGrant {
  id: string;
  subjectMembershipId: string;
  scopeType: ScopedAuthorizationGrant["scopeType"];
  scopeId: string | null;
  startsAt: string;
  expiresAt: string | null;
}

interface NormalizedTarget {
  screenId: string;
  locationId: string | null;
  screenGroupIds: string[];
}

const normalizedInstant = (value: unknown) => {
  if (typeof value !== "string" || !canonicalUtcInstant.test(value))
    return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const canonical = new Date(milliseconds).toISOString();
  return canonical === value ? { milliseconds, canonical } : null;
};

const evidenceDigest = (value: object) =>
  createHash("sha256")
    .update(EVIDENCE_DOMAIN)
    .update(JSON.stringify(value))
    .digest("hex");

const decision = (
  input: ScopedAuthorizationEvaluationInput,
  targets: readonly NormalizedTarget[],
  reason: ScopedAuthorizationReason,
  grants: readonly NormalizedGrant[] = [],
): ScopedAuthorizationDecision => {
  const matchingGrantIds = [...new Set(grants.map(({ id }) => id))].sort();
  return {
    allowed: reason === "ALLOWED",
    reason,
    matchingGrantIds,
    // evaluatedAt decides whether a grant is active but is deliberately absent
    // here. The digest represents stable scope evidence that can be compared at
    // approval and publication while the same authority remains active.
    evidenceDigestSha256: evidenceDigest({
      policyVersion: 1,
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      membershipId: input.membershipId,
      role: typeof input.role === "string" ? input.role : null,
      authorizationEpoch: input.authorizationEpoch,
      capability:
        typeof input.capability === "string" ? input.capability : null,
      targets,
      grants: [...grants].sort((a, b) => a.id.localeCompare(b.id)),
      result: reason,
    }),
  };
};

const normalizeTargets = (
  organizationId: string,
  targets: readonly ScopedAuthorizationScreenTarget[],
) => {
  const seen = new Set<string>();
  const normalized: NormalizedTarget[] = [];
  for (const target of targets) {
    if (
      !target ||
      target.organizationId !== organizationId ||
      typeof target.screenId !== "string" ||
      target.screenId.length === 0 ||
      seen.has(target.screenId) ||
      (target.locationId != null &&
        (typeof target.locationId !== "string" ||
          target.locationId.length === 0)) ||
      !Array.isArray(target.screenGroupIds) ||
      target.screenGroupIds.some(
        (id) => typeof id !== "string" || id.length === 0,
      )
    )
      return null;
    seen.add(target.screenId);
    normalized.push({
      screenId: target.screenId,
      locationId: target.locationId ?? null,
      screenGroupIds: [...new Set(target.screenGroupIds)].sort(),
    });
  }
  return normalized.sort((a, b) => a.screenId.localeCompare(b.screenId));
};

const activeGrant = (
  grant: ScopedAuthorizationGrant,
  input: ScopedAuthorizationEvaluationInput,
  now: number,
): NormalizedGrant | null => {
  if (
    !grant ||
    typeof grant.id !== "string" ||
    grant.id.length === 0 ||
    typeof grant.subjectMembershipId !== "string" ||
    grant.subjectMembershipId.length === 0 ||
    grant.organizationId !== input.organizationId ||
    grant.subjectUserId !== input.actorUserId ||
    grant.subjectMembershipId !== input.membershipId ||
    grant.capability !== input.capability ||
    !knownScopeTypes.has(grant.scopeType) ||
    grant.revokedAt != null
  )
    return null;
  const startsAt = normalizedInstant(grant.startsAt);
  const expiresAt =
    grant.expiresAt == null ? undefined : normalizedInstant(grant.expiresAt);
  if (
    !startsAt ||
    (grant.expiresAt != null && !expiresAt) ||
    startsAt.milliseconds > now ||
    (expiresAt && expiresAt.milliseconds <= now)
  )
    return null;
  const organizationScope =
    grant.scopeType === AUTHORIZATION_SCOPE_TYPES.organization;
  if (
    (organizationScope && grant.scopeId != null) ||
    (!organizationScope &&
      (typeof grant.scopeId !== "string" || grant.scopeId.length === 0))
  )
    return null;
  return {
    id: grant.id,
    subjectMembershipId: grant.subjectMembershipId,
    scopeType: grant.scopeType,
    scopeId: grant.scopeId ?? null,
    startsAt: startsAt.canonical,
    expiresAt: expiresAt?.canonical ?? null,
  };
};

const coversTarget = (grant: NormalizedGrant, target: NormalizedTarget) => {
  switch (grant.scopeType) {
    case "ORGANIZATION":
      return true;
    case "LOCATION":
      return target.locationId !== null && target.locationId === grant.scopeId;
    case "SCREEN_GROUP":
      return target.screenGroupIds.includes(grant.scopeId ?? "");
    case "SCREEN":
      return target.screenId === grant.scopeId;
  }
};

/**
 * Pure policy core for the staged scoped-authorization foundation.
 * Callers must still resolve tenant-owned targets and grants from trusted,
 * current server state inside the authoritative transaction.
 */
export function evaluateScopedAuthorization(
  input: ScopedAuthorizationEvaluationInput,
): ScopedAuthorizationDecision {
  const at = normalizedInstant(input.evaluatedAt);
  const targets = Array.isArray(input.targets)
    ? normalizeTargets(input.organizationId, input.targets)
    : null;
  if (
    typeof input.organizationId !== "string" ||
    input.organizationId.length === 0 ||
    typeof input.actorUserId !== "string" ||
    input.actorUserId.length === 0 ||
    typeof input.membershipId !== "string" ||
    input.membershipId.length === 0 ||
    !Number.isSafeInteger(input.authorizationEpoch) ||
    input.authorizationEpoch < 0 ||
    !at ||
    !targets ||
    !Array.isArray(input.grants)
  )
    return decision(input, targets ?? [], "INVALID_CONTEXT");
  if (!knownCapabilities.has(input.capability))
    return decision(input, targets, "UNKNOWN_CAPABILITY");
  if (!hasCapability(input.role, input.capability))
    return decision(input, targets, "ROLE_CEILING_DENIED");

  const active = input.grants
    .map((grant) => activeGrant(grant, input, at.milliseconds))
    .filter((grant): grant is NormalizedGrant => grant !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(active.map(({ id }) => id)).size !== active.length)
    return decision(input, targets, "INVALID_CONTEXT");

  const capability = input.capability as Capability;
  if (capability === CAPABILITIES.authorizationManage) {
    // Scoped grant administration is deliberately unavailable until a later
    // reviewed policy adds strong-auth administration. Legacy OWNER bootstrap
    // authority remains isolated in hasCapability and cannot activate here.
    return decision(input, targets, "SCOPE_DENIED");
  }
  if (ORGANIZATION_SCOPED_CAPABILITIES.has(capability)) {
    if (targets.length !== 0)
      return decision(input, targets, "ORGANIZATION_SCOPE_REQUIRED");
    const grant = active.find(
      ({ scopeType }) => scopeType === AUTHORIZATION_SCOPE_TYPES.organization,
    );
    return grant
      ? decision(input, targets, "ALLOWED", [grant])
      : decision(input, targets, "SCOPE_DENIED");
  }
  if (!TARGET_SCOPED_CAPABILITIES.has(capability))
    return decision(input, targets, "ROLE_CEILING_DENIED");
  if (targets.length === 0) return decision(input, targets, "TARGETS_REQUIRED");

  const selected: NormalizedGrant[] = [];
  for (const target of targets) {
    const grant = active.find((candidate) => coversTarget(candidate, target));
    if (!grant) return decision(input, targets, "SCOPE_DENIED");
    selected.push(grant);
  }
  return decision(input, targets, "ALLOWED", selected);
}
