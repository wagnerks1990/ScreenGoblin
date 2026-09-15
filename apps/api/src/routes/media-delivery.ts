import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  enforceExactByteLength,
  verifyMediaCapability,
} from "../media/delivery.js";

const params = z.object({
  assetId: z.string().regex(/^[A-Za-z0-9._-]{1,256}$/),
});
const capabilityAuthorization =
  /^MediaCapability ([A-Za-z0-9_-]{1,4052}\.[A-Za-z0-9_-]{43})$/;

const readCapability = (request: {
  raw: { rawHeaders: string[] };
  url: string;
}) => {
  if (request.url.includes("?")) return null;
  const values: string[] = [];
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === "authorization")
      values.push(request.raw.rawHeaders[index + 1] ?? "");
  }
  if (values.length !== 1) return null;
  return capabilityAuthorization.exec(values[0]!)?.[1] ?? null;
};

export const mediaDeliveryRoutes: FastifyPluginAsync = async (app) => {
  app.get("/media", async (_request, reply) => reply.code(404).send());
  app.get("/media/:assetId", async (request, reply) => {
    const vary = String(reply.getHeader("Vary") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!vary.some((value) => value.toLowerCase() === "authorization"))
      vary.push("Authorization");
    reply
      .header("Cache-Control", "private, no-store, no-transform")
      .header("Referrer-Policy", "no-referrer")
      .header("Vary", vary.join(", "))
      .header("X-Content-Type-Options", "nosniff");
    if (request.method !== "GET") return reply.code(404).send();
    const capability = readCapability(request);
    if (!capability) return reply.code(404).send();
    const parsedParams = params.safeParse(request.params);
    if (!parsedParams.success) return reply.code(404).send();
    const { assetId } = parsedParams.data;
    const claims = verifyMediaCapability(
      capability,
      app.config.mediaDeliverySecret,
    );
    if (!claims || claims.assetId !== assetId) return reply.code(404).send();

    const authenticated = claims.credentialKeyId
      ? await app.store.authenticateDeviceCredential(
          claims.screenId,
          claims.credentialKeyId,
        )
      : await app.store.authenticateDevice(claims.screenId);
    const screen =
      authenticated && "authenticated" in authenticated
        ? authenticated.authenticated
          ? authenticated.screen
          : null
        : authenticated;
    if (!screen || screen.organizationId !== claims.organizationId)
      return reply.code(404).send();

    const authorized = await app.store.authorizeMediaDelivery({
      organizationId: claims.organizationId,
      screenId: claims.screenId,
      assignmentId: claims.assignmentId,
      assignmentDigestSha256: claims.assignmentDigestSha256,
      assetId: claims.assetId,
      storageKey: claims.storageKey,
      checksumSha256: claims.checksumSha256,
      sizeBytes: claims.sizeBytes,
      at: new Date().toISOString(),
    });
    if (!authorized) return reply.code(404).send();

    if (!app.mediaObjectStore) return reply.code(503).send();
    const object = await app.mediaObjectStore.getObject(claims.storageKey);
    if (!object) return reply.code(404).send();
    if (object.contentLength !== claims.sizeBytes) {
      object.body.destroy();
      return reply.code(404).send();
    }

    reply
      .header("Content-Type", claims.mimeType)
      .header("Content-Length", String(claims.sizeBytes))
      .header("Cache-Control", "private, no-store, no-transform");
    return reply.send(enforceExactByteLength(object.body, claims.sizeBytes));
  });
};
