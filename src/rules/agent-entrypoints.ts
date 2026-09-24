import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { renderProjectMetaprojectReferenceBlock } from "../lib/agent-entrypoint-blocks";
import { pathExists } from "../lib/fs";
import { refuseEscapingSymlink, SymlinkRefusedError } from "../lib/symlink-safety";
import { mkdirContained, writeContained } from "../lib/contained-write";
import {
  renderAgentEntrypoint,
  renderImportedAgentRules,
  renderProjectRulesSkillReadme,
} from "../lib/templates";
import { computeFencedRanges, hasMarkerLine, indexOfMarkerLine } from "./marker-matching";

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

  // R1-F20: EVERY write below is contained against `projectRoot`, never
  // `metaprojectRoot` directly — `metaprojectRoot` is always
  // `<projectRoot>/.metaproject` (every in-repo caller constructs it that
  // way), but `writeContained`'s root is `realpath`'d and used as the
  // symlink-containment boundary. Containing against `metaprojectRoot`
  // itself means a `.metaproject` that is ITSELF a symlink (a cloned repo
  // shaped `.metaproject -> ../../.claude` is the reviewer's reproduction)
  // moves the whole boundary outside the project, so every write below
  // silently escaped through it. Routing the rel path as
  // `<metaprojectRel>/...` against `projectRoot` means the segment walk in
  // `refuseEscapingSymlink` inspects `.metaproject` itself, same as any
  // other segment, and refuses (`escaping-symlink`) the moment it resolves
  // outside `projectRoot`.
  const metaprojectRel = path.relative(projectRoot, metaprojectRoot).split(path.sep).join("/");
  await mkdirContained(projectRoot, `${metaprojectRel}/rules`);
  await mkdirContained(projectRoot, `${metaprojectRel}/skills/project-rules`);

  const synced: SyncedAgentRule[] = [];
  for (const { source, sourcePath } of existingSources) {
    await ensureMetaprojectReference(sourcePath, {
      ...(options.enableTasks === undefined ? {} : { enableTasks: options.enableTasks }),
      root: projectRoot,
    });
    const ruleFile = ruleFileNameFor(source);
    const sourceContent = await readFile(sourcePath, "utf8");
    await writeTextIfChanged(
      projectRoot,
      `${metaprojectRel}/rules/${ruleFile}`,
      renderImportedAgentRules({ source, content: sourceContent }),
    );
    synced.push({ source, ruleFile, priority: "high", version: "1.0.0" });
  }

  await writeTextIfChanged(
    projectRoot,
    `${metaprojectRel}/skills/project-rules/README.md`,
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
 * Round 4 fix (R2-F15 remainder): `marker`/`endMarker` matching (whole-line,
 * fence-aware) now comes from the ONE shared matcher `distill.ts` also uses
 * (`./marker-matching`) — see that module's header for why a second,
 * independently written copy is exactly the bug this closes. Before this
 * fix, this module's own whole-line-but-not-fence-aware copy let a fenced
 * WORKED EXAMPLE of the managed block (e.g. a rule file showing what
 * `<!-- keryx:index -->...<!-- /keryx:index -->` looks like) get matched as
 * the real block: `replaceManagedBlock` then overwrote the fenced example
 * with the live block (destroying the example) while the actual managed
 * block elsewhere in the file was left stale.
 */
function assertMarkerPairingSafe(content: string, filePath: string, marker: string, endMarker: string): void {
  const fenced = computeFencedRanges(content);
  const start = indexOfMarkerLine(content, marker, fenced);
  if (start < 0) return;
  const afterStart = content.slice(start + marker.length);
  if (indexOfMarkerLine(afterStart, endMarker, computeFencedRanges(afterStart)) < 0) {
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
      await writeManagedFile(filePath, next, options.root);
    }

    return;
  }

  await writeManagedFile(filePath, insertMetaprojectBlockNearTop(content, block), options.root);
}

/**
 * `writeContained`, but usable from a call site that only has an absolute
 * `filePath` — `ensureMetaprojectReference`'s callers do not all know a
 * project root (a direct unit test on a bare temp file, in particular). When
 * `root` IS given the write is contained against it, same as every other
 * write in this module; when it is not, `filePath`'s own parent directory
 * stands in as the containment root, which still gets the write its
 * atomicity and non-regular-file refusal — matching the symlink check
 * immediately above, which is likewise skipped only when `root` is omitted.
 */
async function writeManagedFile(filePath: string, content: string, root?: string): Promise<void> {
  if (root !== undefined) {
    await writeContained(root, path.relative(root, filePath), content);
    return;
  }
  await writeContained(path.dirname(filePath), path.basename(filePath), content);
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
    // R3-F14: `candidate` is a name `readdir` reported — it EXISTS as a
    // directory entry, but a dangling or cyclic symlink still throws a raw
    // ENOENT/ELOOP out of `realpath`, which used to escape this function
    // uncaught and crash the whole `sync`/`distill`/`init` call with no named
    // reason. Refused explicitly instead, naming the candidate and the
    // underlying code, so the caller sees exactly which entrypoint is broken
    // and why — the same "refuse hard, name the file" idiom every other
    // symlink problem in this module already uses.
    let resolved: string;
    try {
      resolved = await realpath(candidatePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new SymlinkRefusedError(
        `${candidatePath}: refuses a ${code === "ELOOP" ? "symlink cycle" : "dangling symlink"} at this entrypoint`,
      );
    }
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
      await writeTextIfMissing(projectRoot, source, renderAgentEntrypoint({ source }));
      sources.push(source);
    }
  }
  return sources;
}

function replaceManagedBlock(content: string, filePath: string, marker: string, endMarker: string, block: string): string {
  // Round 4 fix (R2-F15 remainder): both markers are matched as whole,
  // fence-aware LINES via the shared matcher (`./marker-matching`) — never
  // as a bare substring, and never a marker line sitting inside a fenced
  // code block (a worked example must not be mistaken for the real block on
  // either end).
  const fenced = computeFencedRanges(content);
  const start = indexOfMarkerLine(content, marker, fenced);
  if (start < 0) {
    return content;
  }
  const searchFrom = start + marker.length;
  const rest = content.slice(searchFrom);
  const endOffset = indexOfMarkerLine(rest, endMarker, computeFencedRanges(rest));
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

async function writeTextIfMissing(root: string, rel: string, content: string): Promise<void> {
  const filePath = path.join(root, ...rel.split("/"));
  if (await pathExists(filePath)) {
    return;
  }
  await writeContained(root, rel, content);
}

async function writeTextIfChanged(root: string, rel: string, content: string): Promise<void> {
  const filePath = path.join(root, ...rel.split("/"));
  if (await pathExists(filePath)) {
    const existing = await readFile(filePath, "utf8");
    if (existing === content) {
      return;
    }
  }
  await writeContained(root, rel, content);
}
