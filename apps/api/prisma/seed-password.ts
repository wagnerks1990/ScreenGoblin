import { validateTemporaryPassword } from "../src/identity/temporary-password-policy.js";

type SeedEnvironment = Record<string, string | undefined>;

const requiredSeedValue = (environment: SeedEnvironment, name: string) => {
  const value = environment[name]?.trim();
  if (!value || /^replace-with-/i.test(value))
    throw new Error(`${name} is required and may not be a placeholder`);
  return value;
};

export const validateSeedPassword = (password: string): void => {
  validateTemporaryPassword(password, "SEED_ADMIN_PASSWORD");
};

export const readSeedEnvironment = (
  environment: SeedEnvironment = process.env,
) => {
  const email = requiredSeedValue(environment, "SEED_ADMIN_EMAIL");
  const password = requiredSeedValue(environment, "SEED_ADMIN_PASSWORD");
  validateSeedPassword(password);
  return {
    email: email.toLowerCase(),
    password,
    administratorName: requiredSeedValue(environment, "SEED_ADMIN_NAME"),
    organizationName: requiredSeedValue(environment, "SEED_ORGANIZATION_NAME"),
    organizationSlug: requiredSeedValue(environment, "SEED_ORGANIZATION_SLUG"),
  };
};

export const decideExistingBootstrapContainment = (input: {
  bootstrapPasswordExpiresAt: Date | null;
  databaseNow: Date;
  hasContainmentAudit: boolean;
  seedPasswordMatches: boolean;
}): "MARK" | "UNCHANGED" => {
  if (
    input.hasContainmentAudit ||
    (input.bootstrapPasswordExpiresAt !== null &&
      input.bootstrapPasswordExpiresAt > input.databaseNow)
  )
    return "UNCHANGED";
  if (!input.seedPasswordMatches)
    throw new Error(
      "Existing bootstrap owner is not containment-proven and the supplied seed password does not match; refusing to continue",
    );
  return "MARK";
};
