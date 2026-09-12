import { createHash, createHmac } from "node:crypto";

const canonical = (value: unknown) => JSON.stringify(value);

export const enrollmentIdempotencyKeyHash = (
  organizationId: string,
  key: string,
) =>
  createHash("sha256")
    .update(
      canonical({
        schemaVersion: 1,
        operation: "device.enrollment.create",
        organizationId,
        key,
      }),
    )
    .digest("hex");

export const enrollmentRequestDigest = (screenId: string, reason: string) =>
  createHash("sha256")
    .update(
      canonical({
        schemaVersion: 1,
        operation: "device.enrollment.create",
        screenId,
        reason,
      }),
    )
    .digest("hex");

export const enrollmentActivationKeyHash = (
  organizationId: string,
  key: string,
) =>
  createHash("sha256")
    .update(
      canonical({
        schemaVersion: 1,
        operation: "device.enrollment.activate",
        organizationId,
        key,
      }),
    )
    .digest("hex");

export const enrollmentActivationDigest = (
  screenId: string,
  grantId: string,
  candidateId: string,
  fingerprint: string,
) =>
  createHash("sha256")
    .update(
      canonical({
        schemaVersion: 1,
        operation: "device.enrollment.activate",
        screenId,
        grantId,
        candidateId,
        fingerprint,
      }),
    )
    .digest("hex");

/** Deterministic only so an exact idempotent replay can reconstruct the code.
 * The database retains the key hash and counter, never this low-entropy secret.
 */
export const enrollmentCode = (
  pepper: string,
  organizationId: string,
  keyHash: string,
  counter: number,
) => {
  for (let block = 0; block < 16; block += 1) {
    const digest = createHmac("sha256", pepper)
      .update(
        `ScreenGoblin enrollment code v1\0${organizationId}\0${keyHash}\0${counter}\0${block}`,
      )
      .digest();
    for (let offset = 0; offset <= digest.length - 4; offset += 4) {
      const value = digest.readUInt32BE(offset);
      const ceiling = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
      if (value < ceiling)
        return (value % 1_000_000).toString().padStart(6, "0");
    }
  }
  throw new Error("Pairing code derivation failed");
};
