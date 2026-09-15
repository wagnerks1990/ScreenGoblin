import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ManagementReleaseCandidate,
  ReleaseCandidateCreateRequest,
} from "@screengoblin/contracts";
import { AmbiguousMutationError, ApiRequestError, api } from "./api";

beforeEach(() => window.sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());

const candidateInput: ReleaseCandidateCreateRequest = {
  playlistId: "playlist-1",
  name: "Morning rotation",
  priority: "normal",
  startsAt: "2030-01-01T08:00:00.000Z",
  timezone: "UTC",
  daysOfWeek: [1, 2, 3, 4, 5],
  enabled: true,
  screenIds: ["screen-1"],
  expiresAt: "2030-01-02T08:00:00.000Z",
};

const candidate: ManagementReleaseCandidate = {
  id: "candidate/1",
  state: "DRAFT",
  digestSha256: "a".repeat(64),
  releaseId: "release-1",
  releaseDigestSha256: "b".repeat(64),
  sourcePlaylistId: "playlist-1",
  authorUserId: "user-1",
  items: [],
  schedule: {
    name: candidateInput.name,
    priority: candidateInput.priority,
    startsAt: candidateInput.startsAt,
    timezone: candidateInput.timezone,
    daysOfWeek: candidateInput.daysOfWeek,
    enabled: candidateInput.enabled,
  },
  screenIds: candidateInput.screenIds,
  policyVersion: 1,
  expiresAt: candidateInput.expiresAt,
  createdAt: "2030-01-01T00:00:00.000Z",
};

