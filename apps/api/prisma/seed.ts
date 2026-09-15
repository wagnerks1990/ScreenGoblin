import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";
import {
  COMPATIBILITY_GRANT_SYSTEM_KEY,
  compatibilityGrantCapabilities,
  compatibilityGrantId,
} from "../src/authorization/compatibility.js";
const prisma = new PrismaClient();
const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value || /^replace-with-/i.test(value))
    throw new Error(`${name} is required and may not be a placeholder`);
  return value;
};
const email = required("SEED_ADMIN_EMAIL").toLowerCase();
const password = required("SEED_ADMIN_PASSWORD");
const organizationName = required("SEED_ORGANIZATION_NAME");
const organizationSlug = required("SEED_ORGANIZATION_SLUG");
const administratorName = required("SEED_ADMIN_NAME");
if (password.length < 16)
  throw new Error("SEED_ADMIN_PASSWORD must contain at least 16 characters");
const passwordHash = await hash(password, 12);
const organization = await prisma.organization.upsert({
  where: { slug: organizationSlug },
  update: {},
  create: { name: organizationName, slug: organizationSlug },
});
await prisma.location.upsert({
  where: {
    organizationId_name: {
      organizationId: organization.id,
      name: "Unassigned",
    },
  },
  update: {},
  create: { organizationId: organization.id, name: "Unassigned" },
});
const existing = await prisma.user.findUnique({
  where: { email },
  include: { memberships: true },
});
if (existing) {
  const alreadyOwner = existing.memberships.some(
    (membership) =>
      membership.organizationId === organization.id &&
      membership.role === "OWNER",
  );
  if (!alreadyOwner)
    throw new Error(
      "Bootstrap email already exists without the requested owner membership; refusing to change privileges",
    );
  console.log(
    `Bootstrap owner ${email} already exists; no credentials changed.`,
  );
} else {
  await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email,
        name: administratorName,
        passwordHash,
        memberships: {
          create: { organizationId: organization.id, role: "OWNER" },
        },
      },
      include: { memberships: true },
    });
    const membership = created.memberships.find(
      (candidate) => candidate.organizationId === organization.id,
    );
    if (!membership) throw new Error("Bootstrap membership was not created");
    await tx.accessGrant.createMany({
      data: compatibilityGrantCapabilities("OWNER").map((capability) => ({
        id: compatibilityGrantId(
          organization.id,
          membership.id,
          membership.authorizationEpoch,
          capability,
        ),
        organizationId: organization.id,
        subjectUserId: created.id,
        subjectMembershipId: membership.id,
        capability,
        scopeType: "ORGANIZATION",
        creatorKind: "SYSTEM",
        createdBySystemKey: COMPATIBILITY_GRANT_SYSTEM_KEY,
      })),
    });
  });
  console.log(`Created bootstrap organization owner ${email}.`);
}
await prisma.$disconnect();
