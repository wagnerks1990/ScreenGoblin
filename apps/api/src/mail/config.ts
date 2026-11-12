import { z } from "zod";

export interface MailConfig {
  apiKey: string;
  webhookSecret: string;
  encryptionKey: string;
  from: string;
  replyTo: string;
  receivingDomain: string;
  publicOrigin: string;
  offlineMinutes: number;
}
export function loadMailConfig(
  env: NodeJS.ProcessEnv,
  publicOrigin: string,
): MailConfig | undefined {
  if (env.MAIL_ENABLED !== "true") return undefined;
  try {
    const domain = z
      .string()
      .regex(/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/)
      .parse(env.MAIL_RECEIVING_DOMAIN);
    const from = z.email().max(254).parse(env.MAIL_FROM);
    const replyTo = z.email().max(254).parse(env.MAIL_REPLY_TO);
    const apiKey = z
      .string()
      .regex(/^re_[A-Za-z0-9_-]{10,200}$/)
      .parse(env.RESEND_API_KEY);
    const webhookSecret = z
      .string()
      .startsWith("whsec_")
      .max(300)
      .parse(env.RESEND_WEBHOOK_SECRET);
    const encryptionKey = z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .parse(env.MAIL_ENCRYPTION_KEY);
    if (
      Buffer.from(encryptionKey, "base64url").length !== 32 ||
      Buffer.from(webhookSecret.slice(6), "base64").length < 32
    )
      throw new Error();
    if (
      env.NODE_ENV === "production" &&
      (/^re_(test|example|replace)/.test(apiKey) ||
        new Set(Buffer.from(encryptionKey, "base64url")).size < 2 ||
        new Set(Buffer.from(webhookSecret.slice(6), "base64")).size < 2)
    )
      throw new Error();
    const origin = new URL(publicOrigin);
    if (
      origin.protocol !== "https:" ||
      origin.origin !== publicOrigin ||
      from.split("@")[1] !== domain ||
      replyTo.split("@")[1] !== domain
    )
      throw new Error();
    const offlineMinutes = z.coerce
      .number()
      .int()
      .min(5)
      .max(1440)
      .parse(env.MAIL_OFFLINE_MINUTES ?? "10");
    return {
      apiKey,
      webhookSecret,
      encryptionKey,
      from,
      replyTo,
      receivingDomain: domain,
      publicOrigin,
      offlineMinutes,
    };
  } catch {
    throw new Error(
      "Mail configuration is invalid; check the private mail environment settings",
    );
  }
}
