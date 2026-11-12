import { Webhook } from "standardwebhooks";
import { z } from "zod";
import { ApiError } from "../utils/http.js";
export const mailEventSchema = z.object({
  type: z.string().max(80),
  data: z.object({
    email_id: z.uuid(),
    to: z.array(z.string().max(254)).max(50).optional(),
  }),
});
export type MailEvent = z.infer<typeof mailEventSchema>;
export function verifyMailWebhook(
  raw: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): { id: string; event: MailEvent } {
  const id = headers["svix-id"],
    timestamp = headers["svix-timestamp"],
    signature = headers["svix-signature"];
  if (
    typeof id !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
    typeof timestamp !== "string" ||
    !/^\d{1,11}$/.test(timestamp) ||
    String(Number(timestamp)) !== timestamp ||
    typeof signature !== "string" ||
    signature.length > 512 ||
    raw.length > 65536 ||
    !Buffer.from(raw.toString("utf8"), "utf8").equals(raw)
  )
    throw new ApiError(
      401,
      "MAIL_WEBHOOK_UNAUTHORIZED",
      "Webhook verification failed",
    );
  let event: unknown;
  try {
    event = new Webhook(secret).verify(raw, {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": signature,
    });
  } catch {
    throw new ApiError(
      401,
      "MAIL_WEBHOOK_UNAUTHORIZED",
      "Webhook verification failed",
    );
  }
  return { id, event: mailEventSchema.parse(event) };
}
