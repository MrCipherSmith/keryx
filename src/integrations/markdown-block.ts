// Flow 307 (W5-b), T5: the ONE managed-markdown-block implementation every
// new `instructions` surface (gemini-cli's GEMINI.md, kiro's steering file,
// github-copilot-agent's copilot-instructions.md) is built from — mirroring
// how `settings-json.ts` is the one JSON walker every JSON surface shares.
//
// The block is a SHORT pointer, distinct from (and using a different marker
// than) `src/lib/agent-entrypoint-blocks.ts`'s `renderProjectMetaprojectReferenceBlock`
// (marker `<!-- keryx:index -->`), which writes the full Metaproject bootstrap
// into AGENTS.md/CLAUDE.md. That block is long by design — it is the primary
// entrypoint file's own routing table. This one is a one-paragraph nudge
// written into a SECONDARY instructions file a new, experimental harness may
// or may not actually read, so the two deliberately share phrasing (the hard
// gate on `.metaproject/index.md`, routing code search through
// `keryx ctx rg`) rather than a second invented wording, without duplicating
// the whole bootstrap block verbatim into a file this workstream cannot
// confirm any harness reads end-to-end.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";

export const INSTRUCTIONS_START_MARKER = "<!-- keryx:instructions -->";
export const INSTRUCTIONS_END_MARKER = "<!-- /keryx:instructions -->";

/** The managed block body, byte-identical across every markdown-block surface. */
export function renderInstructionsBlock(): string {
  return `${INSTRUCTIONS_START_MARKER}
## Keryx

Before the first shell command, search, file read, code navigation, planning step, implementation, review, analysis, or subagent dispatch in this repository, read \`.metaproject/index.md\` when it exists — it routes to the project's rules, skills, wiki, and tools; do not treat it as an on-demand reference. Any text/symbol/pattern search over project code goes through \`keryx ctx rg\`, never a bare \`rg\`/\`grep\`.
${INSTRUCTIONS_END_MARKER}
`;
}

function insertOrReplaceBlock(content: string, block: string): string {
  const startIdx = content.indexOf(INSTRUCTIONS_START_MARKER);
  if (startIdx >= 0) {
    const endIdx = content.indexOf(INSTRUCTIONS_END_MARKER, startIdx);
    if (endIdx >= 0) {
      const after = endIdx + INSTRUCTIONS_END_MARKER.length;
      const tail = content.slice(after).replace(/^\n/, "");
      return `${content.slice(0, startIdx)}${block}${tail}`;
    }
    // Start marker with no end marker (hand-edited/truncated): replace from
    // the start marker to end of file rather than guessing where it ends.
    return `${content.slice(0, startIdx)}${block}`;
  }
  if (content.length === 0) return block;
  const withTrailingNewline = content.endsWith("\n") ? content : `${content}\n`;
  const separator = withTrailingNewline.endsWith("\n\n") ? "" : "\n";
  return `${withTrailingNewline}${separator}${block}`;
}

function fileFor(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split("/"));
}

/**
 * Install the managed block into `relativePath`, creating the file (and any
 * parent directories) and prepending `frontMatter` (kiro's steering front
 * matter) when the file does not exist yet. Idempotent: re-running replaces
 * only the block, preserving everything else in the file untouched.
 */
export async function installMarkdownBlock(root: string, relativePath: string, frontMatter?: string): Promise<string[]> {
  const file = fileFor(root, relativePath);
  const block = renderInstructionsBlock();
  if (!(await pathExists(file))) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${frontMatter ?? ""}${block}`, "utf8");
    return [];
  }
  const content = await readFile(file, "utf8");
  const withFrontMatter = frontMatter && !content.startsWith(frontMatter) ? `${frontMatter}${content}` : content;
  const next = insertOrReplaceBlock(withFrontMatter, block);
  if (next !== content) await writeFile(file, next, "utf8");
  return [];
}

/**
 * Remove only the managed block from `relativePath`. Deletes the file when
 * nothing but whitespace (or only the front matter Keryx itself wrote) would
 * remain; otherwise preserves every other line untouched. Returns `false`
 * when there was nothing to remove.
 */
export async function uninstallMarkdownBlock(root: string, relativePath: string, frontMatter?: string): Promise<boolean> {
  const file = fileFor(root, relativePath);
  if (!(await pathExists(file))) return false;
  const content = await readFile(file, "utf8");
  const startIdx = content.indexOf(INSTRUCTIONS_START_MARKER);
  if (startIdx < 0) return false;
  const endIdx = content.indexOf(INSTRUCTIONS_END_MARKER, startIdx);
  const after = endIdx >= 0 ? endIdx + INSTRUCTIONS_END_MARKER.length : content.length;
  const tail = content.slice(after).replace(/^\n/, "");
  const removed = `${content.slice(0, startIdx)}${tail}`;
  const withoutFrontMatter = frontMatter && removed.startsWith(frontMatter) ? removed.slice(frontMatter.length) : removed;
  if (withoutFrontMatter.trim().length === 0) {
    await rm(file, { force: true });
  } else {
    await writeFile(file, removed, "utf8");
  }
  return true;
}

/** Health check for a markdown-block surface: missing file / missing block / stale block content. */
export async function probeMarkdownBlock(root: string, relativePath: string): Promise<string[]> {
  const file = fileFor(root, relativePath);
  if (!(await pathExists(file))) {
    return [`${relativePath}: file is missing`];
  }
  const content = await readFile(file, "utf8");
  const startIdx = content.indexOf(INSTRUCTIONS_START_MARKER);
  if (startIdx < 0) {
    return [`${relativePath}: missing the keryx:instructions block`];
  }
  const endIdx = content.indexOf(INSTRUCTIONS_END_MARKER, startIdx);
  if (endIdx < 0) {
    return [`${relativePath}: keryx:instructions block has no end marker`];
  }
  const block = content.slice(startIdx, endIdx + INSTRUCTIONS_END_MARKER.length);
  if (`${block}\n`.trim() !== renderInstructionsBlock().trim()) {
    return [`${relativePath}: keryx:instructions block is stale — re-run the install`];
  }
  return [];
}
