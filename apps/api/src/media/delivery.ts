import {
  createHash,
  createHmac,
  timingSafeEqual,
  webcrypto,
} from "node:crypto";
import { Readable } from "node:stream";

const CAPABILITY_VERSION = 1;
const CAPABILITY_PREFIX = "ScreenGoblin media delivery capability v1\n";
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,256}$/;

export interface MediaDeliveryClaims {
  version: 1;
  method: "GET";
  screenId: string;
  organizationId: string;
  credentialKeyId?: string;
  assignmentId: string;
  assignmentDigestSha256: string;
  assetId: string;
  storageKey: string;
  mimeType: string;
  checksumSha256: string;
  sizeBytes: number;
  expiresAt: string;
}

export interface MediaObject {
  body: Readable;
  contentLength: number;
}

export interface MediaObjectStore {
  getObject(storageKey: string): Promise<MediaObject | null>;
}

const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const signature = (payload: string, secret: string) =>
  createHmac("sha256", secret)
    .update(CAPABILITY_PREFIX)
    .update(payload)
    .digest("base64url");

export const mediaStorageKey = (
  organizationId: string,
  assetId: string,
  checksumSha256: string,
): string => {
  if (
    !SAFE_SEGMENT.test(organizationId) ||
    !SAFE_SEGMENT.test(assetId) ||
    !SHA256.test(checksumSha256)
  )
    throw new Error("Invalid media storage identity");
  return `organizations/${organizationId}/assets/${assetId}/${checksumSha256}`;
};

export const issueMediaCapability = (
  claims: Omit<MediaDeliveryClaims, "version" | "method">,
  secret: string,
): string => {
  const payload = encode({
    version: CAPABILITY_VERSION,
    method: "GET",
    ...claims,
  });
  return `${payload}.${signature(payload, secret)}`;
};

export const verifyMediaCapability = (
  value: string,
  secret: string,
  now = new Date(),
): MediaDeliveryClaims | null => {
  const [payload, supplied, extra] = value.split(".");
  if (!payload || !supplied || extra) return null;
  const expected = signature(payload, secret);
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Partial<MediaDeliveryClaims>;
    if (
      claims.version !== CAPABILITY_VERSION ||
      claims.method !== "GET" ||
      typeof claims.screenId !== "string" ||
      typeof claims.organizationId !== "string" ||
      (claims.credentialKeyId !== undefined &&
        typeof claims.credentialKeyId !== "string") ||
      typeof claims.assignmentId !== "string" ||
      typeof claims.assignmentDigestSha256 !== "string" ||
      !SHA256.test(claims.assignmentDigestSha256) ||
      typeof claims.assetId !== "string" ||
      typeof claims.storageKey !== "string" ||
      typeof claims.mimeType !== "string" ||
      typeof claims.checksumSha256 !== "string" ||
      !SHA256.test(claims.checksumSha256) ||
      !Number.isSafeInteger(claims.sizeBytes) ||
      (claims.sizeBytes ?? 0) < 1 ||
      typeof claims.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(claims.expiresAt)) ||
      Date.parse(claims.expiresAt) <= now.getTime() ||
      claims.storageKey !==
        mediaStorageKey(
          claims.organizationId,
          claims.assetId,
          claims.checksumSha256,
        )
    )
      return null;
    return claims as MediaDeliveryClaims;
  } catch {
    return null;
  }
};

const hmac = async (key: Buffer | string, value: string) => {
  const imported = await webcrypto.subtle.importKey(
    "raw",
    typeof key === "string" ? Buffer.from(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Buffer.from(
    await webcrypto.subtle.sign("HMAC", imported, Buffer.from(value)),
  );
};

const encodePath = (value: string) =>
  value.split("/").map(encodeURIComponent).join("/");

export class S3MediaObjectStore implements MediaObjectStore {
  private readonly endpoint: URL;

  constructor(
    endpoint: string,
    private readonly region: string,
    private readonly bucket: string,
    private readonly accessKeyId: string,
    private readonly signingKeyMaterial: string,
  ) {
    this.endpoint = new URL(endpoint);
    if (!["http:", "https:"].includes(this.endpoint.protocol))
      throw new Error("S3 endpoint must use HTTP or HTTPS");
    if (
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.search ||
      this.endpoint.hash
    )
      throw new Error("S3 endpoint must not contain credentials or query data");
  }

  async getObject(storageKey: string): Promise<MediaObject | null> {
    const url = new URL(this.endpoint);
    url.pathname = [
      url.pathname.replace(/\/$/, ""),
      encodeURIComponent(this.bucket),
      encodePath(storageKey),
    ].join("/");
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);
    const payloadHash = createHash("sha256").update("").digest("hex");
    const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = [
      "GET",
      url.pathname,
      "",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const scope = `${date}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");
    const dateKey = await hmac(`AWS4${this.signingKeyMaterial}`, date);
    const regionKey = await hmac(dateKey, this.region);
    const serviceKey = await hmac(regionKey, "s3");
    const signingKey = await hmac(serviceKey, "aws4_request");
    const requestSignature = await hmac(signingKey, stringToSign);
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${requestSignature.toString("hex")}`;
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      headers: {
        Authorization: authorization,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) return null;
    if (!response.ok || !response.body)
      throw new Error("Private media object retrieval failed");
    const length = Number(response.headers.get("content-length"));
    if (!Number.isSafeInteger(length) || length < 0)
      throw new Error("Private media object length is invalid");
    return {
      body: Readable.fromWeb(response.body as never),
      contentLength: length,
    };
  }
}
