import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";

const root = process.cwd();
const ignoredDirectories = new Set([".git", "build", "dist", "node_modules"]);
const files = [];

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else files.push(path);
  }
}

walk(root);

const digestPattern = /@sha256:[0-9a-f]{64}$/;
const violations = [];

for (const path of files) {
  const name = relative(root, path).replaceAll("\\", "/");
  const basename = name.slice(name.lastIndexOf("/") + 1);
  const dockerfile = /(^|\.)(?:Dockerfile|Containerfile)(\.|$)/.test(basename);
  const imageConfig =
    /^(?:docker-)?compose(?:\.[^.]+)*\.ya?ml$/.test(basename) ||
    name.startsWith(".github/workflows/");
  const deployScript = name.startsWith("deploy/scripts/");
  if (!dockerfile && !imageConfig && !deployScript) continue;
  const text = readFileSync(path, "utf8");

  if (dockerfile) {
    const stages = new Set();
    for (const [index, line] of text.split("\n").entries()) {
      const from = line.match(
        /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i,
      );
      if (!from) continue;
      const image = from[1];
      if (!stages.has(image) && !digestPattern.test(image)) {
        violations.push(`${name}:${index + 1}: mutable FROM ${image}`);
      }
      if (from[2]) stages.add(from[2]);
    }
    const joinedInstructions = text.replaceAll(/\\\r?\n/g, " ");
    if (
      /\b(?:apt(?:-get)?|apk)\b[^;&|\n]*\b(?:dist-upgrade|full-upgrade|upgrade)\b/.test(
        joinedInstructions,
      )
    ) {
      violations.push(`${name}: mutable package upgrade`);
    }
  }

  if (imageConfig) {
    for (const [index, line] of text.split("\n").entries()) {
      const images = [];
      const blockImage = line.match(
        /^\s*["']?image["']?\s*:\s*["']?([^,\s}"']+)/,
      )?.[1];
      if (blockImage) images.push(blockImage);
      for (const match of line.matchAll(
        /[{,]\s*["']?image["']?\s*:\s*["']?([^,\s}"']+)/g,
      )) {
        images.push(match[1]);
      }
      const container = line.match(
        /^\s*["']?container["']?\s*:\s*["']?([^\s"']+)/,
      )?.[1];
      if (container && container !== "{") images.push(container);
      const dockerAction = line.match(
        /\buses:\s*["']?docker:\/\/([^\s"']+)/,
      )?.[1];
      if (dockerAction) images.push(dockerAction);
      for (const image of images) {
        if (digestPattern.test(image)) continue;
        violations.push(`${name}:${index + 1}: mutable image ${image}`);
      }
    }
  }

  if (deployScript) {
    for (const match of text.matchAll(/\$\{[A-Z0-9_]*IMAGE:-([^}]+)\}/g)) {
      if (!digestPattern.test(match[1])) {
        violations.push(`${name}: mutable fixture image ${match[1]}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("Container build, service, and fixture inputs are digest-pinned.");
