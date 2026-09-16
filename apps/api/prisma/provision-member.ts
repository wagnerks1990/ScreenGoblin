import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import {
  provisionMember,
  type MemberProvisionInput,
} from "../src/identity/member-provisioning.js";

const required = (name: string) => {
  const value = process.env[name];
  if (value === undefined || value.length === 0)
    throw new Error(`${name} is required`);
  return value;
};

const input: MemberProvisionInput = {
  acknowledgement: required("MEMBER_PROVISION_ACKNOWLEDGEMENT"),
  organizationSlug: required("MEMBER_PROVISION_ORGANIZATION_SLUG"),
  email: required("MEMBER_PROVISION_EMAIL"),
  name: required("MEMBER_PROVISION_NAME"),
  role: required("MEMBER_PROVISION_ROLE"),
  temporaryPassword: required("MEMBER_PROVISION_TEMPORARY_PASSWORD"),
  reason: required("MEMBER_PROVISION_REASON"),
};

const prisma = new PrismaClient();

try {
  const result = await provisionMember(prisma, input);
  console.log(
    `${result.status}: member ${result.normalizedEmail} (user ${result.userId}, membership ${result.membershipId}) has role ${result.role} in organization ${result.organizationId}; the temporary credential must be changed before ${result.changeBefore.toISOString()}.`,
  );
} finally {
  await prisma.$disconnect();
}
