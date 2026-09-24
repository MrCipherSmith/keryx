import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderProjectMetaprojectReferenceBlock } from "../lib/agent-entrypoint-blocks";
import { pathExists } from "../lib/fs";
import { refuseEscapingSymlink, SymlinkRefusedError } from "../lib/symlink-safety";
import {
  renderAgentEntrypoint,
  renderImportedAgentRules,
  renderProjectRulesSkillReadme,
} from "../lib/templates";

// Review round 2 fix (R1-F20 remainder): re-exported so callers that only
// import from `./agent-entrypoints` (this module's own public surface) can
// still catch the symlink refusal without a second import of
// `../lib/symlink-safety` — mirrors `markdown-block.ts`'s re-export of the
// same class.
export { SymlinkRefusedError };

/**
 * Review round 1, F7: thrown by `ensureMetaprojectReference` (via
 * `replaceManagedBlock`) when `filePath` carries a `<!-- keryx:index -->`
 * start marker with no matching `<!-- /keryx:index -->` end marker — the
 * file is left COMPLETELY UNTOUCHED (never guessed at, never truncated).
 * Before this fix the missing-end-marker case truncated the file from the
 * start marker to EOF, which is exactly what a forged start marker (e.g. a
 * canonical rule file literally named `<!-- keryx:index -->.md`, imported
 * verbatim by `syncAgentRules`) could trigger, deleting every human line
 * after it. Mirrors `markdown-block.ts`'s `UnterminatedInstructionsBlockError`
 * — same "refuse hard" idiom, a distinct class because this module's marker
 * pair (`keryx:index`) and callers (`syncAgentRules`/`distillAgentEntrypoints`,
 * `keryx init`/`update`) are independent of that one.
 */
export class UnterminatedMetaprojectReferenceError extends Error {}

export type SyncedAgentRule = {
  source: string;
  ruleFile: string;
  priority: "high";
  version: "1.0.0";
};

export type SyncAgentRulesOptions = {
  enableTasks?: boolean;
  manifestSources?: string[];
  createDefault?: boolean;
};

export async function syncAgentRules(
  projectRoot: string,
  metaprojectRoot: string,
  options: SyncAgentRulesOptions = {},
): Promise<SyncedAgentRule[]> {
  const entrypoints = await findAgentEntrypoints(projectRoot, options.manifestSources ?? []);
  const sources =
    options.createDefault === false
      ? entrypoints
      : await ensureDefaultAgentEntrypoints(projectRoot, entrypoints);

  // Review round 2 fix (R2-F15): validate EVERY existing entrypoint BEFORE
  // scaffolding `.metaproject/rules` and `.metaproject/skills/project-rules`
  // (below) or writing anything for an earlier source in `sources` — a
  // symlink escaping the project, or a `<!-- keryx:index -->` mentioned only
  // in prose (never a real, paired block), used to be discovered mid-loop,
  // leaving a half-built `.metaproject/` behind and earlier sources already
  // rewritten. Checking every source up front means the first bad file aborts
  // the WHOLE sync before any of it starts, and the file it complains about
  // is always named in the error (`assertMetaprojectReferenceSafe`).
  const existingSources: Array<{ source: string; sourcePath: string }> = [];
  for (const source of sources) {
    const sourcePath = path.join(projectRoot, source);
    if (!(await pathExists(sourcePath))) continue;
    await assertMetaprojectReferenceSafe(projectRoot, source, sourcePath);
    existingSources.push({ source, sourcePath });
  }

  await mkdir(path.join(metaprojectRoot, "rules"), { recursive: true });
  await mkdir(path.join(metaprojectRoot, "skills", "project-rules"), { recursive: true });

  const synced: SyncedAgentRule[] = [];
  for (const { source, sourcePath } of existingSources) {
    await ensureMetaprojectReference(sourcePath, {
      ...(options.enableTasks === undefined ? {} : { enableTasks: options.enableTasks }),
      root: projectRoot,
    });
    const ruleFile = ruleFileNameFor(source);
    const sourceContent = await readFile(sourcePath, "utf8");
    await writeTextIfChanged(
      path.join(metaprojectRoot, "rules", ruleFile),
      renderImportedAgentRules({ source, content: sourceContent }),
    );
    synced.push({ source, ruleFile, priority: "high", version: "1.0.0" });
  }

  await writeTextIfChanged(
    path.join(metaprojectRoot, "skills", "project-rules", "README.md"),
    renderProjectRulesSkillReadme({ sources: synced.map((rule) => rule.source) }),
  );

  return synced;
}

