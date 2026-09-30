// Review, landing and discarding of a claude write run (flow 370). The contract
// is fixed here so the CLI (`keryx agents external review|apply|discard`) and the
// TUI modal build on the same functions.
//
// Landing never touches the operator's checkout: the stored patch is applied in a
// SECOND throwaway worktree cut from the recorded base commit, committed there with
// plumbing (no hooks, no signing, no trailers), and published as a new local branch
// `external/<runId>`. The current branch, HEAD, index and working tree are only ever
// read. A run is decided at most once: the decision file is created O_EXCL.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOwnerOnlyFileExclusive, readTranscriptFile } from "../../lib/config-dir";
import { withoutGitDiscoveryOverrides } from "../../lib/git-env";
import { sessionDir } from "../../session/paths";
import { EXTERNAL_RUN_PROVIDER_PREFIX, findSession, listSessions, type SessionSummary } from "../../session/store";
import { createGitWorktreePort } from "../child/git-worktree-port";
import { EXTERNAL_WRITE_PATCH_FILE, loadExternalWriteRunOf, type ExternalWriteRunRecord } from "./write-run";

export type LandRefusal =
  | "not-found"
  | "not-pending"
  | "patch-missing"
  | "hash-mismatch"
  | "redacted"
  | "binary"
  | "flagged"
  | "branch-exists"
  | "apply-failed";

export type LandResult =
  | { readonly kind: "landed"; readonly branch: string; readonly commit: string }
  | { readonly kind: "refused"; readonly reason: LandRefusal; readonly detail: string };

export type DiscardResult =
  | { readonly kind: "discarded" }
  | { readonly kind: "refused"; readonly reason: "not-found" | "not-pending"; readonly detail: string };

export interface WriteRunView {
  readonly record: ExternalWriteRunRecord;
  /** The stored redacted patch, only when its sha256 equals `record.patchHash`. Absent for a refused run or a tampered file. */
  readonly patch?: string;
}

/** Runs one git command and returns stdout; rejects with git's own message. `input` goes to stdin. */
export type WriteLandGit = (args: readonly string[], cwd: string, input?: string) => Promise<string>;

export interface WriteLandDeps {
  readonly dataDir?: string;
  /** Git runner (tests). Defaults to the real `git` with the discovery overrides stripped. */
  readonly git?: WriteLandGit;
  /** Directory the second throwaway worktree is created under. Defaults to a fresh temp dir removed afterwards. */
  readonly worktreesDir?: string;
}

/** The decision file inside a run's session directory. */
export const EXTERNAL_WRITE_DECISION_FILE = "external-write-decision.json";

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

const defaultGit: WriteLandGit = (args, cwd, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [...args],
      { cwd, env: withoutGitDiscoveryOverrides(process.env), maxBuffer: MAX_GIT_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        const detail = stderr.trim();
        reject(new Error(detail.length > 0 ? detail : error.message));
      },
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input ?? "");
  });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface LocatedRun {
  readonly record: ExternalWriteRunRecord;
  readonly dir: string;
  readonly decided: boolean;
}

function locateSummary(summary: SessionSummary, dataDir?: string): LocatedRun | undefined {
  const record = loadExternalWriteRunOf(summary, dataDir);
  if (record === undefined) return undefined;
  const dir = sessionDir(summary.projectPath, summary.id, dataDir);
  return { record, dir, decided: existsSync(path.join(dir, EXTERNAL_WRITE_DECISION_FILE)) };
}

function locate(cwd: string, runIdOrPrefix: string, dataDir?: string): LocatedRun | undefined {
  const summary = findSession(cwd, runIdOrPrefix, dataDir);
  return summary === undefined ? undefined : locateSummary(summary, dataDir);
}

