import { createHash, createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { FullConfig } from "@playwright/test";

const apiBaseUrl =
  process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3000/api/v1";
const loginBudgetWindowMs = 60_000;
const loginBudgetWindowSafetyMs = 500;

type E2ePrismaClient = {
  organization: {
    findUnique(input: {
      where: { slug: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
  mediaAsset: {
    create(input: {
      data: {
        id: string;
        organizationId: string;
        name: string;
        kind: "IMAGE";
        mimeType: "image/png";
        url: string;
        storageKey: string;
        checksumSha256: string;
        sizeBytes: bigint;
      };
    }): Promise<unknown>;
  };
  $disconnect(): Promise<void>;
};

const apiRequire = createRequire(resolve("apps/api/package.json"));
const { PrismaClient } = apiRequire("@prisma/client") as {
  PrismaClient: new () => E2ePrismaClient;
};

async function provisionE2eMediaAsset() {
  if (process.env.NODE_ENV !== "test")
    throw new Error("The browser media fixture is restricted to NODE_ENV=test");
  const organizationSlug = process.env.SEED_ORGANIZATION_SLUG?.trim();
  const configuredOrigin =
    process.env.MEDIA_ALLOWED_ORIGINS?.split(",")[0]?.trim();
  if (!organizationSlug || !configuredOrigin)
    throw new Error(
      "SEED_ORGANIZATION_SLUG and MEDIA_ALLOWED_ORIGINS are required for the browser media fixture",
    );
  const allowedOrigin = new URL(configuredOrigin).origin;
  if (allowedOrigin !== configuredOrigin)
    throw new Error(
      "The first MEDIA_ALLOWED_ORIGINS entry must be a canonical origin",
    );

  const prisma = new PrismaClient();
  try {
    const organization = await prisma.organization.findUnique({
      where: { slug: organizationSlug },
      select: { id: true },
    });
    if (!organization)
      throw new Error(`E2E organization ${organizationSlug} was not seeded`);
    const id = randomUUID();
    const checksumSha256 = createHash("sha256")
      .update(`screengoblin-maker-checker-e2e\0${id}`)
      .digest("hex");
    await prisma.mediaAsset.create({
      data: {
        id,
        organizationId: organization.id,
        name: `Maker-checker fixture ${id}`,
        kind: "IMAGE",
        mimeType: "image/png",
        url: `${allowedOrigin}/e2e/maker-checker-${id}.png`,
        storageKey: `organizations/${organization.id}/assets/${id}/${checksumSha256}`,
        checksumSha256,
        sizeBytes: 68n,
      },
    });
    process.env.E2E_MAKER_CHECKER_ASSET_ID = id;
  } finally {
    await prisma.$disconnect();
  }
}

async function waitForFreshLoginBudgetWindow(firstLoginStartedAt: number) {
  const remainingMs =
    firstLoginStartedAt +
    loginBudgetWindowMs +
    loginBudgetWindowSafetyMs -
    Date.now();
  if (remainingMs > 0)
    await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
}

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

type BootstrapPrincipal = {
  email: string;
  temporaryPassword: string;
  replacementPasswordEnvironmentVariable: string;
};

function requiredProvisionedPrincipal(
  prefix: "E2E_PUBLISHER" | "E2E_ADMIN",
): BootstrapPrincipal {
  const email = process.env[`${prefix}_EMAIL`]?.trim();
  const temporaryPassword = process.env[`${prefix}_TEMPORARY_PASSWORD`];
  if (!email || !temporaryPassword) {
    throw new Error(
      `${prefix}_EMAIL and ${prefix}_TEMPORARY_PASSWORD are required for Console E2E tests`,
    );
  }
  return {
    email,
    temporaryPassword,
    replacementPasswordEnvironmentVariable: `${prefix}_PASSWORD`,
  };
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

async function rotateBootstrapPrincipal(principal: BootstrapPrincipal) {
  const replacementPassword = createHmac("sha256", principal.temporaryPassword)
    .update(`screengoblin-console-e2e\0${principal.email}\0${apiBaseUrl}`)
    .digest("base64url");
  const loginResponse = await fetch(`${apiBaseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: principal.email,
      password: principal.temporaryPassword,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!loginResponse.ok && loginResponse.status !== 401) {
    throw new Error(
      `Bootstrap login for ${principal.email} failed with HTTP ${loginResponse.status}`,
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
        `Provisioned principal ${principal.email} did not require bootstrap password rotation`,
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
          currentPassword: principal.temporaryPassword,
          newPassword: replacementPassword,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (rotationResponse.status !== 204) {
      throw new Error(
        `Bootstrap password rotation for ${principal.email} failed with HTTP ${rotationResponse.status}`,
      );
    }
  }

  const verificationResponse = await fetch(`${apiBaseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: principal.email,
      password: replacementPassword,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!verificationResponse.ok) {
    throw new Error(
      `Rotated login for ${principal.email} failed with HTTP ${verificationResponse.status}`,
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
    throw new Error(
      `Rotated login for ${principal.email} did not return a full session`,
    );
  }
  process.env[principal.replacementPasswordEnvironmentVariable] =
    replacementPassword;
  const logoutResponse = await fetch(`${apiBaseUrl}/auth/logout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session.accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (logoutResponse.status !== 204) {
    throw new Error(
      `Rotated session cleanup for ${principal.email} failed with HTTP ${logoutResponse.status}`,
    );
  }
}

export default async function globalSetup(_config: FullConfig) {
  await provisionE2eMediaAsset();
  const owner = requiredOwnerCredentials();
  const replacementPassword = createHmac("sha256", owner.password)
    .update(`screengoblin-console-e2e\0${owner.email}\0${apiBaseUrl}`)
    .digest("base64url");
  const firstLoginStartedAt = Date.now();
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

  await rotateBootstrapPrincipal(requiredProvisionedPrincipal("E2E_PUBLISHER"));
  await rotateBootstrapPrincipal(requiredProvisionedPrincipal("E2E_ADMIN"));
  await waitForFreshLoginBudgetWindow(firstLoginStartedAt);
}
