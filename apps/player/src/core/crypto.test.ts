import { describe, expect, it } from "vitest";
import { sha256Hex, verifySha256 } from "./crypto";

describe("SHA-256 verification", () => {
  it("matches a known digest", async () => {
    const data = new TextEncoder().encode("ScreenGoblin");
    expect(await sha256Hex(data.buffer)).toBe(
      "6974b6bf4bf24c1c15192db27dcc34f274b2c91d984d8b8ef1b64deecd203a55",
    );
    expect(
      await verifySha256(
        data.buffer,
        "6974b6bf4bf24c1c15192db27dcc34f274b2c91d984d8b8ef1b64deecd203a55",
      ),
    ).toBe(true);
  });

  it("rejects malformed and mismatched digests", async () => {
    const data = new TextEncoder().encode("changed");
    expect(await verifySha256(data.buffer, "not-a-hash")).toBe(false);
    expect(await verifySha256(data.buffer, "0".repeat(64))).toBe(false);
  });
});
