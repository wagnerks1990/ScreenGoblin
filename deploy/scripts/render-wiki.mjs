import {
  lstatSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
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
  const page = join(destination, "ScreenGoblin-Documentation.md");
  const marker = "<!-- ScreenGoblin managed documentation index -->";
  try {
    if (!lstatSync(page).isFile()) {
      throw new Error("Managed Wiki destination must be a regular file");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existsSync(page) && !readFileSync(page, "utf8").startsWith(marker)) {
    throw new Error("Refusing to overwrite an unmanaged Wiki page");
  }
  mkdirSync(destination, { recursive: true });
  const links = sources.map(
    ([path, title]) =>
      `- [${title}](https://github.com/wagnerks1990/ScreenGoblin/blob/${revision}/${path})`,
  );
  writeFileSync(
    page,
    `${marker}\n# ScreenGoblin documentation\n\nScreenGoblin is a pre-production prototype. Emergency publishing and production\npromotion remain subject to the documented release gates.\n\nThis index links to approved Git-tracked documentation at source revision\n\`${revision}\`. Repository documentation is authoritative.\n\n${links.join("\n")}\n\nThis page is managed by the repository Wiki synchronization workflow. Other Wiki\npages are preserved.\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  renderWiki(process.cwd(), process.argv[2], process.argv[3]);
}
