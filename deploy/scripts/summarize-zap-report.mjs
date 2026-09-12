#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const [
  inputPath,
  outputPath,
  surface,
  scannerImage,
  expectedOriginValue,
  coveragePath,
  inventoryPath,
] = process.argv.slice(2);
if (
  !inputPath ||
  !outputPath ||
  !surface ||
  !scannerImage ||
  !expectedOriginValue ||
  !coveragePath ||
  !inventoryPath
) {
  throw new Error(
    "usage: summarize-zap-report.mjs <input> <output> <surface> <scanner-image> <expected-origin> <coverage> <inventory>",
  );
}
if (!/^[a-z0-9-]+$/.test(surface)) {
  throw new Error("surface must be a lowercase identifier");
}
if (!/^[^\s@]+:[^\s@]+@sha256:[0-9a-f]{64}$/.test(scannerImage)) {
  throw new Error("scanner image must be tag-and-digest pinned");
}

const readJson = (path, label) => {
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    throw new Error(`${label} could not be read`);
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
};

const report = readJson(inputPath, "ZAP report");
if (!Array.isArray(report.site) || report.site.length === 0) {
  throw new Error("ZAP report has an empty or missing site inventory");
}
let expectedOrigin;
try {
  expectedOrigin = new URL(expectedOriginValue).origin;
} catch {
  throw new Error("expected target must be a valid exact origin");
}
if (expectedOrigin !== expectedOriginValue.replace(/\/$/, ""))
  throw new Error("expected target must be an exact origin");
for (const site of report.site) {
  let actualOrigin;
  try {
    actualOrigin = new URL(String(site?.["@name"] ?? "")).origin;
  } catch {
    throw new Error("ZAP report contains a site without a valid origin");
  }
  if (actualOrigin !== expectedOrigin)
    throw new Error(
      "ZAP report site does not match the expected target origin",
    );
}

const inventory = readJson(inventoryPath, "checked-in DAST inventory");
const surfaceInventory = inventory?.surfaces?.[surface];
if (
  inventory?.schemaVersion !== 1 ||
  surfaceInventory?.origin !== expectedOrigin ||
  !Array.isArray(surfaceInventory?.routes) ||
  surfaceInventory.routes.length === 0
) {
  throw new Error(
    "checked-in DAST inventory does not match the target surface",
  );
}
const expectedLabels = surfaceInventory.routes
  .map((route) => String(route.label ?? ""))
  .sort();
if (
  expectedLabels.some((label) => !/^[a-z][a-z0-9-]{0,63}$/.test(label)) ||
  new Set(expectedLabels).size !== expectedLabels.length
) {
  throw new Error("checked-in DAST inventory has unsafe or duplicate labels");
}
const coverage = readJson(coveragePath, "ZAP seed coverage");
const coveredLabels = Array.isArray(coverage.coveredLabels)
  ? coverage.coveredLabels.map(String).sort()
  : [];
if (
  coverage.schemaVersion !== 1 ||
  coverage.surface !== surface ||
  coverage.phase !== "pre-shutdown-after-active-scan" ||
  JSON.stringify(coveredLabels) !== JSON.stringify(expectedLabels)
) {
  throw new Error(
    "ZAP seed coverage is incomplete or does not match inventory",
  );
}

