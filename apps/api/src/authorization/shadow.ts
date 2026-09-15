import type { ScopedAuthorizationDecision } from "./scoped.js";

export const RELEASE_SHADOW_MAX_GRANTS = 100;
export const RELEASE_SHADOW_MAX_GROUP_EDGES = 10_000;

export type AuthorizationShadowMetadata =
  | {
      schemaVersion: 1;
      policyVersion: 1;
      status: "EVALUATED";
      baseline: "LEGACY_ROLE";
      legacyAllowed: true;
      scopedAllowed: boolean;
      mismatchKind: "NONE" | "LEGACY_ALLOW_SCOPED_DENY";
      reason: ScopedAuthorizationDecision["reason"];
      evidenceDigestSha256: string;
      targetCount: number;
    }
  | {
      schemaVersion: 1;
      policyVersion: 1;
      status: "UNAVAILABLE";
      baseline: "LEGACY_ROLE";
      legacyAllowed: true;
      failureClass: "CONTEXT_LIMIT" | "LOAD_FAILED" | "TARGET_UNRESOLVED";
      targetCount: number;
    };

export const evaluatedAuthorizationShadow = (
  decision: ScopedAuthorizationDecision,
  targetCount: number,
): AuthorizationShadowMetadata => ({
  schemaVersion: 1,
  policyVersion: 1,
  status: "EVALUATED",
  baseline: "LEGACY_ROLE",
  legacyAllowed: true,
  scopedAllowed: decision.allowed,
  mismatchKind: decision.allowed ? "NONE" : "LEGACY_ALLOW_SCOPED_DENY",
  reason: decision.reason,
  evidenceDigestSha256: decision.evidenceDigestSha256,
  targetCount,
});

export const unavailableAuthorizationShadow = (
  failureClass: Extract<
    AuthorizationShadowMetadata,
    { status: "UNAVAILABLE" }
  >["failureClass"],
  targetCount: number,
): AuthorizationShadowMetadata => ({
  schemaVersion: 1,
  policyVersion: 1,
  status: "UNAVAILABLE",
  baseline: "LEGACY_ROLE",
  legacyAllowed: true,
  failureClass,
  targetCount,
});
