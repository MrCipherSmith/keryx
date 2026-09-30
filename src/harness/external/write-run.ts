// One external agent WRITE run and its durable, reviewable record (flow 370).
//
// `runExternalChild` (`./runtime.ts`) owns the gates, the prompt, the spawn and the
// disposable worktree. This module adds the one thing a write run needs on top:
// the worktree's diff, captured BEFORE the worktree is removed, redacted, hashed
// and stored under the session directory as a `pending-review` record. The patch
// is NEVER applied here; review, apply and discard are separate commands built on
// {@link loadExternalWriteRun}.
//
// The capture rides on the worktree port's `remove`, which `runExternalChild`
// calls in a `finally` on every exit path (success, timeout, crash, operator
// kill, a throwing spawn port). `remove` here always ends in the inner remove, so
// an exception while capturing cannot leak the worktree either.
//
// Captured through a throwaway index with git's own discovery pinned to the
// worktree (GIT_DIR/GIT_WORK_TREE resolved BEFORE the child ran), so a child that
// rewrites the worktree's `.git` file cannot redirect the diff at another repo.

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { readConfigFile, writeOwnerOnlyFile } from "../../lib/config-dir";
import { withoutGitDiscoveryOverrides } from "../../lib/git-env";
import { redactSensitiveText } from "../../security/service";
import { sessionDir } from "../../session/paths";
import { EXTERNAL_RUN_PROVIDER_PREFIX, createSession, findSession, persistHistory, type SessionSummary } from "../../session/store";
import { createGitWorktreePort } from "../child/git-worktree-port";
import type { CreatedWorktree, WorktreePort } from "../child/worktree";
import { ACP_PATCH_FILE } from "./acp-run";
import { runExternalChild, type ExternalChildOutcome, type ExternalCompletionStatus, type RunExternalChildDeps, type RunExternalChildInput } from "./runtime";

const execFileAsync = promisify(execFile);

/** The file inside the session directory holding the write-run record. */
export const EXTERNAL_WRITE_RUN_FILE = "external-write-run.json";
/** The patch keeps the ACP artifact's name so one reader handles both kinds of run. */
export const EXTERNAL_WRITE_PATCH_FILE = ACP_PATCH_FILE;

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

export type WriteRunFileStatus = "added" | "modified" | "deleted" | "mode-changed" | "type-changed";

/** One changed path. `binary` marks content the text patch can only note ("Binary files differ"), not carry. */
export interface WriteRunFile {
  readonly path: string;
  readonly status: WriteRunFileStatus;
  readonly binary?: true;
}

/**
 * `pending-review`: a patch is stored and nothing has been applied.
 * `refused`: a changed symlink resolves outside the worktree; NO patch is kept
 * (`patchPath`/`patchHash` are absent) and the run can only be discarded.
 */
export type ExternalWriteRunState = "pending-review" | "refused";

/** Everything a claude write run leaves on record, at `<session dir>/external-write-run.json`. */
export interface ExternalWriteRunRecord {
  /** The keryx session id this record lives in; what `keryx agents external review <run-id>` takes. */
  readonly runId: string;
  readonly agentId: string;
  /** HEAD of the operator's checkout when the run started; the worktree was created here. */
  readonly baseCommit: string;
  /** Absolute path of the redacted, never-applied patch. Absent when `state` is `refused`. */
  readonly patchPath?: string;
  /** sha256 hex of the redacted patch text exactly as stored. Absent when `state` is `refused`. */
  readonly patchHash?: string;
  readonly files: readonly WriteRunFile[];
  /** Changed paths under .git/, .github/, .claude/, .metaproject/ or with hook/CI names. Review must show these first. */
  readonly flaggedPaths: readonly string[];
  /** Changed symlinks whose target resolves outside the worktree. Non-empty implies `refused`. */
  readonly refusedPaths: readonly string[];
  readonly state: ExternalWriteRunState;
  /** True when redaction changed the patch text, so it may no longer apply byte for byte. */
  readonly redacted: boolean;
  /** How the child run itself ended; a record exists for any non-empty diff, whatever this says. */
  readonly runStatus: ExternalCompletionStatus;
  readonly projectRoot: string;
  readonly createdAt: string;
}

