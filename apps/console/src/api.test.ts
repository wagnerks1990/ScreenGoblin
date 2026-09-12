import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

beforeEach(() => window.sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("authenticated live data boundary", () => {
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

    await expect(api.createPairingCode()).rejects.toThrow("Unauthorized");
    expect(api.hasLiveSession()).toBe(false);
    expect(api.demoAllowed()).toBe(false);
    expect(api.currentUser()).toBeUndefined();
    expect(changed).toHaveBeenCalledOnce();
  });

  it("stores a successful live login for the active browser tab", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            accessToken: "live-token",
            user: {
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
