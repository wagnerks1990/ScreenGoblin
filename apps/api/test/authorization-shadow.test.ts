import { describe, expect, it } from "vitest";
import {
  evaluatedAuthorizationShadow,
  unavailableAuthorizationShadow,
} from "../src/authorization/shadow.js";

describe("authorization shadow audit projection", () => {
  it("projects only bounded comparison evidence and never matching grant ids", () => {
    const metadata = evaluatedAuthorizationShadow(
      {
        allowed: false,
        reason: "SCOPE_DENIED",
        matchingGrantIds: ["sensitive-grant-id"],
        evidenceDigestSha256: "a".repeat(64),
      },
      3,
    );

    expect(metadata).toEqual({
      schemaVersion: 1,
      policyVersion: 1,
      status: "EVALUATED",
      baseline: "LEGACY_ROLE",
      legacyAllowed: true,
      scopedAllowed: false,
      mismatchKind: "LEGACY_ALLOW_SCOPED_DENY",
      reason: "SCOPE_DENIED",
      evidenceDigestSha256: "a".repeat(64),
      targetCount: 3,
    });
    expect(JSON.stringify(metadata)).not.toContain("sensitive-grant-id");
  });

  it("uses a closed unavailable marker without exception details", () => {
    expect(unavailableAuthorizationShadow("LOAD_FAILED", 2)).toEqual({
      schemaVersion: 1,
      policyVersion: 1,
      status: "UNAVAILABLE",
      baseline: "LEGACY_ROLE",
      legacyAllowed: true,
      failureClass: "LOAD_FAILED",
      targetCount: 2,
    });
  });
});
