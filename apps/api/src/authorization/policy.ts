import { CAPABILITIES, type Capability } from "@screengoblin/contracts";
import type { Role } from "../domain/types.js";
import { COMPATIBILITY_GRANT_CAPABILITIES } from "./compatibility.js";

const ROLE_CAPABILITIES = {
  OWNER: [
    CAPABILITIES.authorizationManage,
    ...COMPATIBILITY_GRANT_CAPABILITIES.OWNER,
  ],
  ADMIN: COMPATIBILITY_GRANT_CAPABILITIES.ADMIN,
  PUBLISHER: COMPATIBILITY_GRANT_CAPABILITIES.PUBLISHER,
  VIEWER: COMPATIBILITY_GRANT_CAPABILITIES.VIEWER,
} as const satisfies Record<Role, readonly Capability[]>;

const knownCapabilities = new Set<unknown>(Object.values(CAPABILITIES));

export function hasCapability(role: unknown, capability: unknown): boolean {
  if (
    typeof role !== "string" ||
    typeof capability !== "string" ||
    !knownCapabilities.has(capability) ||
    !Object.hasOwn(ROLE_CAPABILITIES, role)
  )
    return false;
  return (ROLE_CAPABILITIES[role as Role] as readonly string[]).includes(
    capability,
  );
}
