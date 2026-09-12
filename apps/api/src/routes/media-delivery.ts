import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { verifyMediaCapability } from "../media/delivery.js";

const params = z.object({ assetId: z.string().min(1).max(256) });
const query = z.object({ capability: z.string().min(40).max(4096) }).strict();

export const mediaDeliveryRoutes: FastifyPluginAsync = async (app) => {
  app.get("/media/:assetId", async (request, reply) => {
    const { assetId } = params.parse(request.params);
    const { capability } = query.parse(request.query);
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
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff");
    return reply.send(object.body);
  });
};
