/// <reference types="node" />

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const testShell = [
  "/",
  "/manifest.webmanifest",
  "/brand/logo.png",
  "/brand/mascot.png",
  "/assets/app-12345678.js",
];
const workerSource = readFileSync("public/sw.js", "utf8")
  .replace('"__SCREEN_GOBLIN_SHELL_CACHE__"', '"screengoblin-shell-testbuild"')
  .replace('["__SCREEN_GOBLIN_SHELL_ASSETS__"]', JSON.stringify(testShell));

type WorkerEvent = {
  request?: Request;
  waitUntil?: (promise: Promise<unknown>) => void;
  respondWith?: (promise: Promise<Response>) => void;
};

function workerHarness(options: {
  fetch?: (request: Request) => Promise<Response>;
  cacheNames?: string[];
}) {
  const handlers = new Map<string, (event: WorkerEvent) => void>();
  const put = vi.fn().mockResolvedValue(undefined);
  const match = vi.fn().mockResolvedValue(undefined);
  const cache = { put, match };
  const deleteCache = vi.fn().mockResolvedValue(true);
  const claim = vi.fn().mockResolvedValue(undefined);
  const skipWaiting = vi.fn().mockResolvedValue(undefined);
  const cacheStorage = {
    open: vi.fn().mockResolvedValue(cache),
    keys: vi.fn().mockResolvedValue(options.cacheNames ?? []),
    delete: deleteCache,
  };
  const worker = {
    location: { origin: "https://player.example.test" },
    clients: { claim },
    skipWaiting,
    addEventListener: (name: string, handler: (event: WorkerEvent) => void) =>
      handlers.set(name, handler),
  };
  const fetchMock = vi.fn(
    options.fetch ??
      (async (request: Request) => {
        const pathname = new URL(request.url).pathname;
        const contentType =
          pathname === "/"
            ? "text/html"
            : pathname === "/manifest.webmanifest"
              ? "application/manifest+json"
              : pathname.endsWith(".png")
                ? "image/png"
                : pathname.endsWith(".css")
                  ? "text/css"
                  : "application/javascript";
        const response = new Response("network", {
          status: 200,
          headers: { "Content-Type": contentType },
        });
        Object.defineProperties(response, {
          type: { value: "basic" },
          url: { value: request.url },
        });
        return response;
      }),
  );
  const execute = new Function(
    "self",
    "caches",
    "fetch",
    "URL",
    "Request",
    "Response",
    workerSource,
  );
  execute(worker, cacheStorage, fetchMock, URL, Request, Response);

  const lifecycle = (name: "install" | "activate") => {
    let lifetime: Promise<unknown> | undefined;
    handlers.get(name)?.({
      waitUntil: (promise) => {
        lifetime = promise;
      },
    });
    return lifetime;
  };
  const request = (value: Request) => {
    let response: Promise<Response> | undefined;
    handlers.get("fetch")?.({
      request: value,
      respondWith: (promise) => {
        response = promise;
      },
    });
    return response;
  };

  return {
    put,
    match,
    deleteCache,
    claim,
    skipWaiting,
    cacheStorage,
    fetchMock,
    lifecycle,
    request,
  };
}

describe("service-worker cache isolation", () => {
  it("pre-caches only the explicit shell allowlist", async () => {
    const worker = workerHarness({});
    await worker.lifecycle("install");

    expect(worker.cacheStorage.open).toHaveBeenCalledWith(
      "screengoblin-shell-testbuild",
    );
    expect(worker.fetchMock).toHaveBeenCalledTimes(testShell.length);
    expect(worker.put).toHaveBeenCalledTimes(testShell.length);
    expect(
      worker.put.mock.calls.map(([request]) => new URL(request.url).pathname),
    ).toEqual(testShell);
    expect(worker.skipWaiting).toHaveBeenCalledOnce();
  });

  it("never intercepts API, media, managed assets, queries, or cross-origin requests", () => {
    const worker = workerHarness({});
    const excluded = [
      new Request("https://player.example.test/api/v1/device/manifest"),
      new Request("https://player.example.test/media/welcome.png"),
      new Request("https://player.example.test/__sg_asset__/asset/hash"),
      new Request("https://player.example.test/?tenant=one"),
      new Request("https://cdn.example.test/assets/app-12345678.js"),
      new Request("https://player.example.test/", { method: "POST" }),
    ];

    for (const request of excluded)
      expect(worker.request(request)).toBeUndefined();
    expect(worker.fetchMock).not.toHaveBeenCalled();
    expect(worker.cacheStorage.open).not.toHaveBeenCalled();
  });

  it("serves installed shell assets without mutating their generation", async () => {
    const worker = workerHarness({});
    const cached = new Response("installed JavaScript", { status: 200 });
    worker.match.mockResolvedValueOnce(cached);

    await expect(
      worker.request(
        new Request("https://player.example.test/assets/app-12345678.js"),
      ),
    ).resolves.toBe(cached);
    expect(worker.fetchMock).not.toHaveBeenCalled();
    expect(worker.put).not.toHaveBeenCalled();
  });

  it("uses an uncached network response without adding it to the generation", async () => {
    const worker = workerHarness({});
    await expect(
      worker.request(
        new Request("https://player.example.test/assets/app-12345678.js"),
      ),
    ).resolves.toHaveProperty("status", 200);
    expect(worker.fetchMock).toHaveBeenCalledOnce();
    expect(worker.put).not.toHaveBeenCalled();
  });

  it("rejects and removes an install generation with an invalid member", async () => {
    const worker = workerHarness({
      fetch: async (request) => {
        const response = new Response("<html>not JavaScript</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
        Object.defineProperties(response, {
          type: { value: "basic" },
          url: { value: request.url },
        });
        return response;
      },
    });

    await expect(worker.lifecycle("install")).rejects.toThrow(
      "Invalid shell response",
    );
    expect(worker.deleteCache).toHaveBeenCalledWith(
      "screengoblin-shell-testbuild",
    );
    expect(worker.put).not.toHaveBeenCalled();
    expect(worker.skipWaiting).not.toHaveBeenCalled();
  });

  it("serves a cached shell response and then the offline root fallback", async () => {
    const worker = workerHarness({
      fetch: async () => {
        throw new TypeError("offline");
      },
    });
    const cached = new Response("cached asset", { status: 200 });
    worker.match.mockResolvedValueOnce(cached);
    await expect(
      worker.request(new Request("https://player.example.test/brand/logo.png")),
    ).resolves.toBe(cached);

    const root = new Response("offline root", { status: 200 });
    worker.match.mockResolvedValueOnce(undefined).mockResolvedValueOnce(root);
    const navigation = new Request("https://player.example.test/");
    Object.defineProperty(navigation, "mode", { value: "navigate" });
    await expect(worker.request(navigation)).resolves.toBe(root);
    expect(worker.match).toHaveBeenLastCalledWith("/");
  });

  it("deletes only prior shell generations before claiming clients", async () => {
    const worker = workerHarness({
      cacheNames: [
        "screengoblin-shell-v1",
        "screengoblin-shell-testbuild",
        "screengoblin-content-v1",
        "unrelated-cache",
      ],
    });
    await worker.lifecycle("activate");

    expect(worker.deleteCache).toHaveBeenCalledOnce();
    expect(worker.deleteCache).toHaveBeenCalledWith("screengoblin-shell-v1");
    expect(worker.claim).toHaveBeenCalledOnce();
    expect(worker.deleteCache.mock.invocationCallOrder[0]).toBeLessThan(
      worker.claim.mock.invocationCallOrder[0]!,
    );
  });
});
