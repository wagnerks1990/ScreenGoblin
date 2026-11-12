import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { changeOwnerLoginEmail } from "../src/identity/change-login-email.js";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const prisma = new PrismaClient();
try {
  const result = await changeOwnerLoginEmail(prisma, {
    acknowledgement: required("LOGIN_EMAIL_CHANGE_ACKNOWLEDGEMENT"),
    currentEmail: required("LOGIN_EMAIL_CHANGE_CURRENT_EMAIL"),
    newEmail: required("LOGIN_EMAIL_CHANGE_NEW_EMAIL"),
    reason: required("LOGIN_EMAIL_CHANGE_REASON"),
  });
  console.log(
    `Changed owner login email across ${result.affectedOrganizationCount} membership(s); all sessions and pending enrollment authority revoked.`,
  );
} finally {
  await prisma.$disconnect();
}