describe("authenticated live data boundary", () => {
  it.each([
    [
      "missing id",
      {
        name: "Owner",
        email: "o@example.test",
        role: "OWNER",
        organizationId: "org",
      },
    ],
    [
      "invalid role",
      {
        id: "user",
        name: "Owner",
        email: "o@example.test",
        role: "ROOT",
        organizationId: "org",
      },
    ],
    ["wrong primitive", "owner"],
    ["array", []],
  ])("fails cached principal affordances closed for %s", (_label, value) => {
    window.sessionStorage.setItem("sg_session_user", JSON.stringify(value));

    expect(api.currentUser()).toBeUndefined();
    expect(window.sessionStorage.getItem("sg_session_user")).toBeNull();
  });

  it("never substitutes demo data after a live session fails", async () => {
    window.sessionStorage.setItem("sg_access_token", "live-token");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await expect(api.screens()).rejects.toThrow("offline");
  });

  it("clears the complete browser session after an unauthorized response", async () => {
    window.sessionStorage.setItem("sg_access_token", "expired-token");
    window.sessionStorage.setItem(
      "sg_session_user",
      JSON.stringify({
        name: "Viewer",
        email: "viewer@example.test",
        role: "VIEWER",
        organizationId: "org-a",
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    );

    await expect(api.screens()).rejects.toThrow("HTTP 401");
    expect(api.hasLiveSession()).toBe(false);
    expect(api.demoAllowed()).toBe(false);
    expect(api.currentUser()).toBeUndefined();
    await expect(api.screens()).rejects.toThrow("Live session expired");
  });

  it("clears the complete browser session after an unauthorized mutation", async () => {
    window.sessionStorage.setItem("sg_access_token", "expired-token");
    window.sessionStorage.setItem(
      "sg_session_user",
      JSON.stringify({
        name: "Administrator",
        email: "admin@example.test",
        role: "ADMIN",
        organizationId: "org-a",
      }),
    );
    const changed = vi.fn();
    window.addEventListener("screengoblin:session-changed", changed, {
      once: true,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(
      api.createScreenEnrollment(
        "screen-a",
        "Initial enrollment",
        "00000000-0000-4000-8000-000000000001",
      ),
    ).rejects.toThrow("Unauthorized");
    expect(api.hasLiveSession()).toBe(false);
    expect(api.demoAllowed()).toBe(false);
    expect(api.currentUser()).toBeUndefined();
    expect(changed).toHaveBeenCalledOnce();
  });

  it("revokes the current server session before clearing local credentials", async () => {
    window.sessionStorage.setItem("sg_access_token", "live-token");
    window.sessionStorage.setItem("sg_session_user", "{}");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.logout()).resolves.toEqual({ revocationConfirmed: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/auth/logout",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer live-token",
        }),
      }),
    );
    expect(api.hasLiveSession()).toBe(false);
    expect(api.currentUser()).toBeUndefined();
  });

  it("clears local credentials when server revocation cannot be confirmed", async () => {
    window.sessionStorage.setItem("sg_access_token", "sensitive-token");
    window.sessionStorage.setItem("sg_session_user", "{}");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await expect(api.logout()).resolves.toEqual({ revocationConfirmed: false });
    expect(api.hasLiveSession()).toBe(false);
    expect(api.currentUser()).toBeUndefined();
    expect(
      window.sessionStorage.getItem("sg_live_session_invalidated"),
    ).toBeNull();
  });

  it("sends targeted enrollment intent and its stable idempotency key", async () => {
    window.sessionStorage.setItem("sg_access_token", "live-token");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "123456",
          expiresAt: "2030-01-01T00:00:00.000Z",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.createScreenEnrollment(
        "screen-a",
        "Initial enrollment",
        "00000000-0000-4000-8000-000000000001",
      ),
    ).resolves.toMatchObject({
      expiresAt: "2030-01-01T00:00:00.000Z",
    });

    const headers = fetchMock.mock.calls[0]?.[1]?.headers;
    expect(headers).toMatchObject({
      Accept: "application/json",
      Authorization: "Bearer live-token",
      "Content-Type": "application/json",
      "Idempotency-Key": "00000000-0000-4000-8000-000000000001",
    });
  });

  it("stores a successful live login for the active browser tab", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            accessToken: "live-token",
            user: {
              id: "user-operator",
              name: "Operator",
              email: "operator@example.test",
              role: "ADMIN",
              organizationId: "org-a",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await api.login("operator@example.test", "valid-password");

    expect(api.hasLiveSession()).toBe(true);
    expect(api.currentUser()?.id).toBe("user-operator");
    expect(api.currentUser()?.email).toBe("operator@example.test");
  });

  it("uses demonstration data only when no live session was requested", async () => {
    const result = await api.screens();
    expect(result.source).toBe("demo");
    expect(result.data.length).toBeGreaterThan(0);
  });

  it("keeps demo mode available after an unauthenticated login rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    );

    await expect(
      api.login("owner@example.test", "wrong-password"),
    ).rejects.toThrow("API returned 401");
    expect(api.demoAllowed()).toBe(true);
    expect((await api.screens()).source).toBe("demo");
  });

  it("loads media from the authenticated API without a live fallback", async () => {
    window.sessionStorage.setItem("sg_access_token", "live-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const result = await api.media();
    expect(result).toEqual({ data: [], source: "live" });
  });

  it("loads playlist and schedule records only through authenticated reads", async () => {
    window.sessionStorage.setItem("sg_access_token", "live-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "playlist-1",
                name: "Live rotation",
                description: "",
                items: [],
                createdAt: "2030-01-01T00:00:00.000Z",
                updatedAt: "2030-01-01T00:00:00.000Z",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "schedule-1",
                playlistId: "playlist-1",
                name: "Configured rotation",
                priority: "normal",
                startsAt: "2030-01-01T00:00:00.000Z",
                timezone: "UTC",
                daysOfWeek: [],
                enabled: true,
                screenIds: [],
                createdAt: "2030-01-01T00:00:00.000Z",
                updatedAt: "2030-01-01T00:00:00.000Z",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.playlists()).resolves.toHaveLength(1);
    await expect(api.schedules()).resolves.toHaveLength(1);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/playlists",
      "/api/v1/schedules",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({
        headers: expect.objectContaining({
          Authorization: "Bearer live-token",
        }),
      });
    }
  });

  it("does not provide playlist or schedule fixture fallbacks without a live session", async () => {
    await expect(api.playlists()).rejects.toThrow("Connect the Console");
    await expect(api.schedules()).rejects.toThrow("Connect the Console");
  });

  it("invalidates the live session instead of substituting fixtures for a failed management read", async () => {
    window.sessionStorage.setItem("sg_access_token", "expired-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    );

    await expect(api.playlists()).rejects.toThrow("HTTP 401");
    expect(api.hasLiveSession()).toBe(false);
    expect(api.demoAllowed()).toBe(false);
    await expect(api.schedules()).rejects.toThrow("Live session expired");
  });

  it("uses the authenticated staged device replacement endpoints", async () => {
    window.sessionStorage.setItem("sg_access_token", "admin-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            grantId: "grant/1",
            screenId: "screen/1",
            code: "123456",
            expiresAt: "2030-01-01T00:00:00.000Z",
            generation: 2,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            grantId: "grant/1",
            screenId: "screen/1",
            status: "PENDING_APPROVAL",
            expiresAt: "2030-01-01T00:00:00.000Z",
            candidates: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ screenId: "screen/1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.createDeviceReenrollment("screen/1", "Replace failed player");
    await api.deviceReenrollmentStatus("screen/1", "grant/1");
    await api.activateDeviceReenrollmentCandidate(
      "screen/1",
      "grant/1",
      "candidate/1",
    );
    await expect(
      api.cancelDeviceReenrollment("screen/1", "grant/1"),
    ).resolves.toBeUndefined();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/screens/screen%2F1/device-reenrollment",
      "/api/v1/screens/screen%2F1/device-reenrollment/grant%2F1",
      "/api/v1/screens/screen%2F1/device-reenrollment/grant%2F1/candidates/candidate%2F1/activate",
      "/api/v1/screens/screen%2F1/device-reenrollment/grant%2F1",
    ]);
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer admin-token",
      }),
    });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ reason: "Replace failed player" }),
    });
  });
});

