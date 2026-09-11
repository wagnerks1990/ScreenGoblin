import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";
const prisma = new PrismaClient();
const email = process.env.SEED_ADMIN_EMAIL ?? "admin@screengoblin.local";
const password = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe-Now-123!";
const passwordHash = await hash(password, 12);
const organization = await prisma.organization.upsert({
  where: { slug: "demo-school" },
  update: {},
  create: { name: "ScreenGoblin Demo School", slug: "demo-school" },
});
const user = await prisma.user.upsert({
  where: { email },
  // Re-running deployment must never reset an existing administrator password.
  update: { name: "Demo Administrator" },
  create: { email, name: "Demo Administrator", passwordHash },
});
await prisma.membership.upsert({
  where: {
    organizationId_userId: { organizationId: organization.id, userId: user.id },
  },
  update: { role: "OWNER" },
  create: { organizationId: organization.id, userId: user.id, role: "OWNER" },
});
const screen = await prisma.screen.upsert({
  where: { installationId: "demo-lobby-player" },
  update: {},
  create: {
    organizationId: organization.id,
    name: "Main Lobby",
    location: "High School > Main Lobby",
    tags: ["lobby", "student-facing"],
    installationId: "demo-lobby-player",
  },
});
const asset = await prisma.mediaAsset.upsert({
  where: { id: "demo-welcome-asset" },
  update: {},
  create: {
    id: "demo-welcome-asset",
    organizationId: organization.id,
    name: "Welcome to ScreenGoblin",
    kind: "IMAGE",
    mimeType: "image/png",
    url: "https://example.invalid/demo/welcome.png",
    checksumSha256:
      "0000000000000000000000000000000000000000000000000000000000000000",
    sizeBytes: 0,
  },
});
const playlist = await prisma.playlist.upsert({
  where: {
    organizationId_name: {
      organizationId: organization.id,
      name: "Welcome Rotation",
    },
  },
  update: {},
  create: {
    organizationId: organization.id,
    name: "Welcome Rotation",
    description: "Seeded prototype playlist",
    items: { create: { assetId: asset.id, position: 0, durationSeconds: 15 } },
  },
});
const existing = await prisma.schedule.findFirst({
  where: { organizationId: organization.id, name: "Always On Demo" },
});
if (!existing)
  await prisma.schedule.create({
    data: {
      organizationId: organization.id,
      playlistId: playlist.id,
      name: "Always On Demo",
      startsAt: new Date("2020-01-01T00:00:00Z"),
      targets: { create: { screenId: screen.id } },
    },
  });
console.log(`Ensured bootstrap organization and administrator ${email}.`);
await prisma.$disconnect();