/** Runs still waiting for a human decision in this checkout: state `pending-review` and no decision file. Newest first. */
export function listPendingWriteRuns(cwd: string, deps: WriteLandDeps = {}): ExternalWriteRunRecord[] {
  const pending: ExternalWriteRunRecord[] = [];
  // One session scan, then a direct read per external run: the sidebar polls this.
  for (const summary of listSessions(cwd, deps.dataDir)) {
    if (summary.provider?.startsWith(EXTERNAL_RUN_PROVIDER_PREFIX) !== true) continue;
    const located = locateSummary(summary, deps.dataDir);
    if (located === undefined || located.decided || located.record.state !== "pending-review") continue;
    pending.push(located.record);
  }
  return pending.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/** The stored patch when it is readable and hashes to `record.patchHash`; otherwise why not. */
function readVerifiedPatch(dir: string, record: ExternalWriteRunRecord): { ok: true; text: string } | { ok: false; reason: "patch-missing" | "hash-mismatch"; detail: string } {
  const read = readTranscriptFile(path.join(dir, EXTERNAL_WRITE_PATCH_FILE));
  if (!read.ok) return { ok: false, reason: "patch-missing", detail: `the stored patch cannot be read (${read.reason})` };
  if (record.patchHash === undefined || sha256Hex(read.text) !== record.patchHash) {
    return { ok: false, reason: "hash-mismatch", detail: "the stored patch no longer matches the hash recorded for it" };
  }
  return { ok: true, text: read.text };
}

/** One run with its verified patch, or undefined when there is no such run. */
export function viewWriteRun(cwd: string, runIdOrPrefix: string, deps: WriteLandDeps = {}): WriteRunView | undefined {
  const located = locate(cwd, runIdOrPrefix, deps.dataDir);
  if (located === undefined) return undefined;
  const patch = readVerifiedPatch(located.dir, located.record);
  return patch.ok ? { record: located.record, patch: patch.text } : { record: located.record };
}

function refuse(reason: LandRefusal, detail: string): LandResult {
  return { kind: "refused", reason, detail };
}

function decisionBody(decision: Record<string, string>): string {
  return `${JSON.stringify({ ...decision, at: new Date().toISOString() }, null, 2)}\n`;
}

/**
 * Land the run as the new local branch `external/<runId>` (one commit, cut from the recorded
 * base commit in a second throwaway worktree). `confirmedPatchHash` is the hash the human was
 * shown and typed back; anything else lands nothing. The current branch and the working tree
 * are never touched. A run lands at most once.
 */
export async function landWriteRun(
  input: { readonly cwd: string; readonly runId: string; readonly confirmedPatchHash: string; readonly allowFlagged?: boolean },
  deps: WriteLandDeps = {},
): Promise<LandResult> {
  const located = locate(input.cwd, input.runId, deps.dataDir);
  if (located === undefined) return refuse("not-found", `no external write run "${input.runId}" in this checkout`);
  const { record, dir } = located;
  if (record.state !== "pending-review" || located.decided) {
    return refuse("not-pending", record.state === "refused" ? "the run was refused at capture; it can only be discarded" : "the run was already decided");
  }
  const patch = readVerifiedPatch(dir, record);
  if (!patch.ok) return refuse(patch.reason, patch.detail);
  if (input.confirmedPatchHash !== record.patchHash) {
    return refuse("hash-mismatch", "the confirmed hash is not the hash of the stored patch");
  }
  if (record.redacted) {
    return refuse("redacted", "the stored patch was altered by redaction, so landing it would land content the agent did not write");
  }
  const binary = record.files.filter((file) => file.binary === true).map((file) => file.path);
  if (binary.length > 0) {
    return refuse("binary", `binary content is not carried by the patch: ${binary.join(", ")}`);
  }
  if (record.flaggedPaths.length > 0 && input.allowFlagged !== true) {
    return refuse("flagged", `the run changes flagged paths (${record.flaggedPaths.join(", ")}); allow them explicitly to land`);
  }

  const git = deps.git ?? defaultGit;
  const repo = record.projectRoot;
  const branch = `external/${record.runId}`;
  try {
    await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo);
    return refuse("branch-exists", `branch ${branch} already exists`);
  } catch {
    // Not found is the expected answer.
  }

  const ownedDir = deps.worktreesDir === undefined ? await mkdtemp(path.join(tmpdir(), "keryx-external-land-")) : undefined;
  const worktreesDir = deps.worktreesDir ?? (ownedDir as string);
  const port = createGitWorktreePort({ repoRoot: repo, worktreesDir, ref: record.baseCommit });
  const worktreeId = `land-${record.runId}`;
  let createdBranch = false;
  try {
    const worktree = await port.create(worktreeId);
    await git(["apply", "--check", "--index", "-"], worktree.path, patch.text);
    await git(["apply", "--index", "-"], worktree.path, patch.text);
    const tree = (await git(["write-tree"], worktree.path)).trim();
    const message = `External write run ${record.runId} (${record.agentId})`;
    const commit = (await git(["commit-tree", tree, "-p", record.baseCommit, "-m", message], worktree.path)).trim();
    await git(["branch", branch, commit], repo);
    createdBranch = true;
    const won = createOwnerOnlyFileExclusive(
      path.join(dir, EXTERNAL_WRITE_DECISION_FILE),
      decisionBody({ decision: "landed", branch, commit }),
    );
    if (!won) {
      await git(["branch", "-D", branch], repo).catch(() => undefined);
      createdBranch = false;
      return refuse("not-pending", "the run was decided by someone else while it was being landed");
    }
    return { kind: "landed", branch, commit };
  } catch (error) {
    if (createdBranch) await git(["branch", "-D", branch], repo).catch(() => undefined);
    return refuse("apply-failed", errorMessage(error));
  } finally {
    await port.remove(worktreeId).catch(() => undefined);
    if (ownedDir !== undefined) await rm(ownedDir, { recursive: true, force: true }).catch(() => undefined);
    else await rm(path.join(worktreesDir, worktreeId), { recursive: true, force: true }).catch(() => undefined);
    await git(["worktree", "prune"], repo).catch(() => undefined);
  }
}

/** Record a discard decision and delete the stored patch. A landed or already discarded run cannot be discarded. */
export function discardWriteRun(input: { readonly cwd: string; readonly runId: string }, deps: WriteLandDeps = {}): DiscardResult {
  const located = locate(input.cwd, input.runId, deps.dataDir);
  if (located === undefined) return { kind: "refused", reason: "not-found", detail: `no external write run "${input.runId}" in this checkout` };
  const won = createOwnerOnlyFileExclusive(path.join(located.dir, EXTERNAL_WRITE_DECISION_FILE), decisionBody({ decision: "discarded" }));
  if (!won) return { kind: "refused", reason: "not-pending", detail: "the run was already decided" };
  // The decision is what blocks a landing; a patch file that cannot be deleted stays inert.
  try {
    rmSync(path.join(located.dir, EXTERNAL_WRITE_PATCH_FILE), { force: true });
  } catch {
    // Left in place; the decision file already keeps it from ever landing.
  }
  return { kind: "discarded" };
}
