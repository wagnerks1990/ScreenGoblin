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

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error("Invalid base64url value");
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

export async function verifyManifestSignature(
  payload: unknown,
  signature: string,
  publicKey: string,
): Promise<boolean> {
  try {
    const rawKey = decodeBase64Url(publicKey);
    const rawSignature = decodeBase64Url(signature);
    if (rawKey.byteLength !== 32 || rawSignature.byteLength !== 64)
      return false;
    const key = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(rawKey).buffer,
      "Ed25519",
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "Ed25519",
      key,
      new Uint8Array(rawSignature).buffer,
      new TextEncoder().encode(JSON.stringify(payload)),
    );
  } catch {
    return false;
  }
}
