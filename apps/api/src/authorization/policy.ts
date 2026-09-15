import { CAPABILITIES, type Capability } from "@screengoblin/contracts";
import type { Role } from "../domain/types.js";

const ROLE_CAPABILITIES = {
  OWNER: [
    CAPABILITIES.authorizationManage,
    CAPABILITIES.screenRead,
    CAPABILITIES.locationRead,
    CAPABILITIES.mediaRead,
    CAPABILITIES.playlistRead,
    CAPABILITIES.scheduleRead,
    CAPABILITIES.releaseCandidateRead,
    CAPABILITIES.releaseCandidateCreate,
    CAPABILITIES.releaseCandidateSubmit,
    CAPABILITIES.releaseApprove,
    CAPABILITIES.releasePublish,
    CAPABILITIES.releaseWithdraw,
    CAPABILITIES.screenCredentialRevoke,
    CAPABILITIES.screenCredentialReenroll,
  ],
  ADMIN: [
    CAPABILITIES.screenRead,
    CAPABILITIES.locationRead,
    CAPABILITIES.mediaRead,
    CAPABILITIES.playlistRead,
    CAPABILITIES.scheduleRead,
    CAPABILITIES.releaseCandidateRead,
    CAPABILITIES.releaseCandidateCreate,
    CAPABILITIES.releaseCandidateSubmit,
    CAPABILITIES.releaseApprove,
    CAPABILITIES.releasePublish,
    CAPABILITIES.releaseWithdraw,
    CAPABILITIES.screenCredentialRevoke,
    CAPABILITIES.screenCredentialReenroll,
  ],
  PUBLISHER: [
    CAPABILITIES.screenRead,
    CAPABILITIES.locationRead,
    CAPABILITIES.mediaRead,
    CAPABILITIES.playlistRead,
    CAPABILITIES.scheduleRead,
    CAPABILITIES.releaseCandidateRead,
    CAPABILITIES.releaseCandidateCreate,
    CAPABILITIES.releaseCandidateSubmit,
    CAPABILITIES.releasePublish,
    CAPABILITIES.releaseWithdraw,
  ],
  VIEWER: [
    CAPABILITIES.screenRead,
    CAPABILITIES.locationRead,
    CAPABILITIES.mediaRead,
    CAPABILITIES.playlistRead,
    CAPABILITIES.scheduleRead,
    CAPABILITIES.releaseCandidateRead,
  ],
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
