import type { FleetSummary, ScreenSummary } from "@screengoblin/contracts";
import { demoFleet, screens } from "./data";

export type ApiResult<T> = { data: T; source: "live" | "demo" };
export interface LiveSession {
  accessToken: string;
  user: { name: string; email: string; role: string };
}

const baseUrl =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "/api/v1";

async function request<T>(path: string, fallback: T): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 2500);
  try {
    const accessToken = window.sessionStorage.getItem("sg_access_token");
    if (!accessToken) throw new Error("No live API session");
    const response = await fetch(`${baseUrl}${path}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    return { data: (await response.json()) as T, source: "live" };
  } catch {
    return { data: fallback, source: "demo" };
  } finally {
    window.clearTimeout(timeout);
  }
}

async function mutate<T>(path: string, init: RequestInit): Promise<T> {
  const accessToken = window.sessionStorage.getItem("sg_access_token");
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      { error?: { message?: string } } | undefined;
    throw new Error(
      payload?.error?.message ?? `API returned ${response.status}`,
    );
  }
  return response.json() as Promise<T>;
}

export const api = {
  hasLiveSession: () =>
    Boolean(window.sessionStorage.getItem("sg_access_token")),
  login: async (email: string, password: string): Promise<LiveSession> => {
    const session = await mutate<LiveSession>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    window.sessionStorage.setItem("sg_access_token", session.accessToken);
    return session;
  },
  logout: () => window.sessionStorage.removeItem("sg_access_token"),
  createPairingCode: () =>
    mutate<{ code: string; expiresAt: string }>("/pairing-codes", {
      method: "POST",
    }),
  fleet: async (): Promise<ApiResult<FleetSummary>> => {
    const result = await request<{ data: ScreenSummary[] }>("/screens", {
      data: screens,
    });
    if (result.source === "demo") return { data: demoFleet, source: "demo" };
    const fleet = result.data.data.reduce<FleetSummary>(
      (summary, screen) => ({
        ...summary,
        total: summary.total + 1,
        [screen.status]: summary[screen.status] + 1,
      }),
      { total: 0, online: 0, warning: 0, offline: 0, fallback: 0 },
    );
    return { data: fleet, source: "live" };
  },
  screens: async (): Promise<ApiResult<ScreenSummary[]>> => {
    const result = await request<{ data: ScreenSummary[] }>("/screens", {
      data: screens,
    });
    return {
      data: result.data.data,
      source: result.source,
    };
  },
};
