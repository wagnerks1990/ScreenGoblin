import { createServer } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { MemoryStore } from "../src/store/memory.js";
import {
  enforceExactByteLength,
  issueMediaCapability,
  mediaStorageKey,
  S3MediaObjectStore,
  verifyMediaCapability,
} from "../src/media/delivery.js";

const readBody = async (body: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const expectHttpBodyFailure = async (
  url: string,
  expectedPrefix: string,
): Promise<void> => {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response did not contain a body");
  const chunks: Buffer[] = [];
  await expect(
    (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return Buffer.concat(chunks).toString("utf8");
        chunks.push(Buffer.from(value));
      }
    })(),
  ).rejects.toThrow();
  expect(Buffer.concat(chunks).toString("utf8")).toBe(expectedPrefix);
};

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
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

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
    expect(init.headers["Accept-Encoding"]).toBe("identity");
    expect(init.headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("rejects an encoded S3 body even when its compressed length is declared", async () => {
    const expanded = Buffer.alloc(1024 * 1024, 65);
    const compressed = gzipSync(expanded);
    let acceptEncoding: string | undefined;
    const server = createServer((request, response) => {
      acceptEncoding = request.headers["accept-encoding"];
      response.writeHead(200, {
        "Content-Encoding": "gzip",
        "Content-Length": String(compressed.byteLength),
      });
      response.end(compressed);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Test server did not bind a TCP port");
      const store = new S3MediaObjectStore(
        `http://127.0.0.1:${address.port}`,
        "us-east-1",
        "private-bucket",
        "api-key",
        "api-signing-key-material",
      );
      await expect(
        store.getObject("organizations/org-a/assets/asset-a/" + "a".repeat(64)),
      ).rejects.toThrow();
      expect(acceptEncoding).toBe("identity");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("rejects a non-identity Content-Encoding from the object store", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("abc", {
          status: 200,
          headers: { "Content-Encoding": "gzip", "Content-Length": "3" },
        }),
      ),
    );
    const store = new S3MediaObjectStore(
      "http://minio:9000",
      "us-east-1",
      "private-bucket",
      "api-key",
      "api-signing-key-material",
    );
    await expect(
      store.getObject("organizations/org-a/assets/asset-a/" + "a".repeat(64)),
    ).rejects.toThrow("Private media object encoding is not allowed");
  });

  it.each([undefined, "03", "3.0", "9007199254740992"])(
    "rejects a missing or non-canonical object length %s",
    async (contentLength) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response("abc", {
            status: 200,
            ...(contentLength === undefined
              ? {}
              : { headers: { "Content-Length": contentLength } }),
          }),
        ),
      );
      const store = new S3MediaObjectStore(
        "http://minio:9000",
        "us-east-1",
        "private-bucket",
        "api-key",
        "api-signing-key-material",
      );
      await expect(
        store.getObject("organizations/org-a/assets/asset-a/" + "a".repeat(64)),
      ).rejects.toThrow("Private media object length is invalid");
    },
  );

  it("allows an exact body and rejects overlong or short bodies", async () => {
    await expect(
      readBody(enforceExactByteLength(Readable.from([Buffer.from("abc")]), 3)),
    ).resolves.toEqual(Buffer.from("abc"));

    const overlong = Readable.from([Buffer.from("abc"), Buffer.from("d")]);
    await expect(readBody(enforceExactByteLength(overlong, 3))).rejects.toThrow(
      "exceeded its declared length",
    );
    expect(overlong.destroyed).toBe(true);

    const short = Readable.from([Buffer.from("ab")]);
    await expect(readBody(enforceExactByteLength(short, 3))).rejects.toThrow(
      "ended before its declared length",
    );
  });

  it.each([
    {
      name: "an extra chunk after the signed length",
      finish(body: PassThrough) {
        body.write("abc");
        setImmediate(() => body.end("d"));
      },
    },
    {
      name: "an upstream error after the signed length",
      finish(body: PassThrough) {
        body.write("abc");
        setImmediate(() => body.destroy(new Error("upstream failed")));
      },
    },
  ])("does not complete an HTTP response for $name", async ({ finish }) => {
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
    vi.spyOn(store, "authorizeMediaDelivery").mockResolvedValue(true);
    const body = new PassThrough();
    const getObject = vi.fn().mockResolvedValue({ body, contentLength: 3 });
    const app = await buildApp({
      store,
      jwtSecret: "jwt-secret-that-is-long-enough-for-the-test",
      manifestSigningPrivateKey: signingKey,
      pairingCodePepper: "pairing-pepper-that-is-long-enough-for-test",
      mediaDeliverySecret: secret,
      mediaObjectStore: { getObject },
      deviceAuthMode: "development-bearer",
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const capability = issueMediaCapability(
        claims({ credentialKeyId: undefined }),
        secret,
      );
      const request = expectHttpBodyFailure(
        `${app.listeningOrigin}/api/v1/device/media/asset-a?capability=${encodeURIComponent(capability)}`,
        "ab",
      );
      await vi.waitFor(() => expect(getObject).toHaveBeenCalledOnce());
      finish(body);
      await request;
    } finally {
      await app.close();
    }
  });

  it("completes an HTTP response only after an exact clean upstream EOF", async () => {
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
    vi.spyOn(store, "authorizeMediaDelivery").mockResolvedValue(true);
    const app = await buildApp({
      store,
      jwtSecret: "jwt-secret-that-is-long-enough-for-the-test",
      manifestSigningPrivateKey: signingKey,
      pairingCodePepper: "pairing-pepper-that-is-long-enough-for-test",
      mediaDeliverySecret: secret,
      mediaObjectStore: {
        getObject: vi.fn().mockResolvedValue({
          body: Readable.from([Buffer.from("abc")]),
          contentLength: 3,
        }),
      },
      deviceAuthMode: "development-bearer",
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const capability = issueMediaCapability(
        claims({ credentialKeyId: undefined }),
        secret,
      );
      const response = await fetch(
        `${app.listeningOrigin}/api/v1/device/media/asset-a?capability=${encodeURIComponent(capability)}`,
      );
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("abc");
    } finally {
      await app.close();
    }
  });

  it("aborts the upstream body when the delivery consumer disconnects", async () => {
    const upstream = new Readable({ read() {} });
    const bounded = enforceExactByteLength(upstream, 3);
    bounded.on("error", () => undefined);
    bounded.destroy(new Error("consumer disconnected"));
    await new Promise<void>((resolve) => bounded.on("close", resolve));
    expect(upstream.destroyed).toBe(true);
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
