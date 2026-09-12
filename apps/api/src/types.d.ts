import "@fastify/jwt";
import type { DataStore, Role, ScreenRecord } from "./domain/types.js";
import type { RateLimitBudget } from "./utils/rate-limit.js";
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      sub: string;
      organizationId: string;
      role: Role;
      email: string;
      sessionId: string;
    };
    user: {
      sub: string;
      organizationId: string;
      role: Role;
      email: string;
      sessionId: string;
    };
  }
}
declare module "fastify" {
  interface FastifyInstance {
    store: DataStore;
    rateLimitBudget: RateLimitBudget;
    config: {
      manifestSigningPrivateKey: string;
      pairingCodePepper: string;
      deviceAuthMode: "proof-v1" | "development-bearer";
      emergencyPublishingEnabled: boolean;
      mediaAllowedOrigins: string[];
      publicApiUrl?: string;
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
