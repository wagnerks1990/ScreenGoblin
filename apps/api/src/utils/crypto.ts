import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  timingSafeEqual,
} from "node:crypto";

const ED25519_PKCS8_SEED_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);
const ED25519_SPKI_PREFIX_LENGTH = 12;

const privateKeyFromSeed = (encodedSeed: string) => {
  const seed = Buffer.from(encodedSeed, "base64url");
  if (seed.length !== 32)
    throw new Error(
      "Manifest signing private key must be a 32-byte base64url seed",
    );
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
};
export const randomToken = () => randomBytes(32).toString("base64url");
export const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const pairingCodeHash = (code: string, pepper: string) =>
  createHmac("sha256", pepper).update(code).digest("hex");
export const secureHashEquals = (value: string, hash: string) => {
  const a = Buffer.from(sha256(value));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
};
export const signManifest = (payload: unknown, encodedSeed: string) =>
  sign(
    null,
    Buffer.from(JSON.stringify(payload)),
    privateKeyFromSeed(encodedSeed),
  ).toString("base64url");

export const manifestVerificationKey = (encodedSeed: string) => {
  const spki = createPublicKey(privateKeyFromSeed(encodedSeed)).export({
    format: "der",
    type: "spki",
  });
  return spki.subarray(ED25519_SPKI_PREFIX_LENGTH).toString("base64url");
};
