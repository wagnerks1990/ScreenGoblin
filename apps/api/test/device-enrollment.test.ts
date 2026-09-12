import { describe, expect, it } from "vitest";
import {
  enrollmentActivationDigest,
  enrollmentActivationKeyHash,
  enrollmentCode,
  enrollmentIdempotencyKeyHash,
  enrollmentRequestDigest,
} from "../src/device-enrollment/canonical.js";

describe("targeted enrollment canonical values", () => {
  const pepper = "test-only-enrollment-pepper-that-is-long-enough";

  it("reconstructs only the exact tenant/key/counter code", () => {
    const keyHash = enrollmentIdempotencyKeyHash(
      "org-a",
      "11111111-1111-4111-8111-111111111111",
    );
    const code = enrollmentCode(pepper, "org-a", keyHash, 0);
    expect(code).toBe("254988");
    expect(enrollmentCode(pepper, "org-a", keyHash, 0)).toBe(code);
    expect(enrollmentCode(pepper, "org-a", keyHash, 1)).toBe("430058");
    expect(enrollmentCode(pepper, "org-b", keyHash, 0)).toBe("370571");
  });

  it("domain-separates creation and activation replay values", () => {
    const raw = "11111111-1111-4111-8111-111111111111";
    expect(enrollmentIdempotencyKeyHash("org-a", raw)).not.toBe(
      enrollmentActivationKeyHash("org-a", raw),
    );
    expect(enrollmentRequestDigest("screen-a", "Install player")).not.toBe(
      enrollmentRequestDigest("screen-b", "Install player"),
    );
    expect(
      enrollmentActivationDigest(
        "screen-a",
        "grant-a",
        "candidate-a",
        "fingerprint-a",
      ),
    ).not.toBe(
      enrollmentActivationDigest(
        "screen-a",
        "grant-a",
        "candidate-b",
        "fingerprint-a",
      ),
    );
  });
});
