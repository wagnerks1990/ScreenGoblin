import type {
  FleetSummary,
  DeviceEnrollmentActivation,
  DeviceEnrollmentGrant,
  DeviceEnrollmentStatus,
  ManagementListResponse,
  ManagementPlaylist,
  ManagementSchedule,
  ManagementScreen,
  MediaAsset,
} from "@screengoblin/contracts";
import { demoFleet, screens, type DemoScreen } from "./data";

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

export interface LogoutResult {
  revocationConfirmed: boolean;
}

export type DeviceReenrollmentGrant = DeviceEnrollmentGrant;

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

export type DeviceReenrollmentStatus = Omit<
  DeviceEnrollmentStatus,
  "candidates"
> & { candidates: DeviceReenrollmentCandidate[] };

export interface DeviceReenrollmentActivation extends Partial<DeviceEnrollmentActivation> {
  screenId: string;
}

const baseUrl =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "/api/v1";
const invalidatedSessionKey = "sg_live_session_invalidated";

function clearSession(invalidated: boolean) {
  window.sessionStorage.removeItem("sg_access_token");
  window.sessionStorage.removeItem("sg_session_user");
  if (invalidated) window.sessionStorage.setItem(invalidatedSessionKey, "true");
  else window.sessionStorage.removeItem(invalidatedSessionKey);
  window.dispatchEvent(new Event("screengoblin:session-changed"));
}

async function authenticatedRequest<T>(path: string): Promise<T> {
  const accessToken = window.sessionStorage.getItem("sg_access_token");
  if (!accessToken) {
    if (window.sessionStorage.getItem(invalidatedSessionKey))
      throw new Error("Live session expired; sign in again");
    throw new Error("Connect the Console to the live API first");
  }
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
        clearSession(true);
      }
      throw new Error(`Live API returned HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function request<T>(path: string, fallback: T): Promise<ApiResult<T>> {
  if (!window.sessionStorage.getItem("sg_access_token")) {
    if (window.sessionStorage.getItem(invalidatedSessionKey))
      throw new Error("Live session expired; sign in again");
    return { data: fallback, source: "demo" };
  }
  return { data: await authenticatedRequest<T>(path), source: "live" };
}

async function mutate<T>(path: string, init: RequestInit): Promise<T> {
  const accessToken = window.sessionStorage.getItem("sg_access_token");
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    if (response.status === 401 && accessToken) clearSession(true);
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
  demoAllowed: () => !window.sessionStorage.getItem(invalidatedSessionKey),
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
    window.sessionStorage.removeItem(invalidatedSessionKey);
    window.sessionStorage.setItem(
      "sg_session_user",
      JSON.stringify(session.user),
    );
    return session;
  },
  logout: async (): Promise<LogoutResult> => {
    const accessToken = window.sessionStorage.getItem("sg_access_token");
    if (!accessToken) {
      clearSession(false);
      return { revocationConfirmed: true };
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 2500);
    let revocationConfirmed: boolean;
    try {
      const response = await fetch(`${baseUrl}/auth/logout`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        signal: controller.signal,
      });
      revocationConfirmed = response.status === 204;
    } catch {
      revocationConfirmed = false;
    } finally {
      window.clearTimeout(timeout);
      clearSession(false);
    }
    return { revocationConfirmed };
  },
  createScreenEnrollment: (
    screenId: string,
    reason: string,
    idempotencyKey: string,
  ) =>
    mutate<DeviceReenrollmentGrant>(
      `/screens/${encodeURIComponent(screenId)}/device-enrollment`,
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ reason }),
      },
    ),
  screenEnrollmentStatus: (screenId: string, grantId: string) =>
    mutate<DeviceReenrollmentStatus>(
      `/screens/${encodeURIComponent(screenId)}/device-enrollment/${encodeURIComponent(grantId)}`,
      { method: "GET" },
    ),
  activateScreenEnrollmentCandidate: (
    screenId: string,
    grantId: string,
    candidateId: string,
    fingerprint: string,
    idempotencyKey: string,
  ) =>
    mutate<DeviceReenrollmentActivation>(
      `/screens/${encodeURIComponent(screenId)}/device-enrollment/${encodeURIComponent(grantId)}/candidates/${encodeURIComponent(candidateId)}/activate`,
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ fingerprint }),
      },
    ),
  cancelScreenEnrollment: (screenId: string, grantId: string) =>
    mutate<void>(
      `/screens/${encodeURIComponent(screenId)}/device-enrollment/${encodeURIComponent(grantId)}`,
      { method: "DELETE" },
    ),
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
    const result = await request<{
      data: Array<ManagementScreen | DemoScreen>;
    }>("/screens", {
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
  screens: async (): Promise<
    ApiResult<Array<ManagementScreen | DemoScreen>>
  > => {
    const result = await request<{
      data: Array<ManagementScreen | DemoScreen>;
    }>("/screens", { data: screens });
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
  playlists: async (): Promise<ManagementPlaylist[]> =>
    (
      await authenticatedRequest<ManagementListResponse<ManagementPlaylist>>(
        "/playlists",
      )
    ).data,
  schedules: async (): Promise<ManagementSchedule[]> =>
    (
      await authenticatedRequest<ManagementListResponse<ManagementSchedule>>(
        "/schedules",
      )
    ).data,
};
