import "@fastify/jwt";
import type { DataStore, Role, ScreenRecord } from "./domain/types.js";
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; organizationId: string; role: Role; email: string };
    user: { sub: string; organizationId: string; role: Role; email: string };
  }
}
declare module "fastify" {
  interface FastifyInstance {
    store: DataStore;
    config: {
      manifestSigningSecret: string;
      emergencyPublishingEnabled: boolean;
    };
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
    authenticateDevice: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
  }
  interface FastifyRequest {
    device?: ScreenRecord;
  }
}
