import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  ftruncateSync,
  writeSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function renderWiki(repository, destination, revision) {
  if (!/^[0-9a-f]{40}$/.test(revision))
    throw new Error("A full source commit SHA is required");
  const sources = [
    ["README.md", "Overview and installation"],
    ["CONTRIBUTING.md", "Development and validation"],
    ["SECURITY.md", "Security policy"],
    ["docs/README.md", "Documentation index"],
    ["docs/PREPRODUCTION.md", "Pre-production release gates"],
    ["docs/RUNBOOK.md", "Operations runbook"],
    ["docs/DEVICE_PROTOCOL.md", "Device protocol"],
    ["docs/RELEASE_EVIDENCE.md", "Release evidence"],
  ];
  for (const [path] of sources) {
    if (!existsSync(join(repository, path)))
      throw new Error(`Missing approved documentation: ${path}`);
  }

  const marker = "<!-- ScreenGoblin managed documentation index -->";
  mkdirSync(destination, { recursive: true });
  const links = sources.map(
    ([path, title]) =>
      `- [${title}](https://github.com/wagnerks1990/ScreenGoblin/blob/${revision}/${path})`,
  );
  const content = `${marker}\n# ScreenGoblin documentation\n\nScreenGoblin is a pre-production prototype. Emergency publishing and production\npromotion remain subject to the documented release gates.\n\nThis index links to approved Git-tracked documentation at source revision\n\`${revision}\`. Repository documentation is authoritative.\n\n${links.join("\n")}\n\nThis page is managed by the repository Wiki synchronization workflow. Other Wiki\npages are preserved.\n`;
  let descriptor;
  let directoryDescriptor;
  let created = false;
  const flags = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  try {
    // CI runs on Linux; keep the directory anchored even if its pathname changes.
    directoryDescriptor = openSync(
      destination,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const page = `/proc/self/fd/${directoryDescriptor}/ScreenGoblin-Documentation.md`;
    try {
      descriptor = openSync(
        page,
        flags | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      created = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      descriptor = openSync(page, flags);
    }
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new Error(
        "Managed Wiki destination must be a regular file with one link",
      );
    }
    if (!created && !readFileSync(descriptor, "utf8").startsWith(marker)) {
      throw new Error("Refusing to overwrite an unmanaged Wiki page");
    }
    const bytes = Buffer.from(content);
    let written = 0;
    while (written < bytes.length) {
      written += writeSync(
        descriptor,
        bytes,
        written,
        bytes.length - written,
        written,
      );
    }
    ftruncateSync(descriptor, written);
  } catch (error) {
    if (
      error.code === "ELOOP" ||
      error.code === "EISDIR" ||
      error.code === "ENOTDIR"
    ) {
      throw new Error("Managed Wiki destination must be a regular file", {
        cause: error,
      });
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  renderWiki(process.cwd(), process.argv[2], process.argv[3]);
}
