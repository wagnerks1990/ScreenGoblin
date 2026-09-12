import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist");
const templatePath = resolve(root, "public/sw.js");
const staticShell = [
  "/",
  "/manifest.webmanifest",
  "/brand/favicon-32x32.png",
  "/brand/icon-192.png",
  "/brand/icon-512.png",
  "/brand/logo.png",
  "/brand/mascot.png",
];

export function shellAssetsFromHtml(html) {
  const generated = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(
    (match) => match[1],
  );
  for (const path of generated) {
    if (
      !/^\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:css|js|png|svg|webp|woff2?)$/i.test(
        path,
      )
    )
      throw new Error(`Unsafe generated shell asset path: ${path}`);
  }
  return [...new Set([...staticShell, ...generated])].sort();
}

function outputPath(urlPath) {
  return resolve(output, urlPath === "/" ? "index.html" : urlPath.slice(1));
}

export function shellCacheName(template, entries) {
  const fingerprint = createHash("sha256");
  const add = (value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    fingerprint.update(String(bytes.length));
    fingerprint.update("\0");
    fingerprint.update(bytes);
  };

  add("ScreenGoblin shell generation v1");
  add(template);
  for (const { path, content } of entries) {
    add(path);
    add(content);
  }
  return `screengoblin-shell-${fingerprint.digest("hex").slice(0, 16)}`;
}

async function build() {
  const html = await readFile(resolve(output, "index.html"), "utf8");
  const shell = shellAssetsFromHtml(html);
  const template = await readFile(templatePath, "utf8");
  const entries = await Promise.all(
    shell.map(async (path) => ({
      path,
      content: await readFile(outputPath(path)),
    })),
  );
  const cache = shellCacheName(template, entries);
  const worker = template
    .replace('"__SCREEN_GOBLIN_SHELL_CACHE__"', JSON.stringify(cache))
    .replace(
      '["__SCREEN_GOBLIN_SHELL_ASSETS__"]',
      JSON.stringify(shell, null, 2),
    );
  if (worker.includes("__SCREEN_GOBLIN_"))
    throw new Error(
      "Service-worker build placeholders were not fully replaced",
    );
  await writeFile(resolve(output, "sw.js"), worker);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await build();
