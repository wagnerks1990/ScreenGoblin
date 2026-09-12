import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "@screengoblin/contracts";
import { hasCapability } from "../src/authorization/policy.js";
import type { Role } from "../src/domain/types.js";
import { MemoryStore } from "../src/store/memory.js";

const allowedOrigins = { mediaAllowedOrigins: ["https://media.example.test"] };

async function releaseFixture(role: Role) {
  const store = new MemoryStore();
  store.users.push({
    id: "actor",
    email: "actor@example.test",
    name: "Actor",
    passwordHash: "unused",
    organizationId: "org-a",
    role,
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
    const publication = await store.publishScheduleAndAudit(
      "org-a",
      input,
      { actorUserId: "actor" },
      allowedOrigins,
    );
    if (!publication.published) throw new Error(publication.reason);
    store.users[0]!.role = "VIEWER";

    await expect(
      store.withdrawScheduleAndAudit("org-a", publication.schedule.id, {
        actorUserId: "actor",
      }),
    ).resolves.toEqual({ withdrawn: false, reason: "FORBIDDEN" });
    expect(
      store.releaseAssignments.map((assignment) => assignment.state),
    ).toEqual(["ASSIGNED"]);
    expect(store.audits).toHaveLength(1);
  });
});
