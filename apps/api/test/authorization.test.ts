import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_SCOPE_TYPES,
  CAPABILITIES,
  type Capability,
  type ScopedAuthorizationGrant,
  type ScopedAuthorizationScreenTarget,
} from "@screengoblin/contracts";
import { randomToken, sha256 } from "../src/utils/crypto.js";
import { hasCapability } from "../src/authorization/policy.js";
import { evaluateScopedAuthorization } from "../src/authorization/scoped.js";
import type { Role } from "../src/domain/types.js";
import { MemoryStore } from "../src/store/memory.js";

const allowedOrigins = { mediaAllowedOrigins: ["https://media.example.test"] };
const idempotency = () => ({
  keyHash: sha256(randomToken()),
  requestDigestSha256: sha256(randomToken()),
});

async function releaseFixture(role: Role) {
  const store = new MemoryStore();
  store.users.push({
    id: "actor",
    email: "actor@example.test",
    name: "Actor",
    passwordHash: "unused",
    organizationId: "org-a",
    role,
    authenticationEpoch: 0,
    authorizationEpoch: 0,
  });
  store.users.push({
    id: "approver",
    email: "approver@example.test",
    name: "Approver",
    passwordHash: "unused",
    organizationId: "org-a",
    role: "ADMIN",
    authenticationEpoch: 0,
    authorizationEpoch: 0,
  });
  const screen = await store.createScreen("org-a", {
    name: "Lobby",
    location: "",
    orientation: "landscape",
    resolution: "1920x1080",
    tags: [],
  });
  const media = await store.createMedia("org-a", {
    name: "Welcome",
    kind: "image",
    mimeType: "image/png",
    url: "https://media.example.test/welcome.png",
    checksumSha256: "a".repeat(64),
    sizeBytes: 3,
  });
  const playlist = await store.createPlaylist("org-a", {
    name: "Lobby",
    description: "",
    items: [
      { id: "item", assetId: media.id, position: 0, durationSeconds: 15 },
    ],
  });
  return {
    store,
    input: {
      playlistId: playlist.id,
      name: "School day",
      priority: "normal" as const,
      startsAt: "2026-09-14T00:00:00.000Z",
      endsAt: "2026-09-15T00:00:00.000Z",
      timezone: "UTC",
      daysOfWeek: [],
      enabled: true,
      screenIds: [screen.id],
    },
  };
}

