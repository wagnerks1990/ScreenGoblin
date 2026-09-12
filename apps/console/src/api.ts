import type {
  FleetSummary,
  MediaAsset,
  ScreenSummary,
} from "@screengoblin/contracts";
import { demoFleet, screens } from "./data";

export type ApiResult<T> = { data: T; source: "live" | "demo" };
export interface LiveSession {
  accessToken: string;
  user: {
    name: string;
    email: string;
    role: "OWNER" | "ADMIN" | "PUBLISHER" | "VIEWER";
    organizationId: string;
  };
}

export interface DeviceReenrollmentGrant {
  grantId: string;
  screenId: string;
  code: string;
  expiresAt: string;
  generation: number;
}

export interface DeviceReenrollmentCandidate {
  id: string;
  keyId: string;
  fingerprint: string;
  securityLevel: string;
  device: {
    model: string;
    osVersion: string;
    playerVersion: string;
    installationId: string;
    manufacturer?: string;
    platform?: string;
    appVersion?: string;
  };
  provedAt: string;
}

export interface DeviceReenrollmentStatus {
  grantId: string;
  screenId: string;
  status: string;
  expiresAt: string;
  candidates: DeviceReenrollmentCandidate[];
}

export interface DeviceReenrollmentActivation {
  grantId?: string;
  screenId: string;
  candidateId?: string;
  credentialId?: string;
  keyId?: string;
  activatedAt?: string;
  status?: string;
}

const baseUrl =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "/api/v1";

function clearSession() {
  window.sessionStorage.removeItem("sg_access_token");
  window.sessionStorage.removeItem("sg_session_user");
  window.dispatchEvent(new Event("screengoblin:session-changed"));
}

async function request<T>(path: string, fallback: T): Promise<ApiResult<T>> {
  const accessToken = window.sessionStorage.getItem("sg_access_token");
  if (!accessToken) return { data: fallback, source: "demo" };
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 401) {
        clearSession();
      }
      throw new Error(`Live API returned HTTP ${response.status}`);
    }
    return { data: (await response.json()) as T, source: "live" };
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
    if (response.status === 401) clearSession();
    const payload = (await response.json().catch(() => undefined)) as
      { error?: { message?: string } } | undefined;
    throw new Error(
      payload?.error?.message ?? `API returned ${response.status}`,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  hasLiveSession: () =>
    Boolean(window.sessionStorage.getItem("sg_access_token")),
  currentUser: (): LiveSession["user"] | undefined => {
    const raw = window.sessionStorage.getItem("sg_session_user");
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as LiveSession["user"];
    } catch {
      window.sessionStorage.removeItem("sg_session_user");
      return undefined;
    }
  },
  login: async (email: string, password: string): Promise<LiveSession> => {
    const session = await mutate<LiveSession>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    window.sessionStorage.setItem("sg_access_token", session.accessToken);
    window.sessionStorage.setItem(
      "sg_session_user",
      JSON.stringify(session.user),
    );
    return session;
  },
  logout: () => {
    clearSession();
  },
  createPairingCode: () =>
    mutate<{ code: string; expiresAt: string }>("/pairing-codes", {
      method: "POST",
    }),
  createDeviceReenrollment: (screenId: string, reason: string) =>
    mutate<DeviceReenrollmentGrant>(
      `/screens/${encodeURIComponent(screenId)}/device-reenrollment`,
      { method: "POST", body: JSON.stringify({ reason }) },
    ),
  deviceReenrollmentStatus: (screenId: string, grantId: string) =>
    mutate<DeviceReenrollmentStatus>(
      `/screens/${encodeURIComponent(screenId)}/device-reenrollment/${encodeURIComponent(grantId)}`,
      { method: "GET" },
    ),
  activateDeviceReenrollmentCandidate: (
    screenId: string,
    grantId: string,
    candidateId: string,
  ) =>
    mutate<DeviceReenrollmentActivation>(
      `/screens/${encodeURIComponent(screenId)}/device-reenrollment/${encodeURIComponent(grantId)}/candidates/${encodeURIComponent(candidateId)}/activate`,
      { method: "POST" },
    ),
  cancelDeviceReenrollment: (screenId: string, grantId: string) =>
    mutate<void>(
      `/screens/${encodeURIComponent(screenId)}/device-reenrollment/${encodeURIComponent(grantId)}`,
      { method: "DELETE" },
    ),
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
  media: async (): Promise<ApiResult<MediaAsset[]>> => {
    const result = await request<{ data: MediaAsset[] }>("/media", {
      data: [],
    });
    return { data: result.data.data, source: result.source };
  },
};
