import { createHmac } from "node:crypto";
import type { FullConfig } from "@playwright/test";

const apiBaseUrl =
  process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3000/api/v1";

function requiredOwnerCredentials() {
  const email = process.env.SEED_ADMIN_EMAIL?.trim();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are required for Console E2E tests",
    );
  }
  return { email, password };
}

async function jsonResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Bootstrap authentication returned an invalid response");
  }
  return payload as Record<string, unknown>;
}

export default async function globalSetup(_config: FullConfig) {
  const owner = requiredOwnerCredentials();
  const replacementPassword = createHmac("sha256", owner.password)
    .update(`screengoblin-console-e2e\0${owner.email}\0${apiBaseUrl}`)
    .digest("base64url");
  const loginResponse = await fetch(`${apiBaseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(owner),
    signal: AbortSignal.timeout(10_000),
  });
  if (!loginResponse.ok && loginResponse.status !== 401) {
    throw new Error(
      `Bootstrap owner login failed with HTTP ${loginResponse.status}`,
    );
  }
  if (loginResponse.ok) {
    const bootstrap = await jsonResponse(loginResponse);
    if (
      bootstrap.nextAction !== "CHANGE_BOOTSTRAP_PASSWORD" ||
      typeof bootstrap.accessToken !== "string" ||
      bootstrap.accessToken.length === 0
    ) {
      throw new Error(
        "Seeded owner did not require bootstrap password rotation",
      );
    }

    const rotationResponse = await fetch(
      `${apiBaseUrl}/auth/bootstrap-password`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bootstrap.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          currentPassword: owner.password,
          newPassword: replacementPassword,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (rotationResponse.status !== 204) {
      throw new Error(
        `Bootstrap password rotation failed with HTTP ${rotationResponse.status}`,
      );
    }
  }

  const verificationResponse = await fetch(`${apiBaseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: owner.email,
      password: replacementPassword,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!verificationResponse.ok) {
    throw new Error(
      `Rotated owner login failed with HTTP ${verificationResponse.status}`,
    );
  }
  const session = await jsonResponse(verificationResponse);
  if (
    typeof session.accessToken !== "string" ||
    session.accessToken.length === 0 ||
    session.nextAction !== undefined ||
    !session.user ||
    typeof session.user !== "object" ||
    Array.isArray(session.user)
  ) {
    throw new Error("Rotated owner login did not return a full session");
  }

  process.env.E2E_OWNER_PASSWORD = replacementPassword;

  const logoutResponse = await fetch(`${apiBaseUrl}/auth/logout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session.accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (logoutResponse.status !== 204) {
    throw new Error(
      `Rotated owner session cleanup failed with HTTP ${logoutResponse.status}`,
    );
  }
}
