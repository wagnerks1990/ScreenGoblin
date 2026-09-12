import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { MemoryStore } from "../src/store/memory.js";
import {
  issueMediaCapability,
  mediaStorageKey,
  S3MediaObjectStore,
  verifyMediaCapability,
} from "../src/media/delivery.js";

const secret = "media-delivery-secret-that-is-distinct-and-long";
const signingKey = Buffer.alloc(32, 7).toString("base64url");
const claims = (overrides: Record<string, unknown> = {}) => ({
  screenId: "screen-a",
  organizationId: "org-a",
  credentialKeyId: "key-a",
  assignmentId: "assignment-a",
  assignmentDigestSha256: "b".repeat(64),
  assetId: "asset-a",
  storageKey: mediaStorageKey("org-a", "asset-a", "a".repeat(64)),
  mimeType: "image/png",
  checksumSha256: "a".repeat(64),
  sizeBytes: 3,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...overrides,
});

describe("media delivery capabilities", () => {
  afterEach(() => vi.restoreAllMocks());

  it("binds every delivery security property and rejects expiry or tampering", () => {
    const input = claims();
    const capability = issueMediaCapability(input, secret);
    expect(verifyMediaCapability(capability, secret)).toMatchObject(input);
    expect(verifyMediaCapability(capability + "x", secret)).toBeNull();
    const expired = issueMediaCapability(
      claims({ expiresAt: new Date(Date.now() - 1).toISOString() }),
      secret,
    );
    expect(verifyMediaCapability(expired, secret)).toBeNull();
    const wrongKey = issueMediaCapability(
      claims({
        storageKey: "organizations/org-b/assets/asset-a/" + "a".repeat(64),
      }),
      secret,
    );
    expect(verifyMediaCapability(wrongKey, secret)).toBeNull();
    const wrongAssignmentDigest = issueMediaCapability(
      claims({ assignmentDigestSha256: "invalid" }),
      secret,
    );
    expect(verifyMediaCapability(wrongAssignmentDigest, secret)).toBeNull();
  });

  it("signs a GET only for the fixed configured S3 endpoint without redirects", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("abc", {
        status: 200,
        headers: { "Content-Length": "3" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const store = new S3MediaObjectStore(
      "http://minio:9000",
      "us-east-1",
      "private-bucket",
      "api-key",
      "api-signing-key-material",
    );
    const object = await store.getObject(
      "organizations/org-a/assets/asset-a/" + "a".repeat(64),
    );
    expect(object?.contentLength).toBe(3);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "http://minio:9000/private-bucket/organizations/org-a/assets/asset-a/" +
        "a".repeat(64),
    );
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    expect(init.headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("streams only for a live bound device and hides invalid capabilities", async () => {
    const store = new MemoryStore();
    store.screens.push({
      id: "screen-a",
      organizationId: "org-a",
      name: "Screen",
      location: "",
      status: "online",
      orientation: "landscape",
      resolution: "1920x1080",
      tags: [],
      installationId: "installation-a",
      deviceTokenHash: "present",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const authorizeMediaDelivery = vi
      .spyOn(store, "authorizeMediaDelivery")
      .mockResolvedValue(true);
    const mismatchedBody = Readable.from(Buffer.from("abc"));
    const getObject = vi
      .fn()
      .mockResolvedValueOnce({
        body: Readable.from(Buffer.from("abc")),
        contentLength: 3,
      })
      .mockResolvedValueOnce({
        body: mismatchedBody,
        contentLength: 3,
      });
    const app = await buildApp({
      store,
      jwtSecret: "jwt-secret-that-is-long-enough-for-the-test",
      manifestSigningPrivateKey: signingKey,
      pairingCodePepper: "pairing-pepper-that-is-long-enough-for-test",
      mediaDeliverySecret: secret,
      mediaObjectStore: { getObject },
      deviceAuthMode: "development-bearer",
    });
    const capability = issueMediaCapability(
      claims({ credentialKeyId: undefined }),
      secret,
    );
    const valid = await app.inject({
      url: `/api/v1/device/media/asset-a?capability=${encodeURIComponent(capability)}`,
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.body).toBe("abc");
    expect(valid.headers["content-type"]).toContain("image/png");
    expect(valid.headers["x-content-type-options"]).toBe("nosniff");
    expect(getObject).toHaveBeenCalledWith(claims().storageKey);
    expect(authorizeMediaDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-a",
        screenId: "screen-a",
        assignmentId: "assignment-a",
        assignmentDigestSha256: "b".repeat(64),
        assetId: "asset-a",
      }),
    );

    const wrongSize = issueMediaCapability(
      claims({ credentialKeyId: undefined, sizeBytes: 4 }),
      secret,
    );
    const mismatched = await app.inject({
      url: `/api/v1/device/media/asset-a?capability=${encodeURIComponent(wrongSize)}`,
    });
    expect(mismatched.statusCode).toBe(404);
    expect(mismatchedBody.destroyed).toBe(true);

    authorizeMediaDelivery.mockResolvedValueOnce(false);
    const withdrawn = await app.inject({
      url: `/api/v1/device/media/asset-a?capability=${encodeURIComponent(capability)}`,
    });
    expect(withdrawn.statusCode).toBe(404);
    expect(getObject).toHaveBeenCalledTimes(2);

    store.screens[0]!.credentialRevokedAt = new Date().toISOString();
    store.screens[0]!.deviceTokenHash = undefined;
    const revoked = await app.inject({
      url: `/api/v1/device/media/asset-a?capability=${encodeURIComponent(capability)}`,
    });
    expect(revoked.statusCode).toBe(404);

    const tampered = await app.inject({
      url: `/api/v1/device/media/asset-b?capability=${encodeURIComponent(capability)}`,
    });
    expect(tampered.statusCode).toBe(404);

    const crossScreen = issueMediaCapability(
      claims({ credentialKeyId: undefined, screenId: "screen-b" }),
      secret,
    );
    const crossScreenResponse = await app.inject({
      url: `/api/v1/device/media/asset-a?capability=${encodeURIComponent(crossScreen)}`,
    });
    expect(crossScreenResponse.statusCode).toBe(404);
    await app.close();
  });
});
