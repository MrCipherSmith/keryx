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

/**
 * Parse a unified-diff patch (as produced by `git diff` / consumed by
 * `git apply`) into its per-file target list. Pure; never throws — malformed
 * or non-diff input simply yields no targets.
 */
export function parsePatchTargets(patch: string): PatchTarget[] {
  const targets: PatchTarget[] = [];
  let pendingOld: string | undefined;
  for (const line of patch.split(/\r?\n/)) {
    const oldMatch = OLD_FILE_HEADER.exec(line);
    if (oldMatch) {
      pendingOld = stripDiffPathPrefix(oldMatch[1]!);
      continue;
    }
    const newMatch = NEW_FILE_HEADER.exec(line);
    if (newMatch === null || pendingOld === undefined) {
      continue;
    }
    const newPath = stripDiffPathPrefix(newMatch[1]!);
    const oldIsNull = pendingOld === "/dev/null";
    const newIsNull = newPath === "/dev/null";
    const path = newIsNull ? pendingOld : newPath;
    pendingOld = undefined;
    if (path.length === 0 || path === "/dev/null") {
      continue;
    }
    targets.push({ path, action: oldIsNull ? "create" : newIsNull ? "delete" : "modify" });
  }
  return targets;
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
