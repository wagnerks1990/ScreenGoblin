const SHA256_HEX = /^[a-f\d]{64}$/i;

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifySha256(
  data: ArrayBuffer,
  expected: string,
): Promise<boolean> {
  if (!SHA256_HEX.test(expected)) return false;
  return (await sha256Hex(data)).toLowerCase() === expected.toLowerCase();
}
