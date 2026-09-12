import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const metadataPath = "apps/player/android/gradle/verification-metadata.xml";
const propertiesPath = "apps/player/android/gradle.properties";
const requiredWorkflows = [
  ".github/workflows/ci.yml",
  ".github/workflows/codeql.yml",
];
const ignoredDirectories = new Set([".git", "build", "dist", "node_modules"]);

function localName(name) {
  return name.slice(name.lastIndexOf(":") + 1);
}

function parseXml(xml) {
  if (!xml.trim()) throw new Error("document is empty");
  if (/<!DOCTYPE/i.test(xml))
    throw new Error("DOCTYPE declarations are not allowed");

  const document = {
    name: "#document",
    attributes: {},
    children: [],
    text: "",
  };
  const stack = [document];
  const tokenPattern =
    /<!--[\s\S]*?-->|<\?[^?]*(?:\?(?!>)[^?]*)*\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>/g;
  let cursor = 0;

  const assertValidEntities = (value) => {
    if (/&(?!amp;|lt;|gt;|quot;|apos;|#[0-9]+;|#x[0-9A-Fa-f]+;)/.test(value)) {
      throw new Error("invalid entity reference");
    }
  };

  for (const match of xml.matchAll(tokenPattern)) {
    const between = xml.slice(cursor, match.index);
    if (between.includes("<")) throw new Error("malformed markup");
    assertValidEntities(between);
    stack.at(-1).text += between;
    const token = match[0];
    cursor = match.index + token.length;

    if (token.startsWith("<!--") || token.startsWith("<?")) continue;
    if (token.startsWith("<![CDATA[")) {
      stack.at(-1).text += token.slice(9, -3);
      continue;
    }
    if (token.startsWith("</")) {
      const closingName = token.slice(2, -1).trim();
      if (!/^[A-Za-z_][\w:.-]*$/.test(closingName) || stack.length === 1) {
        throw new Error("invalid closing tag");
      }
      if (stack.at(-1).name !== closingName) {
        throw new Error(`mismatched closing tag ${closingName}`);
      }
      stack.pop();
      continue;
    }
    if (token.startsWith("<!")) throw new Error("unsupported declaration");

    const selfClosing = /\/\s*>$/.test(token);
    const inner = token
      .slice(1, selfClosing ? token.lastIndexOf("/") : -1)
      .trim();
    const nameMatch = inner.match(/^([A-Za-z_][\w:.-]*)/);
    if (!nameMatch) throw new Error("invalid opening tag");
    const name = nameMatch[1];
    const attributes = {};
    let rest = inner.slice(name.length);
    const attributePattern = /^\s+([A-Za-z_][\w:.-]*)\s*=\s*("[^"]*"|'[^']*')/;
    while (rest.length > 0) {
      const attribute = rest.match(attributePattern);
      if (!attribute) throw new Error(`malformed attributes on ${name}`);
      if (Object.hasOwn(attributes, attribute[1])) {
        throw new Error(`duplicate attribute ${attribute[1]}`);
      }
      const value = attribute[2].slice(1, -1);
      assertValidEntities(value);
      attributes[attribute[1]] = value;
      rest = rest.slice(attribute[0].length);
    }
    const node = { name, attributes, children: [], text: "" };
    stack.at(-1).children.push(node);
    if (!selfClosing) stack.push(node);
  }

  const trailing = xml.slice(cursor);
  if (trailing.includes("<")) throw new Error("unterminated markup");
  assertValidEntities(trailing);
  stack.at(-1).text += trailing;
  if (stack.length !== 1) throw new Error(`unclosed tag ${stack.at(-1).name}`);
  if (document.children.length !== 1 || document.text.trim()) {
    throw new Error("document must contain exactly one root element");
  }
  return document.children[0];
}

function descendants(node) {
  return [node, ...node.children.flatMap(descendants)];
}

function parseProperties(text) {
  const values = new Map();
  const duplicates = new Set();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!"))
      continue;
    const match = trimmed.match(/^([^:=\s]+)\s*(?:=|:)\s*(.*?)\s*$/);
    if (!match) continue;
    if (values.has(match[1])) duplicates.add(match[1]);
    values.set(match[1], match[2]);
  }
  return { values, duplicates };
}

function lineNumber(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function checkGradleInvocations(path, text, errors) {
  const lines = text.split(/\r?\n/);
  let invocations = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (!/(?:^|\s)\.\/gradlew(?:\s|$)/.test(lines[index])) continue;
    invocations += 1;
    let command = lines[index];
    let end = index;
    while (/\\\s*$/.test(command) && end + 1 < lines.length) {
      end += 1;
      command += `\n${lines[end]}`;
    }
    if (!/(?:^|\s)--dependency-verification=strict(?:\s|\\|$)/.test(command)) {
      errors.push(
        `${path}:${index + 1}: Gradle command must explicitly use --dependency-verification=strict`,
      );
    }
    index = end;
  }
  if (invocations === 0)
    errors.push(`${path}: required Gradle command is missing`);
}