export interface CapturedWriteDiff {
  /** The unredacted patch text. Empty when nothing changed. */
  readonly patch: string;
  readonly files: readonly WriteRunFile[];
  /** Changed symlinks whose target resolves outside the worktree. */
  readonly refusedPaths: readonly string[];
}

// All entries are lower case: paths are compared lower-cased, because a case-insensitive
// checkout (macOS, Windows) treats `.Claude/` and `.claude/` as the same directory.
const FLAGGED_PREFIXES: readonly string[] = [
  ".git/",
  ".github/",
  ".claude/",
  ".metaproject/",
  ".husky/",
  ".githooks/",
  ".circleci/",
];

const FLAGGED_BASENAMES: ReadonlySet<string> = new Set([
  ".git",
  ".gitlab-ci.yml",
  ".travis.yml",
  "jenkinsfile",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml",
  "lefthook.yml",
  "lefthook.yaml",
  ".pre-commit-config.yaml",
  ".mcp.json",
  ".envrc",
  ".gitattributes",
  ".gitmodules",
]);

/** Editor config that runs tasks or changes tool behaviour; the rest of `.vscode/` is not flagged. */
const FLAGGED_SUFFIXES: readonly string[] = [".vscode/tasks.json", ".vscode/settings.json", ".vscode/launch.json"];

/** Changed paths a reviewer must look at first: repo plumbing, CI, hooks and agent config. Case-insensitive. */
export function flaggedPathsOf(paths: readonly string[]): string[] {
  return paths.filter((p) => {
    const normalized = p.replace(/^\.\//, "").toLowerCase();
    if (FLAGGED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true;
    // Nested copies count too: packages/x/.github/workflows/ci.yml is still CI.
    if (FLAGGED_PREFIXES.some((prefix) => normalized.includes(`/${prefix}`))) return true;
    if (FLAGGED_SUFFIXES.some((suffix) => normalized === suffix || normalized.endsWith(`/${suffix}`))) return true;
    return FLAGGED_BASENAMES.has(path.posix.basename(normalized));
  });
}

function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { ...withoutGitDiscoveryOverrides(process.env), ...extra };
}

async function git(args: readonly string[], cwd: string, env: Record<string, string>): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd, env, maxBuffer: MAX_GIT_OUTPUT_BYTES });
  return stdout;
}

