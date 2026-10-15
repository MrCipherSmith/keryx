import path from "node:path";

// A module README is written to be read in place, so its relative links resolve
// against the README's own directory. The excerpt `wiki collect` quotes from it
// lands in `.metaproject/wiki/components/`, where the same text resolves to
// nothing. Each link is rewritten here: to the module's wiki page when there is
// one, otherwise to the code path as plain text.

const MARKDOWN_LINK = /(!?)\[([^[\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const HAS_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const DOC_ENTRY = /^(?:readme|index)\.(?:md|mdx)$/i;

/** Wiki page for a module, relative to the components folder; null when it has none. */
export type ModulePageLink = (moduleName: string) => string | null;

export function rewriteReadmeLinks(text: string, readmeDir: string, pageLink: ModulePageLink): string {
  return text.replace(MARKDOWN_LINK, (whole, bang: string, label: string, target: string) => {
    if (target === "" || HAS_SCHEME.test(target)) {
      return whole;
    }
    const filePart = target.split(/[#?]/)[0] ?? "";
    if (filePart === "") {
      return label;
    }

    const resolved = path.posix.normalize(
      filePart.startsWith("/") ? filePart.replace(/^\/+/, "") : path.posix.join(readmeDir, filePart),
    );
    const codePath = resolved.replace(/\/+$/, "");
    if (codePath === "" || codePath === "." || codePath === ".." || codePath.startsWith("../")) {
      return label;
    }

    const named = label.length > 0 ? `${label} (\`${codePath}\`)` : `\`${codePath}\``;
    if (bang === "!") {
      return named;
    }
    const moduleName = moduleOfTarget(filePart, codePath);
    const page = moduleName === null ? null : pageLink(moduleName);
    return page === null ? named : `[${label.length > 0 ? label : moduleName}](${page})`;
  });
}

/** The module a README link points at: a directory, or a directory's README. A file inside one is not a module. */
function moduleOfTarget(filePart: string, codePath: string): string | null {
  const base = path.posix.basename(codePath);
  if (filePart.endsWith("/") || !/\.[A-Za-z0-9]+$/.test(base)) {
    return codePath;
  }
  if (DOC_ENTRY.test(base)) {
    const dir = path.posix.dirname(codePath);
    return dir === "." ? null : dir;
  }
  return null;
}

/** Cut at `max` characters without leaving half a Markdown link behind. */
export function truncateMarkdown(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max).replace(/\s*!?\[[^\]]*$|\s*!?\[[^\]]*\]\([^)]*$/, "").trimEnd();
}
