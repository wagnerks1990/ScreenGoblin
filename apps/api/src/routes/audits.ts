import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireRole } from "../utils/http.js";
export const auditRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", app.authenticate);
  app.get("/audit-events", async (request) => {
    requireRole(request, ["OWNER", "ADMIN"]);
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(request.query);
    return {
      data: await app.store.listAudits(request.user.organizationId, limit),
    };
  });
};
