import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { z } from "zod";
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const mailPayloadSchema = z
  .object({
    from: z.email().max(254),
    to: z.array(z.email().max(254)).length(1),
    reply_to: z.email().max(254),
    subject: z.string().min(1).max(160),
    text: z.string().min(1).max(5000),
  })
  .strict();
export type MailPayload = z.infer<typeof mailPayloadSchema>;
export function encryptPayload(
  payload: MailPayload,
  key: string,
  jobId: string,
) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64url"), iv);
  cipher.setAAD(Buffer.from("screengoblin-mail-v1:" + jobId));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(mailPayloadSchema.parse(payload)), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    "base64url",
  );
}
export function decryptPayload(
  value: string,
  key: string,
  jobId: string,
): MailPayload {
  if (value.length > 16000 || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error("Invalid encrypted mail payload");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length < 29) throw new Error("Invalid encrypted mail payload");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "base64url"),
    bytes.subarray(0, 12),
  );
  decipher.setAAD(Buffer.from("screengoblin-mail-v1:" + jobId));
  decipher.setAuthTag(bytes.subarray(12, 28));
  const plaintext = Buffer.concat([
    decipher.update(bytes.subarray(28)),
    decipher.final(),
  ]);
  return mailPayloadSchema.parse(JSON.parse(plaintext.toString("utf8")));
}
