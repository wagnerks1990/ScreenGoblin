import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { recoverBootstrapPassword } from "../src/recovery/bootstrap-password.js";

const required = (name: string) => {
  const value = process.env[name];
  if (value === undefined || value.length === 0)
    throw new Error(`${name} is required`);
  return value;
};

const prisma = new PrismaClient();

try {
  const result = await recoverBootstrapPassword(prisma, {
    acknowledgement: required("BOOTSTRAP_RECOVERY_ACKNOWLEDGEMENT"),
    email: required("BOOTSTRAP_RECOVERY_EMAIL"),
    temporaryPassword: required("BOOTSTRAP_RECOVERY_TEMPORARY_PASSWORD"),
  });
  console.log(
    `Issued a restricted bootstrap password for ${result.normalizedEmail} across ${result.affectedOrganizationCount} membership(s); it must be changed before ${result.changeBefore.toISOString()}.`,
  );
} finally {
  await prisma.$disconnect();
}
