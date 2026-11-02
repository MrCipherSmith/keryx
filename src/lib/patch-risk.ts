// Patch-risk classification for `apply_patch` (ADR-0010) — the `write`-risk
// analog of `command-risk.ts`'s `classifyCommand`/`touchesAgentCredentials`.
// Reasons about a unified diff's TARGET PATHS only; never applies anything,
// never resolves a path against a real filesystem. Path CONFINEMENT
// (rejecting an escape from the project root) is a separate, harder boundary
// — see `interactive-tools.ts`'s `confineToRoot`, applied by the tool itself
// before any of this classifier's output is consulted. This module only
// decides how loudly to ask, exactly like `command-risk.ts` (ADR-0009):
// nothing here ever blocks on its own.

import { touchesAgentCredentials } from "./command-risk";

/** One file touched by a patch, and what the patch does to it. */
export interface PatchTarget {
  /** Target path as it appears in the diff (after stripping the `a/`/`b/` prefix). */
  path: string;
  action: "create" | "modify" | "delete";
}

const OLD_FILE_HEADER = /^--- (.+)$/;
const NEW_FILE_HEADER = /^\+\+\+ (.+)$/;

/**
 * Strip a unified-diff path down to its real target: drop a leading `a/`/`b/`
 * prefix (the `git diff`/`git apply -p1` convention this tool requires — see
 * specification.md §3.3), drop a trailing tab-separated timestamp some
 * non-git diff generators append, and pass `/dev/null` through unchanged.
 *
 * Known limitation, documented rather than silently wrong: a path containing
 * a literal space or that `git` quotes (rare — non-ASCII/control characters)
 * is not unquoted here. Worst case this classifier under-counts targets for
 * such a path; `git apply` itself still sees and confines the real path
 * correctly, so this is a heuristic gap in escalation loudness, never a
 * safety gap (same posture ADR-0009 documents for `command-risk.ts`).
 */
function stripDiffPathPrefix(raw: string): string {
  const withoutTimestamp = raw.split("\t")[0] ?? raw;
  const trimmed = withoutTimestamp.trim();
  if (trimmed === "/dev/null") {
    return trimmed;
  }
  return /^[ab]\//.test(trimmed) ? trimmed.slice(2) : trimmed;
}

const GIT_SECTION_HEADER = /^diff --git (.+)$/;
const DELETED_FILE_MODE = /^deleted file mode /;
const NEW_FILE_MODE = /^new file mode /;
const RENAME_FROM = /^rename from (.+)$/;
const RENAME_TO = /^rename to (.+)$/;
const COPY_TO = /^copy to (.+)$/;
const BINARY_DIFFERS = /^Binary files (.+) differ$/;

