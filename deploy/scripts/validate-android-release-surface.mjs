import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import process from "node:process";

const ANDROID = "android:";
const PACKAGE = "com.screengoblin.player";
const EXPECTED_PERMISSIONS = [
  "android.permission.INTERNET",
  "android.permission.RECEIVE_BOOT_COMPLETED",
  "com.screengoblin.player.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION",
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
  if (xml.includes("<!--") || xml.includes("-->"))
    throw new Error("XML comments are forbidden");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("DTD and entity declarations are forbidden");
  // Parse the analyzer output without deleting comments. Removing a comment
  // can join two otherwise-invalid fragments into an allowlisted element or
  // attribute name (for example, `allowBack<!-- -->up`). Comments are not
  // needed in the packaged binary-manifest output, so the declaration check
  // above rejects them fail closed.
  const declaration = xml.match(/^\s*<\?xml[^?]*\?>/);
  const cleaned = declaration ? xml.slice(declaration[0].length) : xml;
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
const describeNode = (node) => {
  const name = attr(node, "name");
  return typeof name === "string" && /^[A-Za-z0-9_.$-]{1,160}$/.test(name)
    ? `<${node.name} android:name="${name}">`
    : `<${node.name}>`;
};
const requireOnlyChildren = (node, allowed) => {
  const unexpected = node.children.find((child) => !allowed.has(child.name));
  if (unexpected)
    throw new Error(
      `unexpected ${describeNode(unexpected)} inside <${node.name}>`,
    );
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

const exact = (expected) => (value) => value === expected;
const resourceReference = (value) =>
  typeof value === "string" && /^@[A-Za-z0-9_.:/-]+$/.test(value);
const absentOrFalse = (value) => value === undefined || value === "false";

const requireAttributes = (node, required, optional = {}) => {
  const policy = { ...required, ...optional };
  for (const name of node.attributes.keys())
    if (!Object.hasOwn(policy, name))
      throw new Error(`unexpected ${name} on <${node.name}>`);
  for (const [name, predicate] of Object.entries(required)) {
    const value = node.attributes.get(name);
    if (value === undefined || !predicate(value))
      throw new Error(`missing or invalid ${name} on <${node.name}>`);
  }
  for (const [name, predicate] of Object.entries(optional)) {
    const value = node.attributes.get(name);
    if (!predicate(value)) throw new Error(`invalid ${name} on <${node.name}>`);
  }
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
    new Set([
      "uses-sdk",
      "permission",
      "uses-permission",
      "uses-feature",
      "application",
    ]),
  );
  requireAttributes(
    manifest,
    {
      "xmlns:android": exact("http://schemas.android.com/apk/res/android"),
      package: exact(PACKAGE),
      "android:compileSdkVersion": exact("35"),
    },
    {
      "android:compileSdkVersionCodename": (value) =>
        value === undefined || value === "15",
      "android:versionCode": (value) => value === undefined || value === "1",
      "android:versionName": (value) => value === undefined || value === "1.0",
      platformBuildVersionCode: (value) =>
        value === undefined || value === "35",
      platformBuildVersionName: (value) =>
        value === undefined || value === "15",
    },
  );

  const sdk = children(manifest, "uses-sdk");
  requireLeaves(sdk);
  if (sdk.length !== 1)
    throw new Error("release SDK bounds must be min 23 and target 35");
  requireAttributes(sdk[0], {
    "android:minSdkVersion": exact("23"),
    "android:targetSdkVersion": exact("35"),
  });

  const declaredPermissions = children(manifest, "permission");
  requireLeaves(declaredPermissions);
  if (declaredPermissions.length !== 1)
    throw new Error("unexpected declared permission surface");
  requireAttributes(declaredPermissions[0], {
    "android:name": exact(
      `${PACKAGE}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`,
    ),
    "android:protectionLevel": exact("signature"),
  });

  const permissionNodes = manifest.children.filter((node) =>
    node.name.startsWith("uses-permission"),
  );
  requireLeaves(permissionNodes);
  for (const permission of permissionNodes)
    requireAttributes(permission, {
      "android:name": (value) => Boolean(value),
    });
  const permissions = permissionNodes.map((node) => attr(node, "name"));
  if (
    permissions.some((name) => !name) ||
    new Set(permissions).size !== permissions.length ||
    !sameValues(permissions, EXPECTED_PERMISSIONS)
  )
    throw new Error("release permissions differ from the exact allowlist");

  const featureNodes = children(manifest, "uses-feature");
  requireLeaves(featureNodes);
  for (const feature of featureNodes)
    requireAttributes(feature, {
      "android:name": (value) => Boolean(value),
      "android:required": exact("false"),
    });
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
  requireOnlyChildren(
    application,
    new Set(["activity", "receiver", "provider"]),
  );
  requireAttributes(
    application,
    {
      "android:allowBackup": exact("false"),
      "android:banner": resourceReference,
      "android:icon": resourceReference,
      "android:label": resourceReference,
      "android:roundIcon": resourceReference,
      "android:supportsRtl": exact("true"),
      "android:theme": resourceReference,
      "android:usesCleartextTraffic": exact("false"),
    },
    {
      "android:appComponentFactory": (value) =>
        value === undefined ||
        value === "androidx.core.app.CoreComponentFactory",
      "android:debuggable": absentOrFalse,
      "android:extractNativeLibs": absentOrFalse,
      "android:requestLegacyExternalStorage": absentOrFalse,
      "android:testOnly": absentOrFalse,
    },
  );
  requireFalse(application, "allowBackup", true);
  requireFalse(application, "usesCleartextTraffic", true);
  requireFalse(application, "debuggable");
  requireFalse(application, "testOnly");
  requireFalse(application, "requestLegacyExternalStorage");
  for (const forbidden of ["activity-alias", "service"])
    if (children(application, forbidden).length > 0)
      throw new Error(`unexpected release ${forbidden} component`);

  const activities = children(application, "activity");
  if (activities.length !== 1) throw new Error("unexpected release activity");
  const activity = activities[0];
  requireAttributes(activity, {
    "android:configChanges": exact(
      "orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode|navigation",
    ),
    "android:name": (value) =>
      normalizeComponent(value) === `${PACKAGE}.MainActivity`,
    "android:exported": exact("true"),
    "android:label": resourceReference,
    "android:launchMode": exact("singleTask"),
    "android:theme": resourceReference,
  });
  requireOnlyChildren(activity, new Set(["intent-filter"]));
  for (const filter of children(activity, "intent-filter")) {
    requireAttributes(filter, {});
    requireOnlyChildren(filter, new Set(["action", "category", "data"]));
    requireLeaves(filter.children);
    for (const entry of filter.children)
      requireAttributes(entry, { "android:name": (value) => Boolean(value) });
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
  requireAttributes(receiver, {
    "android:name": (value) =>
      normalizeComponent(value) === `${PACKAGE}.BootReceiver`,
    "android:enabled": exact("true"),
    "android:exported": exact("false"),
  });
  requireOnlyChildren(receiver, new Set(["intent-filter"]));
  for (const filter of children(receiver, "intent-filter")) {
    requireAttributes(filter, {});
    requireOnlyChildren(filter, new Set(["action", "category", "data"]));
    requireLeaves(filter.children);
    for (const entry of filter.children)
      requireAttributes(entry, { "android:name": (value) => Boolean(value) });
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

  const providers = children(application, "provider");
  if (providers.length !== 1)
    throw new Error("unexpected release provider surface");
  const provider = providers[0];
  requireAttributes(provider, {
    "android:name": exact("androidx.startup.InitializationProvider"),
    "android:authorities": exact(`${PACKAGE}.androidx-startup`),
    "android:exported": exact("false"),
  });
  requireOnlyChildren(provider, new Set(["meta-data"]));
  const metadata = children(provider, "meta-data");
  requireLeaves(metadata);
  for (const entry of metadata)
    requireAttributes(entry, {
      "android:name": (value) => Boolean(value),
      "android:value": exact("androidx.startup"),
    });
  const initializerNames = metadata.map((entry) => attr(entry, "name"));
  if (
    !sameValues(initializerNames, [
      "androidx.emoji2.text.EmojiCompatInitializer",
      "androidx.lifecycle.ProcessLifecycleInitializer",
    ]) ||
    initializerNames.some((name) =>
      name?.startsWith("androidx.profileinstaller"),
    )
  )
    throw new Error("startup initializer surface differs from policy");

  return {
    schemaVersion: 1,
    package: PACKAGE,
    minSdkVersion: 23,
    targetSdkVersion: 35,
    permissions: sorted(permissions),
    features: sorted(features),
    exportedComponents: [`${PACKAGE}.MainActivity`],
    nonExportedComponents: [
      `${PACKAGE}.BootReceiver`,
      "androidx.startup.InitializationProvider",
    ],
    manifestSha256: createHash("sha256").update(xml).digest("hex"),
  };
}

export function createAndroidReleaseSurfaceReport(
  xml,
  apkBytes,
  analyzerVersion = "test",
) {
  if (!(apkBytes instanceof Uint8Array) || apkBytes.byteLength === 0)
    throw new Error("release APK bytes are required");
  if (
    typeof analyzerVersion !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9 ._()+/-]{0,127}$/.test(analyzerVersion)
  )
    throw new Error("invalid APK analyzer version");
  return {
    ...validateAndroidReleaseManifest(xml),
    apkSha256: createHash("sha256").update(apkBytes).digest("hex"),
    analyzerVersion,
  };
}

const runAnalyzer = (analyzerPath, args) => {
  const result = spawnSync(analyzerPath, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || result.signal)
    throw new Error("APK analyzer command failed");
  return result.stdout;
};

export function extractAndroidReleaseManifest(analyzerPath, apkPath) {
  if (typeof analyzerPath !== "string" || analyzerPath.length === 0)
    throw new Error("APK analyzer path is required");
  if (typeof apkPath !== "string" || apkPath.length === 0)
    throw new Error("release APK path is required");
  const analyzerVersion = runAnalyzer(analyzerPath, ["--version"]).trim();
  const xml = runAnalyzer(analyzerPath, ["manifest", "print", apkPath]);
  if (!analyzerVersion || !xml.trim())
    throw new Error("APK analyzer returned incomplete evidence");
  return { analyzerVersion, xml };
}

function main() {
  const [, , analyzerPath, apkPath, manifestPath, reportPath] = process.argv;
  if (!analyzerPath || !apkPath || !manifestPath || !reportPath) {
    console.error(
      "Usage: node validate-android-release-surface.mjs <apkanalyzer> <release.apk> <manifest.xml> <report.json>",
    );
    process.exit(2);
  }
  try {
    const apkBytesBefore = readFileSync(apkPath);
    const { analyzerVersion, xml } = extractAndroidReleaseManifest(
      analyzerPath,
      apkPath,
    );
    const apkBytes = readFileSync(apkPath);
    if (!apkBytesBefore.equals(apkBytes))
      throw new Error("release APK changed during manifest extraction");
    writeFileSync(manifestPath, xml, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const report = createAndroidReleaseSurfaceReport(
      xml,
      apkBytes,
      analyzerVersion,
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
