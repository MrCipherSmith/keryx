// The pure, OpenTUI-free half of `external-diff-modal.ts`: its deps, result texts and the read-only
// `/external-diff` list the readline shell and the ACP `shell` profile print. The modal re-exports it.

import { discardWriteRun, landWriteRun, listPendingWriteRuns, viewWriteRun, type DiscardResult, type LandResult, type WriteRunView } from "../harness/external/write-land";
import type { ExternalWriteRunRecord, WriteRunFile } from "../harness/external/write-run";
import { terminalSafe } from "../lib/terminal-safe";


export const EXTERNAL_DIFF_COMMAND = "/external-diff";
export const EXTERNAL_DIFF_TITLE = "External write review";
/** How many characters of the patch hash the operator has to type back. */
export const HASH_PREFIX_LENGTH = 12;

export function isExternalDiffCommand(line: string): boolean {
  return (line.trim().split(/\s+/)[0] ?? "") === EXTERNAL_DIFF_COMMAND;
}


/** The four calls the modal makes; tests inject fakes, the shell uses {@link defaultExternalDiffDeps}. */
export interface ExternalDiffDeps {
  list(): readonly ExternalWriteRunRecord[];
  view(runId: string): WriteRunView | undefined;
  land(input: { runId: string; confirmedPatchHash: string; allowFlagged: boolean }): Promise<LandResult>;
  discard(runId: string): DiscardResult;
}

export function defaultExternalDiffDeps(cwd: string): ExternalDiffDeps {
  return {
    list: () => listPendingWriteRuns(cwd),
    view: (runId) => viewWriteRun(cwd, runId),
    land: ({ runId, confirmedPatchHash, allowFlagged }) =>
      landWriteRun({ cwd, runId, confirmedPatchHash, ...(allowFlagged ? { allowFlagged: true } : {}) }),
    discard: (runId) => discardWriteRun({ cwd, runId }),
  };
}

/** Paths and patch lines come from an agent's worktree: never let them drive the terminal. */
export function clean(text: string): string {
  return terminalSafe(text.replace(/\r/g, "").replace(/\t/g, "  ")).text;
}

export const shortId = (runId: string): string => clean(runId).slice(0, 8);

export const NOTHING_APPLIED = "Nothing was applied to your current branch or working tree.";

export function landResultText(result: LandResult): string {
  if (result.kind === "landed") {
    return `Applied as branch ${clean(result.branch)} at commit ${clean(result.commit)}. ${NOTHING_APPLIED}`;
  }
  return `Not applied (${result.reason}): ${clean(result.detail)} ${NOTHING_APPLIED}`;
}

export function discardResultText(result: DiscardResult, runId: string): string {
  if (result.kind === "discarded") return `Discarded run ${shortId(runId)}. Its stored patch was deleted.`;
  return `Not discarded (${result.reason}): ${clean(result.detail)}`;
}

export function errorText(error: unknown): string {
  return clean(error instanceof Error ? error.message : String(error));
}

/** Flagged paths first, each marked; flagged paths the file list does not carry are still shown. */
export function orderedFiles(record: ExternalWriteRunRecord): Array<{ file: WriteRunFile | undefined; path: string; flagged: boolean }> {
  const flagged = new Set(record.flaggedPaths);
  const known = new Set(record.files.map((file) => file.path));
  const entries = record.files.map((file) => ({ file: file as WriteRunFile | undefined, path: file.path, flagged: flagged.has(file.path) }));
  for (const path of record.flaggedPaths) {
    if (!known.has(path)) entries.push({ file: undefined, path, flagged: true });
  }
  return [...entries.filter((entry) => entry.flagged), ...entries.filter((entry) => !entry.flagged)];
}

export function fileLine(entry: { file: WriteRunFile | undefined; path: string; flagged: boolean }): string {
  const marker = entry.flagged ? "!! FLAGGED  " : "            ";
  const status = entry.file?.status ?? "changed";
  const binary = entry.file?.binary === true ? " (binary, content not shown)" : "";
  return `  ${marker}${status}  ${clean(entry.path)}${binary}`;
}

/** The read-only fallback for the readline REPL; it never lands anything. */
export function externalDiffSlashText(deps: Pick<ExternalDiffDeps, "list">): string {
  const lines: string[] = [];
  try {
    const runs = deps.list();
    if (runs.length === 0) {
      lines.push("No write runs are waiting for review.");
    } else {
      lines.push(`Write runs awaiting review (${runs.length}):`);
      for (const run of runs) {
        lines.push(`  ${clean(run.runId)}  ${clean(run.agentId)}  ${run.files.length} file(s)  ${run.flaggedPaths.length} flagged`);
      }
    }
  } catch (error) {
    lines.push(`Could not read the write runs: ${errorText(error)}`);
  }
  lines.push("Use keryx agents external review <run-id> and keryx agents external apply <run-id> in a terminal.");
  return `${lines.join("\n")}\n`;
}
