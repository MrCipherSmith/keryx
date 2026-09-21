import { gitCmd } from "./provenance";

// What changed between a recorded build commit and now. `added`/`modified`/
// `deleted` are repo-relative paths — the "what to add / change / delete" the
// sync (and its hooks) act on. Renames split into a delete (old) + add (new).
export interface SyncDiff {
  added: string[];
  modified: string[];
  deleted: string[];
}

// Flow 280 finding 2 (review of ce309d58): before ce309d58 a missing
// extension here only left an artifact stale (the per-module rebuild branch
// never fired, but nothing else claimed otherwise either). Since ce309d58,
// `codeOnly(diff)` also feeds `syncCommand`'s `totalChanges(code) === 0` fast
// path (`../commands/sync.ts`), so a missing extension now makes THAT path
// assert "no code changed" and advance provenance for a commit that DID
// change code — the opposite of stale. `.mts`/`.cts` (TypeScript's module-
// scoped variants — same syntax as `.ts`, just ESM/CJS-pinned) were missing
// and are added here.
//
// This list is deliberately broader than gdgraph's own `SOURCE_EXTENSIONS`
// (`../gdgraph/build.ts`): that one gates which files gdgraph's import-graph
// PARSER understands (currently TS/JS/Java/Python only) and staying narrow
// there is correct — claiming to parse imports out of a language the parser
// cannot read would be worse than skipping the file. `CODE_EXT` answers a
// different, looser question for every `SYNCED_MODULES` entry (gdgraph,
// gdwiki, memory): "is this file source code at all, such that a commit
// touching only files outside this set is safe to treat as a no-op for
// provenance purposes". A `.go`/`.rs`/`.vue` change is real code gdwiki and
// memory both care about even though gdgraph's parser does not walk it, so
// this set stays the wider one rather than being narrowed to match.
const CODE_EXT =
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|h|cc|cpp|hpp|cs|swift|kt|scala|sh|vue|svelte)$/;

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