/** Both paths of a `diff --git a/<p> b/<q>` line; the shared path when the halves are identical. */
function gitHeaderPaths(rest: string): { oldPath: string; newPath: string } | undefined {
  const unquoted = rest.replace(/"/g, "");
  const half = (unquoted.length - 1) / 2;
  if (Number.isInteger(half) && unquoted[half] === " ") {
    const left = stripDiffPathPrefix(unquoted.slice(0, half));
    const right = stripDiffPathPrefix(unquoted.slice(half + 1));
    if (left === right) return { oldPath: left, newPath: right };
  }
  const split = /^(a\/.+?) (b\/.+)$/.exec(unquoted);
  if (split === null) return undefined;
  return { oldPath: stripDiffPathPrefix(split[1]!), newPath: stripDiffPathPrefix(split[2]!) };
}

/** What one `diff --git` section (or the header-less remainder of a plain diff) says about its files. */
interface PatchSection {
  git?: { oldPath: string; newPath: string };
  pendingOld: string | undefined;
  /** `---`/`+++` pairs; a header-less diff holds several in one section. */
  pairs: PatchTarget[];
  deleted: boolean;
  created: boolean;
  renameFrom?: string;
  renameTo?: string;
  copyTo?: string;
  binary: boolean;
}

function newSection(rest?: string): PatchSection {
  const git = rest === undefined ? undefined : gitHeaderPaths(rest);
  return { ...(git === undefined ? {} : { git }), pendingOld: undefined, pairs: [], deleted: false, created: false, binary: false };
}

/**
 * Everything a section changes. `git apply` acts on sections that carry no `---`/`+++` pair at all (a binary
 * deletion or replacement, a pure rename or copy, the deletion of an empty file, a mode change), so the extended
 * header lines count as targets too: a section the parser cannot see is a file the approval prompt never names.
 */
function sectionTargets(section: PatchSection): PatchTarget[] {
  const out: PatchTarget[] = [];
  out.push(...section.pairs);
  if (section.renameFrom !== undefined) out.push({ path: section.renameFrom, action: "delete" });
  const created = section.renameTo ?? section.copyTo;
  if (created !== undefined) out.push({ path: created, action: "create" });
  if (section.pairs.length === 0 && created === undefined && section.git !== undefined) {
    const path = section.deleted ? section.git.oldPath : section.git.newPath;
    if (path.length > 0 && path !== "/dev/null") {
      out.push({ path, action: section.deleted ? "delete" : section.created ? "create" : "modify" });
    }
  }
  return out;
}

/**
 * Parse a unified-diff patch (as produced by `git diff` / consumed by
 * `git apply`) into its per-file target list. Pure; never throws — malformed
 * or non-diff input simply yields no targets. Reads the `diff --git` extended
 * headers (`deleted file mode`, `rename from/to`, `copy to`, `Binary files …
 * differ`) as well as the `---`/`+++` pair, so a section with no hunk is seen.
 */
export function parsePatchTargets(patch: string): PatchTarget[] {
  const sections: PatchSection[] = [];
  let section = newSection();
  sections.push(section);
  for (const line of patch.split(/\r?\n/)) {
    const gitMatch = GIT_SECTION_HEADER.exec(line);
    if (gitMatch) {
      section = newSection(gitMatch[1]!);
      sections.push(section);
      continue;
    }
    const oldMatch = OLD_FILE_HEADER.exec(line);
    if (oldMatch) {
      section.pendingOld = stripDiffPathPrefix(oldMatch[1]!);
      continue;
    }
    const newMatch = NEW_FILE_HEADER.exec(line);
    if (newMatch !== null && section.pendingOld !== undefined) {
      const newPath = stripDiffPathPrefix(newMatch[1]!);
      const oldIsNull = section.pendingOld === "/dev/null";
      const newIsNull = newPath === "/dev/null";
      const path = newIsNull ? section.pendingOld : newPath;
      section.pendingOld = undefined;
      if (path.length > 0 && path !== "/dev/null") {
        section.pairs.push({ path, action: oldIsNull ? "create" : newIsNull ? "delete" : "modify" });
      }
      continue;
    }
    if (section.git === undefined) continue;
    if (DELETED_FILE_MODE.test(line)) section.deleted = true;
    else if (NEW_FILE_MODE.test(line)) section.created = true;
    else if (BINARY_DIFFERS.test(line)) section.binary = true;
    const rename = RENAME_FROM.exec(line);
    if (rename) section.renameFrom = stripDiffPathPrefix(rename[1]!);
    const renameTo = RENAME_TO.exec(line);
    if (renameTo) section.renameTo = stripDiffPathPrefix(renameTo[1]!);
    const copyTo = COPY_TO.exec(line);
    if (copyTo) section.copyTo = stripDiffPathPrefix(copyTo[1]!);
  }
  const targets: PatchTarget[] = [];
  for (const target of sections.flatMap(sectionTargets)) {
    if (!targets.some((t) => t.path === target.path && t.action === target.action)) targets.push(target);
  }
  return targets;
}

/**
 * Parse `apply_patch` tool input JSON (or a raw patch string) → the patch
 * text. Mirrors `shell-permissions.ts`'s `parseShellExecCommand` for the
 * approval-prompt rendering path (P2): the same "JSON object with the field,
 * or fall back to the raw string" shape.
 */
export function extractPatchText(inputJson: string): string {
  try {
    const parsed: unknown = JSON.parse(inputJson);
    if (parsed !== null && typeof parsed === "object" && typeof (parsed as { patch?: unknown }).patch === "string") {
      return (parsed as { patch: string }).patch;
    }
  } catch {
    // raw string
  }
  return inputJson;
}

/** Escalation threshold for "touches too many files in one call". An EXPEDIENT, not a boundary. */
export const MAX_FILES_BEFORE_ESCALATION = 8;

/** Result of {@link classifyPatchRisk}. */
export interface PatchRiskClassification {
  /** Escalation only (ADR-0009/ADR-0010 posture) — never a block on its own. */
  destructive: boolean;
  /** Hard floor, exactly like `ApprovalGateInput.credentials` for shell. */
  credentials: boolean;
  /** Human-readable reasons, surfaced in the approval prompt. */
  reasons: string[];
}

/**
 * `write`'s analog of `isDestructiveCommand`/`touchesAgentCredentials`.
 * `destructive` escalates (never blocks on its own) when the patch deletes
 * any file, touches `.git/` directly, or touches more than
 * {@link MAX_FILES_BEFORE_ESCALATION} distinct files in one call.
 * `credentials` reuses `touchesAgentCredentials` against the joined target
 * path list — same markers, same "matched on text" trade-off command-risk.ts
 * already accepts for the shell path. Pure.
 */
export function classifyPatchRisk(patch: string): PatchRiskClassification {
  const targets = parsePatchTargets(patch);
  const reasons: string[] = [];
  let destructive = false;

  const deleted = targets.filter((t) => t.action === "delete");
  if (deleted.length > 0) {
    destructive = true;
    reasons.push(`deletes ${deleted.length} file(s): ${deleted.map((t) => t.path).join(", ")}`);
  }

  const gitInternal = targets.filter((t) => t.path === ".git" || t.path.startsWith(".git/"));
  if (gitInternal.length > 0) {
    destructive = true;
    reasons.push(`touches .git internals directly: ${gitInternal.map((t) => t.path).join(", ")}`);
  }

  if (targets.length > MAX_FILES_BEFORE_ESCALATION) {
    destructive = true;
    reasons.push(`touches ${targets.length} files in one call (over ${MAX_FILES_BEFORE_ESCALATION})`);
  }

  const credentials = touchesAgentCredentials(targets.map((t) => t.path).join(" "));
  if (credentials) {
    reasons.push("touches the agent's own permission/credential files");
  }

  return { destructive, credentials, reasons };
}
