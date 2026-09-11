import { z } from "zod";

// Database identifiers are opaque strings (Prisma CUIDs today). Accepting only
// UUIDs breaks real PostgreSQL records even though in-memory UUID tests pass.
export const opaqueId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid identifier");
