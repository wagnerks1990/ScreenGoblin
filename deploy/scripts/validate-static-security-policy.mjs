import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_EXCEPTION_DAYS = 90;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ALLOWED_SCANNERS = new Set(["misconfig", "secret"]);

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} must contain exactly: ${expected.join(", ")}`);
  }
}

function validateDate(value, label, today) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    fail(`${label} must be YYYY-MM-DD`);
  }
  const expiry = new Date(`${value}T00:00:00Z`);
  if (
    Number.isNaN(expiry.valueOf()) ||
    expiry.toISOString().slice(0, 10) !== value
  ) {
    fail(`${label} is not a valid calendar date`);
  }
  const start = new Date(`${today}T00:00:00Z`);
  const days = (expiry - start) / 86_400_000;
  if (days < 0) fail(`${label} has expired`);
  if (days > MAX_EXCEPTION_DAYS) {
    fail(`${label} must be no more than ${MAX_EXCEPTION_DAYS} days ahead`);
  }
}

function validateStatement(value, label) {
  if (
    typeof value !== "string" ||
    value.trim().length < 12 ||
    value.length > 500
  ) {
    fail(`${label} must be a specific 12-500 character justification`);
  }
}

function validateRepoPath(value, label) {
  if (
    typeof value !== "string" ||
    value === "." ||
    value === ".." ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.split("/").includes("..") ||
    /[*?{}[\]]/.test(value)
  ) {
    fail(
      `${label} must be one literal repository-relative file path without wildcards`,
    );
  }
}

function parseArgs(argv) {
  const result = {
    staticPolicy: "security/static-scan-exceptions.json",
    licensePolicy: "security/dependency-license-policy.json",
    lockfile: "package-lock.json",
  };
  const allowed = new Map([
    ["--static-policy", "staticPolicy"],
    ["--license-policy", "licensePolicy"],
    ["--lockfile", "lockfile"],
    ["--trivy-ignore-output", "trivyIgnoreOutput"],
    ["--license-evidence-output", "licenseEvidenceOutput"],
    ["--today", "today"],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = allowed.get(argv[index]);
    if (!key || index + 1 >= argv.length) {
      fail(`unknown or incomplete argument: ${argv[index]}`);
    }
    result[key] = argv[index + 1];
  }
  result.today ??= new Date().toISOString().slice(0, 10);
  if (!ISO_DATE.test(result.today)) fail("--today must be YYYY-MM-DD");
  return result;
}

function dependencyName(lockPath, entry) {
  if (typeof entry.name === "string" && entry.name) return entry.name;
  const suffix = lockPath.split("node_modules/").at(-1);
  const parts = suffix.split("/");
  return parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function validateProvenance(resolved, integrity, label) {
  if (typeof resolved !== "string" || !resolved.trim()) {
    fail(`${label}.resolved must be a non-empty provenance locator`);
  }
  if (resolved.startsWith("https://")) {
    if (
      typeof integrity !== "string" ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)
    ) {
      fail(`${label} HTTPS provenance requires SHA-512 integrity`);
    }
    return "https-integrity";
  }
  if (resolved.startsWith("file:")) {
    const filePath = resolved.slice("file:".length);
    if (
      !filePath ||
      filePath.startsWith("/") ||
      filePath.includes("\\") ||
      filePath.split("/").includes("..")
    ) {
      fail(`${label} file provenance must be a repository-relative path`);
    }
    return "local-file";
  }
  if (resolved.startsWith("git+") || resolved.startsWith("git://")) {
    if (!/#[0-9a-f]{40}$/i.test(resolved)) {
      fail(`${label} git provenance must end in a full commit SHA`);
    }
    return "git-commit";
  }
  fail(`${label}.resolved uses an unsupported provenance form`);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function yamlString(value) {
  return JSON.stringify(value);
}

export async function validateStaticSecurityPolicy(options) {
  const [staticText, licenseText, lockText] = await Promise.all([
    readFile(options.staticPolicy, "utf8"),
    readFile(options.licensePolicy, "utf8"),
    readFile(options.lockfile, "utf8"),
  ]);
  const staticPolicy = JSON.parse(staticText);
  const licensePolicy = JSON.parse(licenseText);
  const lockfile = JSON.parse(lockText);

  exactKeys(staticPolicy, ["version", "exceptions"], "static scan policy");
  if (staticPolicy.version !== 1 || !Array.isArray(staticPolicy.exceptions)) {
    fail(
      "static scan policy version must be 1 and exceptions must be an array",
    );
  }

  const ignoreLines = [
    "# Generated from security/static-scan-exceptions.json; do not edit.",
    "",
  ];
  const seenStatic = new Set();
  for (const [index, exception] of staticPolicy.exceptions.entries()) {
    const label = `static exception ${index}`;
    exactKeys(
      exception,
      ["scanner", "id", "paths", "statement", "expiresOn"],
      label,
    );
    if (!ALLOWED_SCANNERS.has(exception.scanner)) {
      fail(`${label}.scanner must be secret or misconfig`);
    }
    if (typeof exception.id !== "string" || !SAFE_ID.test(exception.id)) {
      fail(`${label}.id is invalid`);
    }
    if (
      !Array.isArray(exception.paths) ||
      exception.paths.length === 0 ||
      exception.paths.length > 10
    ) {
      fail(`${label}.paths must contain 1-10 exact file paths`);
    }
    exception.paths.forEach((entry, pathIndex) =>
      validateRepoPath(entry, `${label}.paths[${pathIndex}]`),
    );
    validateStatement(exception.statement, `${label}.statement`);
    validateDate(exception.expiresOn, `${label}.expiresOn`, options.today);
    const identity = `${exception.scanner}:${exception.id}:${[
      ...exception.paths,
    ]
      .sort()
      .join(",")}`;
    if (seenStatic.has(identity)) fail(`${label} duplicates another exception`);
    seenStatic.add(identity);
    ignoreLines.push(
      `- id: ${yamlString(exception.id)}`,
      "  paths:",
      ...exception.paths.map((entry) => `    - ${yamlString(entry)}`),
      `  statement: ${yamlString(
        `[${exception.scanner}] ${exception.statement}`,
      )}`,
      `  expired_at: ${yamlString(exception.expiresOn)}`,
      "",
    );
  }

  exactKeys(
    licensePolicy,
    ["version", "allowedLicenseExpressions", "exceptions"],
    "license policy",
  );
  if (
    licensePolicy.version !== 1 ||
    !Array.isArray(licensePolicy.allowedLicenseExpressions) ||
    !Array.isArray(licensePolicy.exceptions)
  ) {
    fail(
      "license policy version must be 1 and both policy lists must be arrays",
    );
  }
  const allowed = new Set();
  for (const expression of licensePolicy.allowedLicenseExpressions) {
    if (
      typeof expression !== "string" ||
      !expression.trim() ||
      expression !== expression.trim()
    ) {
      fail("allowed license expressions must be non-empty exact strings");
    }
    if (allowed.has(expression)) {
      fail(`duplicate allowed license expression: ${expression}`);
    }
    allowed.add(expression);
  }

  const exceptions = new Map();
  for (const [index, exception] of licensePolicy.exceptions.entries()) {
    const label = `license exception ${index}`;
    exactKeys(
      exception,
      ["package", "version", "licenseExpression", "statement", "expiresOn"],
      label,
    );
    for (const key of ["package", "version", "licenseExpression"]) {
      if (typeof exception[key] !== "string" || !exception[key].trim()) {
        fail(`${label}.${key} is required`);
      }
    }
    validateStatement(exception.statement, `${label}.statement`);
    validateDate(exception.expiresOn, `${label}.expiresOn`, options.today);
    const identity = `${exception.package}@${exception.version}:${exception.licenseExpression}`;
    if (exceptions.has(identity)) fail(`${label} duplicates another exception`);
    exceptions.set(identity, exception);
  }

  if (!lockfile.packages || typeof lockfile.packages !== "object") {
    fail("lockfile packages object is required");
  }
  const records = [];
  const explicitProvenance = new Map();
  for (const [lockPath, entry] of Object.entries(lockfile.packages)) {
    if (!lockPath.includes("node_modules/")) continue;
    if (entry?.link === true) continue;
    if (!entry || typeof entry !== "object") {
      fail(`${lockPath} must contain dependency metadata`);
    }
    const name = dependencyName(lockPath, entry);
    if (!name) fail(`${lockPath} must have a derivable dependency name`);
    if (typeof entry.version !== "string" || !entry.version.trim()) {
      fail(`${name} at ${lockPath} must have an exact version`);
    }
    if (typeof entry.license !== "string" || !entry.license.trim()) {
      fail(
        `${name}@${entry.version} at ${lockPath} must have an exact license`,
      );
    }
    const packageIdentity = `${name}@${entry.version}`;
    let provenanceKind;
    if (Object.hasOwn(entry, "resolved")) {
      provenanceKind = validateProvenance(
        entry.resolved,
        entry.integrity,
        `${packageIdentity} at ${lockPath}`,
      );
      const existing = explicitProvenance.get(packageIdentity);
      if (existing && existing.resolved !== entry.resolved) {
        fail(`${packageIdentity} has conflicting provenance locators`);
      }
      explicitProvenance.set(packageIdentity, {
        resolved: entry.resolved,
        kind: provenanceKind,
      });
    }
    records.push({
      lockPath,
      name,
      version: entry.version,
      licenseExpression: entry.license,
      provenanceKind,
    });
  }

  const dependencies = [];
  const usedExceptions = new Set();
  for (const record of records) {
    const inherited = explicitProvenance.get(
      `${record.name}@${record.version}`,
    );
    const provenanceKind =
      record.provenanceKind ??
      (inherited ? `inherited-${inherited.kind}` : "lockfile-unresolved");
    const identity = `${record.name}@${record.version}:${record.licenseExpression}`;
    const exception = exceptions.get(identity);
    if (!allowed.has(record.licenseExpression) && !exception) {
      fail(
        `unapproved license ${record.licenseExpression} for ${record.name}@${record.version}`,
      );
    }
    if (exception) usedExceptions.add(identity);
    dependencies.push({
      name: record.name,
      version: record.version,
      licenseExpression: record.licenseExpression,
      provenanceKind,
    });
  }
  for (const identity of exceptions.keys()) {
    if (!usedExceptions.has(identity)) {
      fail(`unused license exception: ${identity}`);
    }
  }
  dependencies.sort((left, right) =>
    [left.name, left.version, left.licenseExpression]
      .join("\0")
      .localeCompare(
        [right.name, right.version, right.licenseExpression].join("\0"),
      ),
  );
  const licenseCounts = Object.fromEntries(
    [...new Set(dependencies.map((entry) => entry.licenseExpression))]
      .sort()
      .map((expression) => [
        expression,
        dependencies.filter((entry) => entry.licenseExpression === expression)
          .length,
      ]),
  );
  const evidence = {
    schemaVersion: 1,
    inputs: {
      lockfileSha256: sha256(lockText),
      policySha256: sha256(licenseText),
    },
    dependencyCount: dependencies.length,
    licenseCounts,
    dependencies,
    appliedExceptions: [...usedExceptions].sort(),
  };

  if (options.trivyIgnoreOutput) {
    await mkdir(path.dirname(options.trivyIgnoreOutput), { recursive: true });
    await writeFile(options.trivyIgnoreOutput, `${ignoreLines.join("\n")}\n`);
  }
  if (options.licenseEvidenceOutput) {
    await mkdir(path.dirname(options.licenseEvidenceOutput), {
      recursive: true,
    });
    await writeFile(
      options.licenseEvidenceOutput,
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
  }
  return evidence;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const evidence = await validateStaticSecurityPolicy(options);
  console.log(
    `static security policy valid: ${evidence.dependencyCount} dependencies, ${Object.keys(evidence.licenseCounts).length} license expressions`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
