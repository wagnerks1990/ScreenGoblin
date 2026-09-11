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
    expect(api.currentUser()).toBeUndefined();
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
});
