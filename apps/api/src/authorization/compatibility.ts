import { createHash } from "node:crypto";
import { CAPABILITIES, type Capability } from "@screengoblin/contracts";
import type { Role } from "../domain/types.js";

export const COMPATIBILITY_GRANT_SYSTEM_KEY =
  "legacy-role-backfill-v1" as const;

export const COMPATIBILITY_GRANT_CAPABILITIES = {
  OWNER: [
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

export const compatibilityGrantCapabilities = (role: Role) =>
  COMPATIBILITY_GRANT_CAPABILITIES[role] as readonly Capability[];

export const compatibilityGrantId = (
  organizationId: string,
  membershipId: string,
  authorizationEpoch: number,
  capability: Capability,
) => {
  const framed =
    "ScreenGoblin compatibility grant v1\n" +
    `${Buffer.byteLength(organizationId, "utf8")}:${organizationId}` +
    `${Buffer.byteLength(membershipId, "utf8")}:${membershipId}` +
    `${authorizationEpoch}:` +
    `${Buffer.byteLength(capability, "utf8")}:${capability}`;
  return `compat-v1:${createHash("sha256").update(framed).digest("hex")}`;
};
