import { describe, expect, it } from "vitest";
import {
  decideExistingBootstrapContainment,
  validateSeedPassword,
} from "../prisma/seed-password.js";

describe("bootstrap seed password validation", () => {
  it("accepts passwords within bcrypt's UTF-8 byte boundary", () => {
    expect(() => validateSeedPassword("a".repeat(72))).not.toThrow();
    expect(() => validateSeedPassword("🟢".repeat(16))).not.toThrow();
  });

  it("rejects short passwords", () => {
    expect(() => validateSeedPassword("a".repeat(15))).toThrow(
      "at least 16 characters",
    );
    expect(() => validateSeedPassword("🟢".repeat(15))).toThrow(
      "at least 16 characters",
    );
  });

  it("rejects ASCII and multibyte passwords over 72 UTF-8 bytes", () => {
    expect(() => validateSeedPassword("a".repeat(73))).toThrow(
      "at most 72 UTF-8 bytes",
    );
    expect(() => validateSeedPassword("🟢".repeat(19))).toThrow(
      "at most 72 UTF-8 bytes",
    );
  });
});

describe("existing bootstrap owner containment", () => {
  const databaseNow = new Date("2026-09-16T12:00:00.000Z");

  it("fails closed when an unproven legacy credential does not match", () => {
    expect(() =>
      decideExistingBootstrapContainment({
        bootstrapPasswordExpiresAt: null,
        databaseNow,
        hasContainmentAudit: false,
        seedPasswordMatches: false,
      }),
    ).toThrow(
      "Existing bootstrap owner is not containment-proven and the supplied seed password does not match; refusing to continue",
    );
    expect(() =>
      decideExistingBootstrapContainment({
        bootstrapPasswordExpiresAt: new Date("2026-09-16T11:59:59.999Z"),
        databaseNow,
        hasContainmentAudit: false,
        seedPasswordMatches: false,
      }),
    ).toThrow("not containment-proven");
  });

  it("marks a matching unproven legacy credential", () => {
    expect(
      decideExistingBootstrapContainment({
        bootstrapPasswordExpiresAt: null,
        databaseNow,
        hasContainmentAudit: false,
        seedPasswordMatches: true,
      }),
    ).toBe("MARK");
  });

  it("keeps active-marker and audit-proven reruns idempotent", () => {
    expect(
      decideExistingBootstrapContainment({
        bootstrapPasswordExpiresAt: new Date("2026-09-16T12:00:00.001Z"),
        databaseNow,
        hasContainmentAudit: false,
        seedPasswordMatches: false,
      }),
    ).toBe("UNCHANGED");
    expect(
      decideExistingBootstrapContainment({
        bootstrapPasswordExpiresAt: null,
        databaseNow,
        hasContainmentAudit: true,
        seedPasswordMatches: false,
      }),
    ).toBe("UNCHANGED");
  });
});
