import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import process from "node:process";

const ANDROID = "android:";
const PACKAGE = "com.screengoblin.player";
const EXPECTED_PERMISSIONS = [
  "android.permission.INTERNET",
  "android.permission.RECEIVE_BOOT_COMPLETED",
];
const EXPECTED_FEATURES = [
  "android.hardware.touchscreen",
  "android.software.leanback",
];

const decodeXml = (value) =>
  value.replaceAll(/&(?:amp|lt|gt|quot|apos);/g, (entity) => {
    switch (entity) {
      case "&amp;":
        return "&";
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&quot;":
        return '"';
      case "&apos;":
        return "'";
      default:
        throw new Error(`unsupported XML entity ${entity}`);
    }
  });

function parseAttributes(source) {
  const attributes = new Map();
  let offset = 0;
  while (offset < source.length) {
    const whitespace = source.slice(offset).match(/^\s+/)?.[0] ?? "";
    offset += whitespace.length;
    if (offset === source.length) break;
    const attribute = source
      .slice(offset)
      .match(/^([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(["'])(.*?)\2/s);
    if (!attribute) throw new Error("malformed XML attribute");
    if (attributes.has(attribute[1]))
      throw new Error(`duplicate XML attribute ${attribute[1]}`);
    attributes.set(attribute[1], decodeXml(attribute[3]));
    offset += attribute[0].length;
  }
  return attributes;
}

function parseXml(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("DTD and entity declarations are forbidden");
  const cleaned = xml
    .replaceAll(/<!--[^]*?-->/g, "")
    .replace(/^\s*<\?xml[^?]*\?>/, "");
  const document = { name: "#document", attributes: new Map(), children: [] };
  const stack = [document];
  let cursor = 0;
  for (const match of cleaned.matchAll(/<([^>]+)>/g)) {
    if (cleaned.slice(cursor, match.index).trim())
      throw new Error("unexpected XML text");
    cursor = match.index + match[0].length;
    const token = match[1].trim();
    if (token.startsWith("?")) throw new Error("unexpected XML instruction");
    if (token.startsWith("/")) {
      const name = token.slice(1).trim();
      const node = stack.pop();
      if (!node || node === document || node.name !== name)
        throw new Error(`unbalanced XML close tag ${name}`);
      continue;
    }
    if (token.startsWith("!")) throw new Error("unsupported XML declaration");
    const selfClosing = token.endsWith("/");
    const body = selfClosing ? token.slice(0, -1).trimEnd() : token;
    const opening = body.match(/^([A-Za-z_][A-Za-z0-9_.:-]*)([^]*)$/);
    if (!opening) throw new Error("malformed XML tag");
    const node = {
      name: opening[1],
      attributes: parseAttributes(opening[2]),
      children: [],
    };
    stack.at(-1).children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (cleaned.slice(cursor).trim()) throw new Error("unexpected trailing XML");
  if (stack.length !== 1) throw new Error("unclosed XML tag");
  if (document.children.length !== 1)
    throw new Error("manifest XML must have exactly one root element");
  return document.children[0];
}

const attr = (node, name) => node.attributes.get(`${ANDROID}${name}`);
const children = (node, name) =>
  node.children.filter((child) => child.name === name);
const requireOnlyChildren = (node, allowed) => {
  const unexpected = node.children.find((child) => !allowed.has(child.name));
  if (unexpected)
    throw new Error(`unexpected <${unexpected.name}> inside <${node.name}>`);
};
const requireLeaves = (nodes) => {
  const nested = nodes.find((node) => node.children.length > 0);
  if (nested) throw new Error(`unexpected child inside <${nested.name}>`);
};
const sorted = (values) => [...values].sort((a, b) => a.localeCompare(b));
const sameValues = (actual, expected) =>
  JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
const normalizeComponent = (name) => {
  if (!name) return name;
  if (name.startsWith(".")) return `${PACKAGE}${name}`;
  return name.includes(".") ? name : `${PACKAGE}.${name}`;
};

const requireFalse = (node, name, explicit = false) => {
  const value = attr(node, name);
  if ((explicit && value !== "false") || (!explicit && value === "true"))
    throw new Error(`android:${name} must be false`);
  if (value !== undefined && value !== "false")
    throw new Error(`android:${name} has invalid boolean value`);
};

const intentValues = (component, tag) =>
  children(component, "intent-filter").flatMap((filter) =>
    children(filter, tag).map((entry) => attr(entry, "name")),
  );

export function validateAndroidReleaseManifest(xml) {
  const manifest = parseXml(xml);
  if (manifest.name !== "manifest") throw new Error("root must be manifest");
  requireOnlyChildren(
    manifest,
    new Set(["uses-sdk", "uses-permission", "uses-feature", "application"]),
  );
  if (manifest.attributes.get("package") !== PACKAGE)
    throw new Error(`release package must be ${PACKAGE}`);
  if (
    attr(manifest, "sharedUserId") !== undefined ||
    attr(manifest, "sharedUserMaxSdkVersion") !== undefined
  )
    throw new Error("shared Android user IDs are forbidden");

  const sdk = children(manifest, "uses-sdk");
  requireLeaves(sdk);
  if (
    sdk.length !== 1 ||
    attr(sdk[0], "minSdkVersion") !== "23" ||
    attr(sdk[0], "targetSdkVersion") !== "35"
  )
    throw new Error("release SDK bounds must be min 23 and target 35");

  const permissionNodes = manifest.children.filter((node) =>
    node.name.startsWith("uses-permission"),
  );
  requireLeaves(permissionNodes);
  const permissions = permissionNodes.map((node) => attr(node, "name"));
  if (
    permissions.some((name) => !name) ||
    new Set(permissions).size !== permissions.length ||
    !sameValues(permissions, EXPECTED_PERMISSIONS)
  )
    throw new Error("release permissions differ from the exact allowlist");

  const featureNodes = children(manifest, "uses-feature");
  requireLeaves(featureNodes);
  const features = featureNodes.map((node) => attr(node, "name"));
  if (
    features.some((name) => !name) ||
    !sameValues(features, EXPECTED_FEATURES) ||
    featureNodes.some((node) => attr(node, "required") !== "false")
  )
    throw new Error(
      "release features differ from the exact optional allowlist",
    );

  if (
    children(manifest, "queries").length > 0 ||
    children(manifest, "instrumentation").length > 0 ||
    children(manifest, "uses-library").length > 0
  )
    throw new Error(
      "package queries, instrumentation, and uses-library are forbidden",
    );

  const applications = children(manifest, "application");
  if (applications.length !== 1)
    throw new Error("release must contain exactly one application");
  const application = applications[0];
  requireOnlyChildren(application, new Set(["activity", "receiver"]));
  requireFalse(application, "allowBackup", true);
  requireFalse(application, "usesCleartextTraffic", true);
  requireFalse(application, "debuggable");
  requireFalse(application, "testOnly");
  requireFalse(application, "requestLegacyExternalStorage");
  if (attr(application, "networkSecurityConfig") !== undefined)
    throw new Error("release networkSecurityConfig requires explicit review");

  for (const forbidden of ["activity-alias", "service", "provider"])
    if (children(application, forbidden).length > 0)
      throw new Error(`unexpected release ${forbidden} component`);

  const activities = children(application, "activity");
  if (activities.length !== 1) throw new Error("unexpected release activity");
  const activity = activities[0];
  requireOnlyChildren(activity, new Set(["intent-filter"]));
  for (const filter of children(activity, "intent-filter")) {
    requireOnlyChildren(filter, new Set(["action", "category", "data"]));
    requireLeaves(filter.children);
  }
  if (
    normalizeComponent(attr(activity, "name")) !== `${PACKAGE}.MainActivity` ||
    attr(activity, "exported") !== "true" ||
    children(activity, "intent-filter").length !== 1 ||
    !sameValues(intentValues(activity, "action"), [
      "android.intent.action.MAIN",
    ]) ||
    !sameValues(intentValues(activity, "category"), [
      "android.intent.category.LAUNCHER",
      "android.intent.category.LEANBACK_LAUNCHER",
    ]) ||
    intentValues(activity, "data").length > 0
  )
    throw new Error("launcher activity surface differs from policy");

  const receivers = children(application, "receiver");
  if (receivers.length !== 1) throw new Error("unexpected release receiver");
  const receiver = receivers[0];
  requireOnlyChildren(receiver, new Set(["intent-filter"]));
  for (const filter of children(receiver, "intent-filter")) {
    requireOnlyChildren(filter, new Set(["action", "category", "data"]));
    requireLeaves(filter.children);
  }
  if (
    normalizeComponent(attr(receiver, "name")) !== `${PACKAGE}.BootReceiver` ||
    attr(receiver, "exported") !== "false" ||
    attr(receiver, "enabled") !== "true" ||
    children(receiver, "intent-filter").length !== 1 ||
    !sameValues(intentValues(receiver, "action"), [
      "android.intent.action.BOOT_COMPLETED",
    ]) ||
    intentValues(receiver, "category").length > 0 ||
    intentValues(receiver, "data").length > 0
  )
    throw new Error("boot receiver surface differs from policy");

  return {
    schemaVersion: 1,
    package: PACKAGE,
    minSdkVersion: 23,
    targetSdkVersion: 35,
    permissions: sorted(permissions),
    features: sorted(features),
    exportedComponents: [`${PACKAGE}.MainActivity`],
    nonExportedComponents: [`${PACKAGE}.BootReceiver`],
    manifestSha256: createHash("sha256").update(xml).digest("hex"),
  };
}

export function createAndroidReleaseSurfaceReport(xml, apkBytes) {
  if (!(apkBytes instanceof Uint8Array) || apkBytes.byteLength === 0)
    throw new Error("release APK bytes are required");
  return {
    ...validateAndroidReleaseManifest(xml),
    apkSha256: createHash("sha256").update(apkBytes).digest("hex"),
  };
}

function main() {
  const [, , manifestPath, apkPath, reportPath] = process.argv;
  if (!manifestPath || !apkPath || !reportPath) {
    console.error(
      "Usage: node validate-android-release-surface.mjs <manifest.xml> <release.apk> <report.json>",
    );
    process.exit(2);
  }
  try {
    const report = createAndroidReleaseSurfaceReport(
      readFileSync(manifestPath, "utf8"),
      readFileSync(apkPath),
    );
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    console.log("Packaged Android release surface matches the exact policy.");
  } catch (error) {
    console.error(
      `Android release surface validation failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exit(1);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main();