describe("release approval API", () => {
  beforeEach(() =>
    window.sessionStorage.setItem("sg_access_token", "publisher-token"),
  );

  it("reads the tenant candidate collection and an encoded candidate ID", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [candidate] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(candidate), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.releaseCandidates()).resolves.toEqual([candidate]);
    await expect(api.releaseCandidate("candidate/1")).resolves.toEqual(
      candidate,
    );
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/release-candidates",
      "/api/v1/release-candidates/candidate%2F1",
    ]);
  });

  it("sends exact caller-owned idempotency keys for create and every transition", async () => {
    const key = "00000000-0000-4000-8000-000000000001";
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify(candidate), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.createReleaseCandidate(candidateInput, key);
    await api.submitReleaseCandidate(
      "candidate/1",
      { digestSha256: candidate.digestSha256 },
      key,
    );
    await api.approveReleaseCandidate(
      "candidate/1",
      { digestSha256: candidate.digestSha256 },
      key,
    );
    await api.publishReleaseCandidate(
      "candidate/1",
      { digestSha256: candidate.digestSha256 },
      key,
    );

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/release-candidates",
      "/api/v1/release-candidates/candidate%2F1/submit",
      "/api/v1/release-candidates/candidate%2F1/approve",
      "/api/v1/release-candidates/candidate%2F1/publish",
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify(candidateInput),
    });
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer publisher-token",
        "Idempotency-Key": key,
      });
    }
    for (const [, init] of fetchMock.mock.calls.slice(1))
      expect(init?.body).toBe(
        JSON.stringify({ digestSha256: candidate.digestSha256 }),
      );
  });

  it("preserves structured API status and error code for rejected commands", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "AUTHOR_CANNOT_APPROVE",
              message: "Release candidate rejected",
            },
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const result = api.approveReleaseCandidate(
      candidate.id,
      { digestSha256: candidate.digestSha256 },
      "00000000-0000-4000-8000-000000000002",
    );
    await expect(result).rejects.toMatchObject({
      name: "ApiRequestError",
      message: "Release candidate rejected",
      status: 409,
      code: "AUTHOR_CANNOT_APPROVE",
    } satisfies Partial<ApiRequestError>);
  });

  it("reports an interrupted command as ambiguous and retains its retry key", async () => {
    const key = "00000000-0000-4000-8000-000000000003";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    const error = await api
      .publishReleaseCandidate(
        candidate.id,
        { digestSha256: candidate.digestSha256 },
        key,
      )
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: "AmbiguousMutationError",
      operation: "Release candidate publish",
      idempotencyKey: key,
    } satisfies Partial<AmbiguousMutationError>);
    expect(error).toBeInstanceOf(AmbiguousMutationError);
    expect((error as Error).message).toContain("same idempotency key");
  });

  it.each([408, 500, 502, 503, 504])(
    "treats HTTP %i as an ambiguous mutation outcome",
    async (status) => {
      const key = "00000000-0000-4000-8000-000000000099";
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(null, { status })),
      );

      await expect(
        api.createReleaseCandidate(candidateInput, key),
      ).rejects.toMatchObject({
        name: "AmbiguousMutationError",
        idempotencyKey: key,
      });
    },
  );

  it("times out interrupted release mutations as ambiguous outcomes", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: RequestInfo | URL, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(new DOMException("aborted", "AbortError")),
              );
            }),
        ),
      );
      const result = api.submitReleaseCandidate(
        candidate.id,
        { digestSha256: candidate.digestSha256 },
        "00000000-0000-4000-8000-000000000004",
      );
      const assertion = expect(result).rejects.toBeInstanceOf(
        AmbiguousMutationError,
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("withdraws an encoded schedule and treats transport failure as ambiguous", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.withdrawSchedule("schedule/1")).resolves.toBeUndefined();
    const error = await api
      .withdrawSchedule("schedule/2")
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: "AmbiguousMutationError",
      operation: "Schedule withdrawal",
    });
    expect((error as AmbiguousMutationError).idempotencyKey).toBeUndefined();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/schedules/schedule%2F1",
      "/api/v1/schedules/schedule%2F2",
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "DELETE" });
  });
});
