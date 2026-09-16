const MINIMUM_SEED_PASSWORD_CHARACTERS = 16;
const MAXIMUM_BCRYPT_PASSWORD_BYTES = 72;

export const validateSeedPassword = (password: string): void => {
  if ([...password].length < MINIMUM_SEED_PASSWORD_CHARACTERS)
    throw new Error("SEED_ADMIN_PASSWORD must contain at least 16 characters");
  if (Buffer.byteLength(password, "utf8") > MAXIMUM_BCRYPT_PASSWORD_BYTES)
    throw new Error("SEED_ADMIN_PASSWORD must contain at most 72 UTF-8 bytes");
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