const routeMatchers = surfaceInventory.routes.map((route) => {
  const method = String(route.method ?? "").toUpperCase();
  const template = String(route.template ?? "");
  if (!/^(GET|POST|PATCH|DELETE)$/.test(method) || !template.startsWith("/"))
    throw new Error("checked-in DAST inventory contains an invalid route");
  const pattern = template
    .split("/")
    .map((part) =>
      part.startsWith(":")
        ? "[^/]+"
        : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  return { label: route.label, method, pattern: new RegExp(`^${pattern}$`) };
});

const findings = [];
const riskNames = new Map([
  ["-1", "False Positive"],
  ["0", "Informational"],
  ["1", "Low"],
  ["2", "Medium"],
  ["3", "High"],
]);
const confidenceNames = new Map([
  ["0", "False Positive"],
  ["1", "Low"],
  ["2", "Medium"],
  ["3", "High"],
  ["4", "Confirmed"],
]);
const safeAlertName = (value) => {
  const name = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9 ._():/'-]{0,127}$/.test(name)
    ? name
    : `name-sha256:${createHash("sha256").update(name).digest("hex")}`;
};
const safeParameterName = (value) => {
  const name = String(value ?? "");
  if (!name) return "";
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(name)
    ? name
    : "[redacted-unsafe-name]";
};
const safeRouteLabel = (method, pathname) => {
  const match = routeMatchers.find(
    (route) => route.method === method && route.pattern.test(pathname),
  );
  if (match) return match.label;
  return `path-sha256:${createHash("sha256").update(pathname).digest("hex")}`;
};
for (const site of report.site) {
  if (!site || !Array.isArray(site.alerts)) {
    throw new Error("ZAP report contains a site without an alerts inventory");
  }
  for (const alert of site.alerts) {
    const ruleId = String(alert.pluginid ?? "");
    const name = safeAlertName(alert.alert);
    const risk = riskNames.get(String(alert.riskcode ?? ""));
    const confidence = confidenceNames.get(String(alert.confidence ?? ""));
    const riskDescription = String(alert.riskdesc ?? "");
    const confidenceDescription =
      alert.confidencedesc === undefined
        ? confidence
        : String(alert.confidencedesc);
    if (
      !/^\d+$/.test(ruleId) ||
      !risk ||
      !confidence ||
      riskDescription !== `${risk} (${confidence})` ||
      confidenceDescription !== confidence
    ) {
      throw new Error("ZAP report contains incomplete alert identity metadata");
    }
    const instances = Array.isArray(alert.instances) ? alert.instances : [];
    const locations = instances.map((instance) => {
      let parsed;
      try {
        parsed = new URL(String(instance.uri ?? ""));
      } catch {
        throw new Error("ZAP finding contains an invalid location");
      }
      if (parsed.origin !== expectedOrigin)
        throw new Error(
          "ZAP finding contains a location outside the target origin",
        );
      const method = String(instance.method ?? "GET").toUpperCase();
      if (!/^[A-Z]{3,10}$/.test(method))
        throw new Error("ZAP finding contains an unsafe request method");
      return {
        method,
        route: safeRouteLabel(method, parsed.pathname),
        parameter: safeParameterName(instance.param),
      };
    });
    locations.sort((a, b) =>
      `${a.method}\0${a.route}\0${a.parameter}`.localeCompare(
        `${b.method}\0${b.route}\0${b.parameter}`,
      ),
    );
    findings.push({ ruleId, name, risk, confidence, locations });
  }
}
findings.sort((a, b) =>
  `${a.ruleId}\0${a.name}`.localeCompare(`${b.ruleId}\0${b.name}`),
);

const evidence = {
  schemaVersion: 1,
  scope: "unauthenticated-public-caddy-surface",
  surface,
  scannerImage,
  coveredRouteLabels: expectedLabels,
  coveragePhase: coverage.phase,
  findingCount: findings.length,
  informationalFindingCount: findings.filter(
    (finding) => finding.risk === "Informational",
  ).length,
  falsePositiveFindingCount: findings.filter(
    (finding) => finding.risk === "False Positive",
  ).length,
  securitySeverityFindingCount: findings.filter((finding) =>
    ["Low", "Medium", "High"].includes(finding.risk),
  ).length,
  findings,
};
writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
  mode: 0o600,
});
if (evidence.securitySeverityFindingCount > 0) {
  console.error(
    "Blocking security-severity ZAP report alerts independently of wrapper status",
  );
  process.exitCode = 2;
}
