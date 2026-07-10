import { gitCmd } from "./provenance";

// What changed between a recorded build commit and now. `added`/`modified`/
// `deleted` are repo-relative paths — the "what to add / change / delete" the
// sync (and its hooks) act on. Renames split into a delete (old) + add (new).
export interface SyncDiff {
  added: string[];
  modified: string[];
  deleted: string[];
}

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|h|cc|cpp|hpp|cs|swift|kt|scala|sh|vue|svelte)$/;

export function isCodeFile(file: string): boolean {
  return CODE_EXT.test(file);
}

export function emptyDiff(): SyncDiff {
  return { added: [], modified: [], deleted: [] };
}

export function totalChanges(diff: SyncDiff): number {
  return diff.added.length + diff.modified.length + diff.deleted.length;
}

// Parse `git diff --name-status` output into a SyncDiff.
export function parseNameStatus(output: string): SyncDiff {
  const diff = emptyDiff();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split(/\t/);
    const status = parts[0] ?? "";
    if (status.startsWith("A")) {
      if (parts[1]) diff.added.push(parts[1]);
    } else if (status.startsWith("D")) {
      if (parts[1]) diff.deleted.push(parts[1]);
    } else if (status.startsWith("R")) {
      // rename: "R<score>\t<old>\t<new>"
      if (parts[1]) diff.deleted.push(parts[1]);
      if (parts[2]) diff.added.push(parts[2]);
    } else if (status.startsWith("C")) {
      // copy: "C<score>\t<old>\t<new>" — the new path is added
      if (parts[2]) diff.added.push(parts[2]);
    } else {
      // M, T, U, …
      if (parts[1]) diff.modified.push(parts[1]);
    }
  }
  return diff;
}

// Compute the diff of the working tree + HEAD against `base` (a commit sha/ref).
// Returns null when git can't answer (not a repo, unknown base). Includes both
// committed changes since base AND uncommitted working-tree changes.
export async function diffSince(cwd: string, base: string): Promise<SyncDiff | null> {
  const output = await gitCmd(cwd, ["diff", "--name-status", base]);
  if (output === null) {
    return null;
  }
  return parseNameStatus(output);
}

// Restrict a diff to source-code files (the ones the graph/wiki actually track).
export function codeOnly(diff: SyncDiff): SyncDiff {
  return {
    added: diff.added.filter(isCodeFile),
    modified: diff.modified.filter(isCodeFile),
    deleted: diff.deleted.filter(isCodeFile),
  };
}