describe("release capability policy", () => {
  it.each([
    ["OWNER", true],
    ["ADMIN", true],
    ["PUBLISHER", true],
    ["VIEWER", false],
  ] as const)("maps the %s compatibility role", (role, allowed) => {
    expect(hasCapability(role, CAPABILITIES.releasePublish)).toBe(allowed);
    expect(hasCapability(role, CAPABILITIES.releaseWithdraw)).toBe(allowed);
  });

  it("fails closed for unknown roles and capabilities", () => {
    expect(hasCapability("SUPERUSER", CAPABILITIES.releasePublish)).toBe(false);
    expect(hasCapability("OWNER", "release.unknown")).toBe(false);
    expect(hasCapability(undefined, CAPABILITIES.releasePublish)).toBe(false);
  });

  it.each([
    ["OWNER", true],
    ["ADMIN", true],
    ["PUBLISHER", false],
    ["VIEWER", false],
  ] as const)("maps credential revocation for %s", (role, allowed) => {
    expect(hasCapability(role, CAPABILITIES.screenCredentialRevoke)).toBe(
      allowed,
    );
    expect(hasCapability(role, CAPABILITIES.screenCredentialReenroll)).toBe(
      allowed,
    );
  });

  it.each(["OWNER", "ADMIN", "PUBLISHER", "VIEWER"] as const)(
    "grants the non-emergency read ceiling to %s",
    (role) => {
      expect(hasCapability(role, CAPABILITIES.screenRead)).toBe(true);
      expect(hasCapability(role, CAPABILITIES.locationRead)).toBe(true);
      expect(hasCapability(role, CAPABILITIES.mediaRead)).toBe(true);
      expect(hasCapability(role, CAPABILITIES.playlistRead)).toBe(true);
      expect(hasCapability(role, CAPABILITIES.scheduleRead)).toBe(true);
      expect(hasCapability(role, CAPABILITIES.releaseCandidateRead)).toBe(true);
    },
  );

  it.each([
    ["OWNER", true],
    ["ADMIN", false],
    ["PUBLISHER", false],
    ["VIEWER", false],
  ] as const)("limits authorization management for %s", (role, allowed) => {
    expect(hasCapability(role, CAPABILITIES.authorizationManage)).toBe(allowed);
  });

  it.each(["OWNER", "ADMIN", "PUBLISHER", "VIEWER"] as const)(
    "does not derive emergency authority from the legacy %s role",
    (role) => {
      expect(hasCapability(role, CAPABILITIES.emergencyActivate)).toBe(false);
      expect(hasCapability(role, CAPABILITIES.emergencyClear)).toBe(false);
    },
  );

  it.each(["VIEWER", "disabled", "missing", "cross-organization"] as const)(
    "denies direct publication for a %s actor without partial writes",
    async (scenario) => {
      const { store, input } = await releaseFixture(
        scenario === "VIEWER" ? "VIEWER" : "PUBLISHER",
      );
      if (scenario === "disabled")
        store.users[0]!.disabledAt = "2026-09-12T00:00:00.000Z";
      if (scenario === "cross-organization")
        store.users[0]!.organizationId = "org-b";
      const actorUserId = scenario === "missing" ? "missing" : "actor";

      await expect(
        store.publishScheduleAndAudit(
          "org-a",
          input,
          { actorUserId },
          allowedOrigins,
          idempotency(),
        ),
      ).resolves.toEqual({ published: false, reason: "FORBIDDEN" });
      expect(store.schedules).toEqual([]);
      expect(store.releases).toEqual([]);
      expect(store.releaseAssignments).toEqual([]);
      expect(store.audits).toEqual([]);
    },
  );

  it("re-evaluates current authority before withdrawal", async () => {
    const { store, input } = await releaseFixture("PUBLISHER");
    const created = await store.createReleaseCandidateAndAudit(
      "org-a",
      {
        ...input,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      { actorUserId: "actor" },
      allowedOrigins,
      idempotency(),
    );
    if (!created.completed) throw new Error(created.reason);
    await store.submitReleaseCandidateAndAudit(
      "org-a",
      created.candidate.id,
      created.candidate.digestSha256,
      { actorUserId: "actor" },
      idempotency(),
    );
    await store.approveReleaseCandidateAndAudit(
      "org-a",
      created.candidate.id,
      created.candidate.digestSha256,
      { actorUserId: "approver" },
      idempotency(),
    );
    const publication = await store.publishReleaseCandidateAndAudit(
      "org-a",
      created.candidate.id,
      created.candidate.digestSha256,
      { actorUserId: "actor" },
      allowedOrigins,
      idempotency(),
    );
    if (!publication.completed) throw new Error(publication.reason);
    store.users[0]!.role = "VIEWER";

    await expect(
      store.publishScheduleAndAudit(
        "org-a",
        input,
        { actorUserId: "actor" },
        allowedOrigins,
        idempotency(),
      ),
    ).resolves.toEqual({ published: false, reason: "FORBIDDEN" });

    await expect(
      store.withdrawScheduleAndAudit(
        "org-a",
        publication.candidate.scheduleId!,
        {
          actorUserId: "actor",
        },
      ),
    ).resolves.toEqual({ withdrawn: false, reason: "FORBIDDEN" });
    expect(
      store.releaseAssignments.map((assignment) => assignment.state),
    ).toEqual(["ASSIGNED"]);
    expect(store.audits.map(({ action }) => action)).toEqual([
      "release.candidate.created",
      "release.candidate.submitted",
      "release.candidate.approved",
      "release.candidate.published",
      "release.published",
    ]);
  });
});

const evaluationTime = "2026-09-15T12:00:00.000Z";
const target = (
  screenId: string,
  locationId: string | null = "location-a",
  screenGroupIds: readonly string[] = ["group-a"],
): ScopedAuthorizationScreenTarget => ({
  organizationId: "org-a",
  screenId,
  locationId,
  screenGroupIds,
});
const scopedGrant = (
  overrides: Partial<ScopedAuthorizationGrant> = {},
): ScopedAuthorizationGrant => ({
  id: "grant-a",
  organizationId: "org-a",
  subjectUserId: "actor",
  subjectMembershipId: "membership-a",
  capability: CAPABILITIES.releasePublish,
  scopeType: AUTHORIZATION_SCOPE_TYPES.organization,
  startsAt: "2026-09-15T11:00:00.000Z",
  ...overrides,
});
const evaluate = (
  overrides: Partial<Parameters<typeof evaluateScopedAuthorization>[0]> = {},
) =>
  evaluateScopedAuthorization({
    organizationId: "org-a",
    actorUserId: "actor",
    membershipId: "membership-a",
    role: "PUBLISHER",
    authorizationEpoch: 3,
    capability: CAPABILITIES.releasePublish,
    evaluatedAt: evaluationTime,
    grants: [scopedGrant()],
    targets: [target("screen-a")],
    ...overrides,
  });

describe("pure scoped authorization policy", () => {
  it.each([
    [AUTHORIZATION_SCOPE_TYPES.organization, null],
    [AUTHORIZATION_SCOPE_TYPES.location, "location-a"],
    [AUTHORIZATION_SCOPE_TYPES.screenGroup, "group-a"],
    [AUTHORIZATION_SCOPE_TYPES.screen, "screen-a"],
  ] as const)("covers a target through a %s grant", (scopeType, scopeId) => {
    const result = evaluate({
      grants: [scopedGrant({ scopeType, scopeId })],
    });

    expect(result).toMatchObject({
      allowed: true,
      reason: "ALLOWED",
      matchingGrantIds: ["grant-a"],
    });
    expect(result.evidenceDigestSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("requires every target while permitting a union of narrow grants", () => {
    const grants = [
      scopedGrant({
        id: "grant-location",
        scopeType: AUTHORIZATION_SCOPE_TYPES.location,
        scopeId: "location-a",
      }),
      scopedGrant({
        id: "grant-group",
        scopeType: AUTHORIZATION_SCOPE_TYPES.screenGroup,
        scopeId: "group-b",
      }),
      scopedGrant({
        id: "grant-screen",
        scopeType: AUTHORIZATION_SCOPE_TYPES.screen,
        scopeId: "screen-c",
      }),
    ];
    expect(
      evaluate({
        grants,
        targets: [
          target("screen-a", "location-a", []),
          target("screen-b", "location-b", ["group-b"]),
          target("screen-c", "location-c", []),
        ],
      }),
    ).toMatchObject({
      allowed: true,
      matchingGrantIds: ["grant-group", "grant-location", "grant-screen"],
    });
    expect(
      evaluate({
        grants: grants.slice(0, 2),
        targets: [
          target("screen-a", "location-a", []),
          target("screen-b", "location-b", ["group-b"]),
          target("screen-c", "location-c", []),
        ],
      }),
    ).toMatchObject({ allowed: false, reason: "SCOPE_DENIED" });
  });

  it("does not let a location grant cover an unclassified screen", () => {
    expect(
      evaluate({
        grants: [
          scopedGrant({
            scopeType: AUTHORIZATION_SCOPE_TYPES.location,
            scopeId: "location-a",
          }),
        ],
        targets: [target("screen-a", null, [])],
      }),
    ).toMatchObject({ allowed: false, reason: "SCOPE_DENIED" });
    expect(
      evaluate({
        grants: [
          scopedGrant({
            scopeType: AUTHORIZATION_SCOPE_TYPES.screen,
            scopeId: "screen-a",
          }),
        ],
        targets: [target("screen-a", null, [])],
      }),
    ).toMatchObject({ allowed: true, reason: "ALLOWED" });
  });

  it.each([
    ["PUBLISHER", CAPABILITIES.releaseApprove],
    ["VIEWER", CAPABILITIES.releasePublish],
    ["ADMIN", CAPABILITIES.authorizationManage],
    ["SUPERUSER", CAPABILITIES.releasePublish],
  ] as const)("enforces the %s role ceiling for %s", (role, capability) => {
    expect(
      evaluate({
        role,
        capability,
        grants: [scopedGrant({ capability })],
      }),
    ).toMatchObject({ allowed: false, reason: "ROLE_CEILING_DENIED" });
  });

  it("allows a viewer only its read ceiling when scope coverage exists", () => {
    expect(
      evaluate({
        role: "VIEWER",
        capability: CAPABILITIES.screenRead,
        grants: [
          scopedGrant({
            capability: CAPABILITIES.screenRead,
            scopeType: AUTHORIZATION_SCOPE_TYPES.screen,
            scopeId: "screen-a",
          }),
        ],
      }),
    ).toMatchObject({ allowed: true, reason: "ALLOWED" });
    expect(
      evaluate({
        role: "VIEWER",
        capability: CAPABILITIES.mediaRead,
        grants: [scopedGrant({ capability: CAPABILITIES.mediaRead })],
        targets: [],
      }),
    ).toMatchObject({ allowed: true, reason: "ALLOWED" });
  });

  it("keeps grant administration unavailable to the scoped evaluator", () => {
    expect(
      evaluate({
        role: "OWNER",
        capability: CAPABILITIES.authorizationManage,
        grants: [],
        targets: [],
      }),
    ).toMatchObject({
      allowed: false,
      reason: "SCOPE_DENIED",
      matchingGrantIds: [],
    });
    expect(
      evaluate({
        role: "OWNER",
        capability: CAPABILITIES.authorizationManage,
        grants: [],
        targets: [target("screen-a")],
      }),
    ).toMatchObject({
      allowed: false,
      reason: "SCOPE_DENIED",
    });
  });

  it("allows only an organization grant for organization-scoped reads", () => {
    const organizationGrant = scopedGrant({
      capability: CAPABILITIES.mediaRead,
    });
    expect(
      evaluate({
        capability: CAPABILITIES.mediaRead,
        grants: [organizationGrant],
        targets: [],
      }),
    ).toMatchObject({ allowed: true, reason: "ALLOWED" });
    expect(
      evaluate({
        capability: CAPABILITIES.mediaRead,
        grants: [
          scopedGrant({
            capability: CAPABILITIES.mediaRead,
            scopeType: AUTHORIZATION_SCOPE_TYPES.location,
            scopeId: "location-a",
          }),
        ],
        targets: [],
      }),
    ).toMatchObject({ allowed: false, reason: "SCOPE_DENIED" });
    expect(
      evaluate({
        capability: CAPABILITIES.mediaRead,
        grants: [organizationGrant],
        targets: [target("screen-a")],
      }),
    ).toMatchObject({
      allowed: false,
      reason: "ORGANIZATION_SCOPE_REQUIRED",
    });
  });

  it("requires at least one concrete target for target-scoped capabilities", () => {
    expect(evaluate({ targets: [] })).toMatchObject({
      allowed: false,
      reason: "TARGETS_REQUIRED",
    });
  });

  it("uses inclusive starts and exclusive expiries from the evaluation time", () => {
    expect(
      evaluate({
        evaluatedAt: "2026-09-15T11:00:00.000Z",
        grants: [
          scopedGrant({
            startsAt: "2026-09-15T11:00:00.000Z",
            expiresAt: "2026-09-15T12:00:00.000Z",
          }),
        ],
      }),
    ).toMatchObject({ allowed: true });
    expect(
      evaluate({
        grants: [
          scopedGrant({
            expiresAt: evaluationTime,
          }),
        ],
      }),
    ).toMatchObject({ allowed: false, reason: "SCOPE_DENIED" });
    expect(
      evaluate({
        grants: [
          scopedGrant({
            startsAt: "2026-09-15T12:00:00.001Z",
          }),
        ],
      }),
    ).toMatchObject({ allowed: false, reason: "SCOPE_DENIED" });
  });

  it.each([
    scopedGrant({ revokedAt: "2026-09-15T11:30:00.000Z" }),
    scopedGrant({ organizationId: "org-b" }),
    scopedGrant({ subjectUserId: "someone-else" }),
    scopedGrant({ subjectMembershipId: "" }),
    scopedGrant({ subjectMembershipId: "former-membership" }),
    scopedGrant({ capability: CAPABILITIES.releaseWithdraw }),
    scopedGrant({ startsAt: "invalid" }),
    scopedGrant({ startsAt: "2026-09-15T11:00:00Z" }),
    scopedGrant({ scopeId: "unexpected" }),
    scopedGrant({
      scopeType: AUTHORIZATION_SCOPE_TYPES.location,
      scopeId: null,
    }),
  ])("ignores a revoked, foreign, inactive, or malformed grant", (grant) => {
    expect(evaluate({ grants: [grant] })).toMatchObject({
      allowed: false,
      reason: "SCOPE_DENIED",
      matchingGrantIds: [],
    });
  });

  it("fails closed for unknown capability and scope values", () => {
    expect(
      evaluate({
        capability: "release.unknown",
        grants: [],
      }),
    ).toMatchObject({ allowed: false, reason: "UNKNOWN_CAPABILITY" });
    expect(
      evaluate({
        grants: [
          scopedGrant({
            scopeType: "UNRECOGNIZED" as ScopedAuthorizationGrant["scopeType"],
          }),
        ],
      }),
    ).toMatchObject({ allowed: false, reason: "SCOPE_DENIED" });
  });

  it.each([
    { evaluatedAt: "not-an-instant" },
    { authorizationEpoch: -1 },
    { organizationId: "" },
    {
      targets: undefined as unknown as ScopedAuthorizationScreenTarget[],
    },
    {
      targets: [
        target("screen-a"),
        target("screen-a", "location-b", ["group-b"]),
      ],
    },
    {
      targets: [{ ...target("screen-a"), organizationId: "org-b" }],
    },
  ])("fails closed for an invalid evaluation context", (override) => {
    expect(evaluate(override)).toMatchObject({
      allowed: false,
      reason: "INVALID_CONTEXT",
    });
  });

  it("rejects duplicate active grant identifiers as ambiguous evidence", () => {
    expect(
      evaluate({
        grants: [
          scopedGrant(),
          scopedGrant({
            scopeType: AUTHORIZATION_SCOPE_TYPES.screen,
            scopeId: "screen-a",
          }),
        ],
      }),
    ).toMatchObject({ allowed: false, reason: "INVALID_CONTEXT" });
  });

  it("produces deterministic evidence independent of input ordering", () => {
    const grants = [
      scopedGrant({
        id: "grant-b",
        scopeType: AUTHORIZATION_SCOPE_TYPES.screen,
        scopeId: "screen-b",
      }),
      scopedGrant({
        id: "grant-a",
        scopeType: AUTHORIZATION_SCOPE_TYPES.screen,
        scopeId: "screen-a",
      }),
    ];
    const first = evaluate({
      grants,
      targets: [
        target("screen-b", "location-b", ["group-z", "group-a"]),
        target("screen-a", "location-a", []),
      ],
    });
    const second = evaluate({
      grants: [...grants].reverse(),
      targets: [
        target("screen-a", "location-a", []),
        target("screen-b", "location-b", ["group-a", "group-z"]),
      ],
    });

    expect(second).toEqual(first);
  });

  it("keeps scope evidence stable while the same grant remains active", () => {
    const grant = scopedGrant({
      startsAt: "2026-09-15T10:00:00.000Z",
      expiresAt: "2026-09-15T14:00:00.000Z",
    });
    const first = evaluate({
      evaluatedAt: "2026-09-15T11:00:00.000Z",
      grants: [grant],
    });
    const second = evaluate({
      evaluatedAt: "2026-09-15T13:00:00.000Z",
      grants: [grant],
    });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(second.evidenceDigestSha256).toBe(first.evidenceDigestSha256);
  });

  it("binds evidence to epoch, current classification, and selected grant", () => {
    const baseline = evaluate({
      grants: [
        scopedGrant({
          scopeType: AUTHORIZATION_SCOPE_TYPES.location,
          scopeId: "location-a",
        }),
      ],
    }).evidenceDigestSha256;
    expect(
      evaluate({
        authorizationEpoch: 4,
        grants: [
          scopedGrant({
            scopeType: AUTHORIZATION_SCOPE_TYPES.location,
            scopeId: "location-a",
          }),
        ],
      }).evidenceDigestSha256,
    ).not.toBe(baseline);
    expect(
      evaluate({
        grants: [
          scopedGrant({
            id: "replacement-grant",
            scopeType: AUTHORIZATION_SCOPE_TYPES.location,
            scopeId: "location-a",
          }),
        ],
      }).evidenceDigestSha256,
    ).not.toBe(baseline);
    const organizationGrant = scopedGrant();
    const classified = evaluate({
      grants: [organizationGrant],
      targets: [target("screen-a", "location-a", [])],
    }).evidenceDigestSha256;
    expect(
      evaluate({
        grants: [organizationGrant],
        targets: [target("screen-a", "location-b", [])],
      }).evidenceDigestSha256,
    ).not.toBe(classified);
  });

  it("keeps a deterministic minimal evidence set when grants overlap", () => {
    const result = evaluate({
      grants: [
        scopedGrant({ id: "z-organization" }),
        scopedGrant({
          id: "a-screen",
          scopeType: AUTHORIZATION_SCOPE_TYPES.screen,
          scopeId: "screen-a",
        }),
      ],
    });
    expect(result).toMatchObject({
      allowed: true,
      matchingGrantIds: ["a-screen"],
    });
  });

  it("does not admit emergency capabilities through any legacy role", () => {
    for (const role of ["OWNER", "ADMIN", "PUBLISHER", "VIEWER"] as const) {
      expect(
        evaluate({
          role,
          capability: CAPABILITIES.emergencyActivate,
          grants: [
            scopedGrant({
              capability: CAPABILITIES.emergencyActivate as Capability,
            }),
          ],
        }),
      ).toMatchObject({ allowed: false, reason: "ROLE_CEILING_DENIED" });
    }
  });
});
