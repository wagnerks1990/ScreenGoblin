export const MINIMUM_TEMPORARY_PASSWORD_CODE_POINTS = 16;
export const MAXIMUM_BCRYPT_PASSWORD_BYTES = 72;

export const validateTemporaryPassword = (
  password: string,
  fieldName: string,
): void => {
  if ([...password].length < MINIMUM_TEMPORARY_PASSWORD_CODE_POINTS)
    throw new Error(`${fieldName} must contain at least 16 characters`);
  if (Buffer.byteLength(password, "utf8") > MAXIMUM_BCRYPT_PASSWORD_BYTES)
    throw new Error(`${fieldName} must contain at most 72 UTF-8 bytes`);
};
