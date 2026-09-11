import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";
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
  await prisma.user.create({
    data: {
      email,
      name: administratorName,
      passwordHash,
      memberships: {
        create: { organizationId: organization.id, role: "OWNER" },
      },
    },
  });
  console.log(`Created bootstrap organization owner ${email}.`);
}
await prisma.$disconnect();
