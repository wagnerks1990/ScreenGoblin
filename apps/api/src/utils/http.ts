import type { FastifyReply, FastifyRequest } from "fastify";
import type { Role } from "../domain/types.js";
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const requireRole = (request: FastifyRequest, roles: Role[]) => {
  if (!roles.includes(request.user.role))
    throw new ApiError(
      403,
      "FORBIDDEN",
      "You do not have permission to perform this action",
    );
};
export const sendNotFound = (reply: FastifyReply) =>
  reply
    .code(404)
    .send({ error: { code: "NOT_FOUND", message: "Resource not found" } });
