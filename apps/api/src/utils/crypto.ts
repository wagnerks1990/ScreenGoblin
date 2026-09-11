import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
export const randomToken = () => randomBytes(32).toString("base64url");
export const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const secureHashEquals = (value: string, hash: string) => {
  const a = Buffer.from(sha256(value));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
};
export const signManifest = (payload: unknown, secret: string) =>
  createHmac("sha256", secret)
    .update(JSON.stringify(payload))
    .digest("base64url");