/** HEAD of `repoRoot`, or undefined when it is not a git checkout with a commit. */
export async function resolveBaseCommit(repoRoot: string): Promise<string | undefined> {
  try {
    const out = (await git(["rev-parse", "--verify", "HEAD"], repoRoot, gitEnv())).trim();
    return /^[0-9a-f]{40,64}$/.test(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** True when the symlink at `relPath` (inside `worktreeRoot`) points anywhere outside it. Fail-closed on any read error. */
async function symlinkEscapes(worktreeRoot: string, relPath: string): Promise<boolean> {
  try {
    const realRoot = await realpath(worktreeRoot);
    const link = path.join(realRoot, relPath);
    const target = await readlink(link);
    const realParent = await realpath(path.dirname(link));
    const resolved = path.resolve(realParent, target);
    if (!isInside(realRoot, resolved)) return true;
    try {
      return !isInside(realRoot, await realpath(resolved));
    } catch (error) {
      // A dangling link that lexically stays inside the tree points at nothing outside it.
      return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  } catch {
    return true;
  }
}

interface RawEntry {
  readonly path: string;
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldSha: string;
  readonly newSha: string;
  readonly status: string;
}

function parseRaw(raw: string): RawEntry[] {
  const tokens = raw.split("\0");
  const out: RawEntry[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const meta = tokens[i] ?? "";
    const file = tokens[i + 1] ?? "";
    if (!meta.startsWith(":") || file.length === 0) continue;
    const [oldMode = "", newMode = "", oldSha = "", newSha = "", status = ""] = meta.slice(1).split(" ");
    out.push({ path: file, oldMode, newMode, oldSha, newSha, status: status.charAt(0) });
  }
  return out;
}

function statusOf(entry: RawEntry): WriteRunFileStatus {
  if (entry.status === "A") return "added";
  if (entry.status === "D") return "deleted";
  if (entry.status === "T") return "type-changed";
  if (entry.oldMode !== entry.newMode && entry.oldSha === entry.newSha) return "mode-changed";
  return "modified";
}

/** Paths git reports as binary (`-` line counts in `--numstat`). */
function parseBinaryPaths(numstat: string): Set<string> {
  const binary = new Set<string>();
  for (const record of numstat.split("\0")) {
    const match = /^-\t-\t(.+)$/s.exec(record);
    if (match?.[1] !== undefined) binary.add(match[1]);
  }
  return binary;
}

/**
 * The worktree's full change against `baseCommit`: tracked edits, new files
 * (ignored ones included, so a `.gitignore` edit cannot hide a file), deletions,
 * mode changes and binary files. Throws on any git failure — a diff that could not
 * be read must never look like "the agent changed nothing".
 */
export async function captureWriteDiff(input: {
  readonly worktreePath: string;
  readonly baseCommit: string;
  /** Resolved before the child ran; pins git to the worktree's real gitdir. */
  readonly gitDir?: string;
}): Promise<CapturedWriteDiff> {
  const indexDir = await mkdtemp(path.join(tmpdir(), "keryx-write-index-"));
  const env = gitEnv({
    GIT_INDEX_FILE: path.join(indexDir, "index"),
    ...(input.gitDir === undefined ? {} : { GIT_DIR: input.gitDir, GIT_WORK_TREE: input.worktreePath }),
  });
  const run = (args: readonly string[]) => git(args, input.worktreePath, env);
  const common = ["--cached", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv"] as const;
  try {
    await run(["read-tree", input.baseCommit]);
    await run(["add", "-A", "-f"]);
    const entries = parseRaw(await run(["diff", ...common, "--raw", "-z", input.baseCommit]));
    if (entries.length === 0) return { patch: "", files: [], refusedPaths: [] };
    const binary = parseBinaryPaths(await run(["diff", ...common, "--numstat", "-z", input.baseCommit]));
    const refusedPaths: string[] = [];
    for (const entry of entries) {
      if (entry.newMode === "120000" && entry.status !== "D" && (await symlinkEscapes(input.worktreePath, entry.path))) {
        refusedPaths.push(entry.path);
      }
    }
    const patch = await run(["diff", ...common, "--src-prefix=a/", "--dst-prefix=b/", input.baseCommit]);
    return {
      patch,
      files: entries.map((entry) => ({
        path: entry.path,
        status: statusOf(entry),
        ...(binary.has(entry.path) ? { binary: true as const } : {}),
      })),
      refusedPaths,
    };
  } finally {
    await rm(indexDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Deps of {@link runExternalWriteChild}: those of `runExternalChild`, with the worktree owned here. */
export interface ExternalWriteRunDeps extends Omit<RunExternalChildDeps, "worktree"> {
  /** The operator's checkout: the worktree is cut from its HEAD and the record is stored as a session of it. */
  readonly projectRoot: string;
  /** keryx data dir for the session record (tests). */
  readonly dataDir?: string;
  /** Directory the throwaway worktree is created under. Defaults to a fresh temp dir removed afterwards. */
  readonly worktreesDir?: string;
  /** Worktree port override (tests). Defaults to `createGitWorktreePort` at the recorded base commit. */
  readonly worktree?: WorktreePort;
  /** Diff capture seam (tests). Defaults to {@link captureWriteDiff}. */
  readonly capture?: typeof captureWriteDiff;
  /** Base commit override (tests). Defaults to HEAD of `projectRoot`. */
  readonly baseCommit?: string;
}

export interface ExternalWriteRunResult {
  readonly outcome: ExternalChildOutcome;
  /** Present when the run changed anything and the record could be stored. */
  readonly run?: ExternalWriteRunRecord;
  /** The run finished but its diff could not be captured. The worktree is gone; nothing was stored. */
  readonly captureError?: string;
  readonly persistError?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Run one claude agent in `worktree-write` mode and store its diff for review.
 *
 * The worktree is created at the recorded base commit, the child runs with it as
 * cwd, and the diff is captured and the worktree removed on every exit path. A
 * record is written for any non-empty diff regardless of how the run ended: a
 * timed-out run's half-finished edits are still work the operator may want to see.
 */
export async function runExternalWriteChild(
  input: RunExternalChildInput,
  deps: ExternalWriteRunDeps,
): Promise<ExternalWriteRunResult> {
  if (input.runtime.sandbox !== "worktree-write") {
    return { outcome: { status: "Error", output: 'runExternalWriteChild requires sandbox "worktree-write"', isError: true } };
  }
  const baseCommit = deps.baseCommit ?? (await resolveBaseCommit(deps.projectRoot));
  if (baseCommit === undefined) {
    return {
      outcome: {
        status: "Error",
        output: "write mode needs a git checkout with at least one commit to cut the throwaway worktree from",
        isError: true,
      },
    };
  }

  const ownedDir = deps.worktreesDir === undefined ? await mkdtemp(path.join(tmpdir(), "keryx-external-write-")) : undefined;
  const worktreesDir = deps.worktreesDir ?? (ownedDir as string);
  const inner = deps.worktree ?? createGitWorktreePort({ repoRoot: deps.projectRoot, worktreesDir, ref: baseCommit });
  const capture = deps.capture ?? captureWriteDiff;

  let worktreePath: string | undefined;
  let gitDir: string | undefined;
  let captured: CapturedWriteDiff | undefined;
  let captureError: string | undefined;
  let removeFailed = false;

  const wrapped: WorktreePort = {
    async create(worktreeId: string): Promise<CreatedWorktree> {
      const created = await inner.create(worktreeId);
      worktreePath = created.path;
      try {
        gitDir = (await git(["rev-parse", "--absolute-git-dir"], created.path, gitEnv())).trim();
      } catch {
        gitDir = undefined;
      }
      return created;
    },
    async remove(worktreeId: string): Promise<void> {
      try {
        if (worktreePath !== undefined) {
          captured = await capture({ worktreePath, baseCommit, ...(gitDir === undefined ? {} : { gitDir }) });
        }
      } catch (error) {
        captureError = errorMessage(error);
      }
      try {
        await inner.remove(worktreeId);
      } catch (error) {
        removeFailed = true;
        throw error;
      }
    },
    merge: (worktreeId, into) => inner.merge(worktreeId, into),
  };

  let outcome: ExternalChildOutcome;
  try {
    outcome = await runExternalChild(input, { ...deps, worktree: wrapped, ownsWriteCapture: true });
  } catch (error) {
    outcome = { status: "Error", output: `the external run failed: ${errorMessage(error)}`, isError: true };
  } finally {
    if (removeFailed) {
      await inner.remove(input.worktreeId).catch((error: unknown) => {
        deps.onWarning?.(`the throwaway worktree could not be removed: ${errorMessage(error)}`);
      });
    }
    if (ownedDir !== undefined) await rm(ownedDir, { recursive: true, force: true }).catch(() => undefined);
  }

  if (captureError !== undefined) return { outcome, captureError };
  if (captured === undefined || captured.files.length === 0) return { outcome };

  try {
    const run = persistWriteRun({
      projectRoot: deps.projectRoot,
      ...(deps.dataDir === undefined ? {} : { dataDir: deps.dataDir }),
      agentId: input.runtime.agent ?? "unknown",
      baseCommit,
      diff: captured,
      runStatus: outcome.status,
      prompt: input.taskDescription,
      assistantText: outcome.output,
    });
    return { outcome, run };
  } catch (error) {
    return { outcome, persistError: errorMessage(error) };
  }
}

/** Store one captured diff as a keryx session with its record. Redacts the patch, then hashes what was stored. */
function persistWriteRun(args: {
  readonly projectRoot: string;
  readonly dataDir?: string;
  readonly agentId: string;
  readonly baseCommit: string;
  readonly diff: CapturedWriteDiff;
  readonly runStatus: ExternalCompletionStatus;
  readonly prompt: string;
  readonly assistantText: string;
}): ExternalWriteRunRecord {
  const runId = randomUUID();
  const title = `External write ${args.agentId}: ${args.runStatus}`;
  const handle = createSession({
    cwd: args.projectRoot,
    ...(args.dataDir === undefined ? {} : { dataDir: args.dataDir }),
    id: runId,
    provider: `${EXTERNAL_RUN_PROVIDER_PREFIX}${args.agentId}`,
    title,
  });
  persistHistory(
    handle,
    [
      { role: "user", content: args.prompt, provenance: "trusted" },
      { role: "assistant", content: args.assistantText, provenance: "model" },
    ],
    { title },
  );

  const refused = args.diff.refusedPaths.length > 0;
  const redactedPatch = redactSensitiveText(args.diff.patch);
  const paths = args.diff.files.map((file) => file.path);
  const flagged = new Set([...flaggedPathsOf(paths), ...args.diff.refusedPaths]);
  let patchFields: { patchPath?: string; patchHash?: string } = {};
  if (!refused) {
    const patchPath = path.join(handle.dir, EXTERNAL_WRITE_PATCH_FILE);
    writeOwnerOnlyFile(patchPath, redactedPatch);
    patchFields = { patchPath, patchHash: sha256Hex(redactedPatch) };
  }
  const record: ExternalWriteRunRecord = {
    runId,
    agentId: args.agentId,
    baseCommit: args.baseCommit,
    ...patchFields,
    files: args.diff.files,
    flaggedPaths: paths.filter((p) => flagged.has(p)),
    refusedPaths: args.diff.refusedPaths,
    state: refused ? "refused" : "pending-review",
    redacted: redactedPatch !== args.diff.patch,
    runStatus: args.runStatus,
    projectRoot: handle.summary.projectPath,
    createdAt: handle.summary.createdAt,
  };
  writeOwnerOnlyFile(path.join(handle.dir, EXTERNAL_WRITE_RUN_FILE), JSON.stringify(record, null, 2));
  return record;
}

/** Load a stored write-run record by run id (or unique prefix). Undefined when there is none. */
export function loadExternalWriteRun(cwd: string, runIdOrPrefix: string, dataDir?: string): ExternalWriteRunRecord | undefined {
  const summary = findSession(cwd, runIdOrPrefix, dataDir);
  if (summary === undefined) return undefined;
  return loadExternalWriteRunOf(summary, dataDir);
}

/** The record stored in one already-resolved session; no session scan. Undefined when it has none or it is unreadable. */
export function loadExternalWriteRunOf(summary: Pick<SessionSummary, "id" | "projectPath">, dataDir?: string): ExternalWriteRunRecord | undefined {
  const file = path.join(sessionDir(summary.projectPath, summary.id, dataDir), EXTERNAL_WRITE_RUN_FILE);
  const read = readConfigFile(file);
  if (!read.ok) return undefined;
  try {
    const parsed = JSON.parse(read.text) as Partial<ExternalWriteRunRecord>;
    if (typeof parsed.runId !== "string" || typeof parsed.baseCommit !== "string" || !Array.isArray(parsed.files)) return undefined;
    return parsed as ExternalWriteRunRecord;
  } catch {
    return undefined;
  }
}