const METAPROJECT_REFERENCE_MARKER = "<!-- keryx:index -->";
const METAPROJECT_REFERENCE_END_MARKER = "<!-- /keryx:index -->";

/**
 * Review round 2 fix (R2-F15): the pre-scaffold check `syncAgentRules` runs
 * for every existing entrypoint before touching disk. Refuses (naming
 * `sourcePath`) when a symlink on the path from `projectRoot` resolves
 * outside it, or when the marker pairing itself is broken — WITHOUT writing
 * anything, so the whole sync can be aborted before any of it starts.
 */
async function assertMetaprojectReferenceSafe(projectRoot: string, source: string, sourcePath: string): Promise<void> {
  const symlinkRefusal = await refuseEscapingSymlink(projectRoot, source);
  if (symlinkRefusal) throw new SymlinkRefusedError(`${sourcePath}: ${symlinkRefusal}`);

  const content = await readFile(sourcePath, "utf8");
  assertMarkerPairingSafe(content, sourcePath, METAPROJECT_REFERENCE_MARKER, METAPROJECT_REFERENCE_END_MARKER);
}

/**
 * Review round 2 fix (R2-F15): `marker`/`endMarker` must each be matched as a
 * WHOLE LINE (its trimmed content, ignoring a trailing `\r`, equals the
 * marker exactly) — never a mere substring. Before this fix, a rule file
 * that only MENTIONS `<!-- keryx:index -->` in prose (documenting the
 * marker, not using it) read as "has a start marker", found no matching end
 * marker anywhere else in the file, and refused the whole operation with a
 * message that never named which file was at fault.
 */
function hasMarkerLine(content: string, marker: string): boolean {
  return indexOfMarkerLine(content, marker) >= 0;
}

/** The character offset of the first LINE whose trimmed content equals `marker` exactly, or -1. */
function indexOfMarkerLine(content: string, marker: string): number {
  const lines = content.split("\n");
  let offset = 0;
  for (const line of lines) {
    if (line.trim() === marker) return offset;
    offset += line.length + 1;
  }
  return -1;
}

function assertMarkerPairingSafe(content: string, filePath: string, marker: string, endMarker: string): void {
  const start = indexOfMarkerLine(content, marker);
  if (start < 0) return;
  const afterStart = content.slice(start + marker.length);
  if (indexOfMarkerLine(afterStart, endMarker) < 0) {
    throw new UnterminatedMetaprojectReferenceError(
      `${filePath}: unterminated ${marker} block: found ${marker} with no matching ${endMarker} — fix it by hand`,
    );
  }
}

export async function ensureMetaprojectReference(
  filePath: string,
  options: { enableTasks?: boolean; root?: string } = {},
): Promise<void> {
  // Review round 2 fix (R1-F20 remainder): refuse (rather than write through)
  // a symlink on `filePath`'s path that resolves outside `options.root` — the
  // project root every in-repo caller (`syncAgentRules`, `distill.ts`) knows
  // and passes. When `root` is omitted (a caller with no notion of a project
  // boundary, e.g. a direct unit test on a bare temp file) this check is
  // skipped rather than guessed at.
  if (options.root !== undefined) {
    const relativePath = path.relative(options.root, filePath);
    const symlinkRefusal = await refuseEscapingSymlink(options.root, relativePath);
    if (symlinkRefusal) throw new SymlinkRefusedError(`${filePath}: ${symlinkRefusal}`);
  }

  const content = await readFile(filePath, "utf8");
  const marker = METAPROJECT_REFERENCE_MARKER;
  const endMarker = METAPROJECT_REFERENCE_END_MARKER;
  const block = renderProjectMetaprojectReferenceBlock({ enableTasks: options.enableTasks !== false });
  if (hasMarkerLine(content, marker)) {
    const next = replaceManagedBlock(content, filePath, marker, endMarker, block);
    if (next !== content) {
      await writeFile(filePath, next, "utf8");
    }

    return;
  }

  await writeFile(filePath, insertMetaprojectBlockNearTop(content, block), "utf8");
}