function walk(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else files.push(path);
  }
  return files;
}

export function validateGradleIntegrity(root) {
  const errors = [];
  const absoluteMetadata = join(root, metadataPath);
  let xml;
  try {
    xml = readFileSync(absoluteMetadata, "utf8");
  } catch {
    errors.push(`${metadataPath}: verification metadata is missing`);
  }
  if (xml !== undefined) {
    try {
      const rootNode = parseXml(xml);
      if (localName(rootNode.name) !== "verification-metadata") {
        errors.push(
          `${metadataPath}: unexpected root element ${rootNode.name}`,
        );
      }
      const nodes = descendants(rootNode);
      const configurations = nodes.filter(
        (node) => localName(node.name) === "configuration",
      );
      if (configurations.length !== 1) {
        errors.push(
          `${metadataPath}: expected exactly one non-empty configuration element`,
        );
      } else {
        const configuration = configurations[0];
        const setting = (name) =>
          configuration.children.filter(
            (node) => localName(node.name) === name,
          );
        const verifyMetadata = setting("verify-metadata");
        const verifySignatures = setting("verify-signatures");
        if (
          verifyMetadata.length !== 1 ||
          verifyMetadata[0].text.trim() !== "true"
        ) {
          errors.push(
            `${metadataPath}: configuration must set verify-metadata to true`,
          );
        }
        if (
          verifySignatures.length !== 1 ||
          verifySignatures[0].text.trim() !== "false"
        ) {
          errors.push(
            `${metadataPath}: configuration must set verify-signatures to false`,
          );
        }
        if (configuration.children.length === 0) {
          errors.push(`${metadataPath}: configuration must not be empty`);
        }
      }
      const exemptions = nodes.filter((node) =>
        /trust|ignor/i.test(localName(node.name)),
      );
      if (exemptions.length > 0) {
        errors.push(
          `${metadataPath}: trust/ignore exemptions are forbidden (${exemptions.map((node) => node.name).join(", ")})`,
        );
      }
      const hashes = nodes.filter((node) => localName(node.name) === "sha256");
      if (hashes.length === 0)
        errors.push(
          `${metadataPath}: at least one sha256 checksum is required`,
        );
      for (const hash of hashes) {
        if (!/^[0-9a-f]{64}$/.test(hash.attributes.value ?? "")) {
          errors.push(
            `${metadataPath}: every sha256 value must be 64 lowercase hexadecimal characters`,
          );
          break;
        }
      }
    } catch (error) {
      errors.push(`${metadataPath}: malformed XML (${error.message})`);
    }
  }

  const absoluteProperties = join(root, propertiesPath);
  let properties;
  try {
    properties = readFileSync(absoluteProperties, "utf8");
  } catch {
    errors.push(`${propertiesPath}: file is missing`);
  }
  if (properties !== undefined) {
    const { values, duplicates } = parseProperties(properties);
    for (const [key, expected] of [
      ["org.gradle.dependency.verification", "strict"],
      ["org.gradle.dependency.verification.console", "verbose"],
    ]) {
      if (duplicates.has(key) || values.get(key) !== expected) {
        errors.push(
          `${propertiesPath}: ${key} must be set exactly once to ${expected}`,
        );
      }
    }
  }

  for (const workflow of requiredWorkflows) {
    const path = join(root, workflow);
    try {
      checkGradleInvocations(workflow, readFileSync(path, "utf8"), errors);
    } catch {
      errors.push(`${workflow}: workflow is missing`);
    }
  }

  const scanExtensions = new Set([
    ".gradle",
    ".kts",
    ".properties",
    ".yml",
    ".yaml",
  ]);
  for (const path of walk(root)) {
    if (!scanExtensions.has(extname(path))) continue;
    const name = relative(root, path).replaceAll("\\", "/");
    const text = readFileSync(path, "utf8");
    const forbidden =
      /--dependency-verification(?:=|\s+)(?:off|lenient)\b|org\.gradle\.dependency\.verification(?:\s*[:=]\s*|\s+)(?:off|lenient)\b|disableDependencyVerification\b/gi;
    for (const match of text.matchAll(forbidden)) {
      errors.push(
        `${name}:${lineNumber(text, match.index)}: dependency verification bypass is forbidden`,
      );
    }
  }
  return errors;
}

const invokedPath = process.argv[1]
  ? fileURLToPath(new URL(`file://${process.argv[1]}`))
  : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const errors = validateGradleIntegrity(repositoryRoot);
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(
      "Gradle dependency verification metadata and enforcement are strict.",
    );
  }
}
