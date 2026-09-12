import {
  createHash,
  createPublicKey,
  randomBytes,
  verify,
  type KeyObject,
} from "node:crypto";
import type {
  DeviceCredentialEnrollment,
  DeviceSecurityLevel,
} from "../domain/types.js";

const SIGNING_DOMAIN = Buffer.from("ScreenGoblin device proof v1\0", "utf8");
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export class DeviceProofFormatError extends Error {}

export function decodeCanonicalBase64Url(
  value: string,
  minimumBytes: number,
  maximumBytes: number,
): Buffer {
  if (!BASE64URL.test(value) || value.includes("="))
    throw new DeviceProofFormatError("Value must be unpadded base64url");
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length < minimumBytes ||
    decoded.length > maximumBytes ||
    decoded.toString("base64url") !== value
  )
    throw new DeviceProofFormatError("Value has invalid base64url encoding");
  return decoded;
}

export const sha256Hex = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

export const sha256Base64Url = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("base64url");

export function validateP256Identity(input: {
  algorithm: "ES256";
  publicKeySpki: string;
  keyId: string;
  securityLevel: DeviceSecurityLevel;
}): { enrollment: DeviceCredentialEnrollment; publicKey: KeyObject } {
  const spki = decodeCanonicalBase64Url(input.publicKeySpki, 80, 256);
  const expectedKeyId = sha256Base64Url(spki);
  if (input.keyId !== expectedKeyId)
    throw new DeviceProofFormatError("Device key identifier is invalid");
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
  } catch {
    throw new DeviceProofFormatError("Device public key is invalid");
  }
  if (
    publicKey.asymmetricKeyType !== "ec" ||
    publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  )
    throw new DeviceProofFormatError("Device public key must use P-256");
  const canonicalSpki = publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.from(canonicalSpki).equals(spki))
    throw new DeviceProofFormatError("Device public key encoding is invalid");
  return {
    enrollment: {
      algorithm: "ES256",
      publicKeySpki: input.publicKeySpki,
      keyId: expectedKeyId,
      securityLevel: input.securityLevel,
    },
    publicKey,
  };
}

function isStrictEcdsaDer(signature: Buffer): boolean {
  if (signature.length < 8 || signature.length > 72 || signature[0] !== 0x30)
    return false;
  const sequenceLength = signature[1];
  if (sequenceLength === undefined || sequenceLength !== signature.length - 2)
    return false;
  let offset = 2;
  for (let index = 0; index < 2; index += 1) {
    if (signature[offset] !== 0x02) return false;
    const length = signature[offset + 1];
    if (!length || length > 33 || offset + 2 + length > signature.length)
      return false;
    const first = signature[offset + 2];
    if (
      first === undefined ||
      (first & 0x80) !== 0 ||
      (length > 1 && first === 0 && (signature[offset + 3]! & 0x80) === 0)
    )
      return false;
    offset += 2 + length;
  }
  return offset === signature.length;
}

export function verifyDeviceSignature(
  credential: DeviceCredentialEnrollment,
  encodedChallenge: string,
  encodedSignature: string,
): boolean {
  try {
    const challenge = decodeCanonicalBase64Url(encodedChallenge, 16, 512);
    const signature = decodeCanonicalBase64Url(encodedSignature, 8, 80);
    if (!isStrictEcdsaDer(signature)) return false;
    const { publicKey } = validateP256Identity(credential);
    return verify(
      "sha256",
      Buffer.concat([SIGNING_DOMAIN, challenge]),
      publicKey,
      signature,
    );
  } catch {
    return false;
  }
}

export const randomChallenge = (): string =>
  randomBytes(32).toString("base64url");