export function ruleFileNameFor(source: string): string {
  return `${source.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.md`;
}

async function findAgentEntrypoints(projectRoot: string, manifestSources: string[]): Promise<string[]> {
  const candidates = [...new Set([...manifestSources, "AGENTS.md", "agents.md", "CLAUDE.md", "claude.md"])];
  let files: Set<string>;
  try {
    files = new Set(await readdir(projectRoot));
  } catch {
    return [];
  }

  const existing: string[] = [];
  const seenRealPaths = new Set<string>();
  for (const candidate of candidates) {
    if (!files.has(candidate)) {
      continue;
    }
    const candidatePath = path.join(projectRoot, candidate);
    const resolved = await realpath(candidatePath);
    if (seenRealPaths.has(resolved)) {
      continue;
    }
    seenRealPaths.add(resolved);
    existing.push(candidate);
  }
  return existing;
}

async function ensureDefaultAgentEntrypoints(projectRoot: string, entrypoints: string[]): Promise<string[]> {
  const sources = [...entrypoints];
  for (const source of ["AGENTS.md", "CLAUDE.md"]) {
    if (!sources.includes(source)) {
      await writeTextIfMissing(path.join(projectRoot, source), renderAgentEntrypoint({ source }));
      sources.push(source);
    }
  }
  return sources;
}

function replaceManagedBlock(content: string, filePath: string, marker: string, endMarker: string, block: string): string {
  // Review round 2 fix (R2-F15): both markers are matched as whole LINES
  // (`indexOfMarkerLine`), never as a bare substring — a prose sentence that
  // merely quotes `<!-- keryx:index -->` (documenting it, rather than using
  // it) must not be mistaken for a real marker on either end.
  const start = indexOfMarkerLine(content, marker);
  if (start < 0) {
    return content;
  }
  const searchFrom = start + marker.length;
  const endOffset = indexOfMarkerLine(content.slice(searchFrom), endMarker);
  if (endOffset < 0) {
    // Review round 1, F7: this used to return
    // `content.slice(0, start) + block`, silently DROPPING everything from
    // the start marker to EOF — including real human content after a start
    // marker that has no matching end (a forged marker planted via a rule
    // file's own name is one way to reach this; a manual edit that deleted
    // only the end marker is another). Refuse instead, leaving `content`
    // (and therefore the file on disk — see `ensureMetaprojectReference`)
    // completely untouched. Review round 2, F15: name `filePath` in the
    // message — before this fix, a caller with several entrypoints (e.g.
    // `keryx init` scaffolding both AGENTS.md and CLAUDE.md) had no way to
    // tell which file the refusal was about.
    throw new UnterminatedMetaprojectReferenceError(
      `${filePath}: unterminated ${marker} block: found ${marker} with no matching ${endMarker} — fix it by hand`,
    );
  }
  const end = searchFrom + endOffset;
  return `${content.slice(0, start)}${block}${content.slice(end + endMarker.length)}`.replace(/\n{3,}/g, "\n\n");
}

function insertMetaprojectBlockNearTop(content: string, block: string): string {
  const normalizedBlock = block.endsWith("\n") ? block : `${block}\n`;
  const lines = content.split("\n");
  let insertAt = 0;

  if (lines[0] === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line === "---");
    if (end >= 0) {
      insertAt = end + 1;
      while (lines[insertAt] === "") {
        insertAt += 1;
      }
    }
  }

  if (/^#\s+/.test(lines[insertAt] ?? "")) {
    insertAt += 1;
  }

  while (lines[insertAt] === "") {
    insertAt += 1;
  }

  const before = lines.slice(0, insertAt).join("\n");
  const after = lines.slice(insertAt).join("\n");
  const prefix = before.length > 0 ? `${before}\n\n` : "";
  const suffix = after.length > 0 ? `\n${after}` : "";
  return `${prefix}${normalizedBlock}${suffix}`;
}

async function writeTextIfMissing(filePath: string, content: string): Promise<void> {
  if (await pathExists(filePath)) {
    return;
  }
  await writeFile(filePath, content, "utf8");
}

async function writeTextIfChanged(filePath: string, content: string): Promise<void> {
  if (await pathExists(filePath)) {
    const existing = await readFile(filePath, "utf8");
    if (existing === content) {
      return;
    }
  }
  await writeFile(filePath, content, "utf8");
}
