// CI run/job read port for CI failure triage — flow 306, PRD.md Requirement
// 20 / PLAN.md Phase 1. Narrow, following the live/fixture split `GitHubPort`
// already establishes (`createGhPort`/`createFixturePort`, `./pr-comments.ts`):
// a live `gh` adapter with no logic beyond parsing, and a fixture adapter that
// answers from data supplied on disk, so the whole triage pipeline is
// exercised offline with no network and no real pull request.
//
// AC9 (advisory only — no rerun, no status-check write, no merge call): this
// is a property of the TYPE, not a convention someone has to remember.
// `CiPort` has exactly three methods, all reads (`runInfo`, `failedLog`,
// `recentRuns`); there is no write method to call, so no code path built on
// this port can rerun a job, touch a status check, or merge anything.
//
// "recent run history for the same job name" (AC6): `gh` has no bulk
// per-job-name history endpoint — `gh run view <id> --json jobs` answers for
// ONE run, and `gh run list` answers at the WORKFLOW level, not the job level.
// Adding a second, broader API surface (one `gh api` call per historical run,
// to read each one's own job list) was deliberately avoided — AC6 says "no
// broader CI-API surface is added" — so `recentRuns` narrows by the run's own
// WORKFLOW instead, which is the closest reading `gh`'s existing two commands
// give without adding a third shape of call.

export interface CiJobSummary {
  readonly name: string;
  readonly conclusion: string | null;
  readonly status?: string;
}

export interface CiRunInfo {
  readonly runId: string;
  readonly workflowName: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly conclusion: string | null;
  readonly jobs: readonly CiJobSummary[];
}

export interface CiRunHistoryEntry {
  readonly runId: string;
  readonly conclusion: string | null;
  readonly createdAt: string | null;
  readonly headBranch: string | null;
}

/** One earlier attempt of a run that was rerun ("re-run failed jobs"/"re-run all jobs") — flow 307, AC1(a). */
export interface CiAttemptJobs {
  readonly attempt: number;
  readonly jobs: readonly CiJobSummary[];
}

/**
 * Flow 307 (AC1, AC8): three more READ methods, added to compute deterministic
 * triage signals before asking Jev — history/diff/rerun evidence, never a
 * write. `CiPort` still has no method that could rerun a job, touch a status
 * check, or merge anything; every new method here is a `gh run view`/`gh api
 * .../commits`/`gh run list` read, parsed and nothing else.
 */
export interface CiPort {
  /** `gh run view <runId> --json jobs,workflowName,headBranch,headSha,conclusion`. */
  runInfo(runId: string): Promise<CiRunInfo>;
  /** `gh run view <runId> --log-failed`: raw failed-step log text. */
  failedLog(runId: string): Promise<string>;
  /** Recent runs of `workflowName`, newest first. See the file header on "job name" history. */
  recentRuns(workflowName: string, limit?: number): Promise<readonly CiRunHistoryEntry[]>;
  /**
   * AC1(a): jobs from every attempt of `runId` BEFORE its current (latest)
   * attempt — empty when the run was never rerun. `gh run view <runId>
   * --attempt <n> --json jobs` per prior attempt, oldest first.
   */
  priorAttempts(runId: string): Promise<readonly CiAttemptJobs[]>;
  /**
   * AC1(c): the file paths this commit touched — `gh api
   * repos/{owner}/{repo}/commits/{headSha}`'s `.files[].filename`. Empty on
   * any read failure rather than throwing: diff proximity is one signal among
   * several, not a hard dependency.
   */
  changedFiles(headSha: string): Promise<readonly string[]>;
  /**
   * AC8: every run of `workflowName` whose head commit is exactly `headSha`
   * (`gh run list --commit <sha>`) — used only to check whether a LATER run
   * of the SAME commit (a manual re-trigger, not a new push) passed.
   */
  runsForHeadSha(headSha: string, workflowName: string): Promise<readonly CiRunHistoryEntry[]>;
}

export type CiSpawn = (argv: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/**
 * Wall-clock ceiling for one `gh` subprocess call (flow 307 review, item 1).
 * Without this a hung `gh` (a network stall, a credential prompt nobody is
 * watching) hung the whole triage pipeline forever — same "never hang"
 * reason `jev-client.ts`'s `DEFAULT_JEV_TIMEOUT_MS` exists for, and the same
 * order of magnitude (30s), since both are one outbound read this CLI
 * invocation is waiting on synchronously.
 */
export const DEFAULT_GH_SPAWN_TIMEOUT_MS = 30_000;

/**
 * Output cap for one subprocess this module (or `./ci-triage.ts`'s
 * `defaultGitShow`, which imports this same constant rather than defining
 * its own) spawns. A CI log or `git show` blob has no contractual size
 * ceiling; `Bun.spawn`'s own `maxBuffer` kills the child once captured
 * output crosses it, the same "abort rather than silently keep buffering"
 * contract `real-process-adapter.ts`'s `ENOBUFS`/`maxBuffer` handling
 * already establishes elsewhere in this codebase.
 */
export const CI_SPAWN_OUTPUT_CAP_BYTES = 8 * 1024 * 1024;

/**
 * The subset of a `Bun.spawn` subprocess `defaultCiSpawn`'s timeout/cap
 * detection actually reads — injectable so the detection logic below has a
 * hermetic unit test (`ci-port.test.ts`) that spawns nothing real, the same
 * "injected fake" shape `CiSpawn` itself already gives the rest of this
 * module's tests, and the pure-classifier split `real-process-adapter.ts`
 * uses for the same reason.
 */
export interface CiBunSubprocess {
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  readonly signalCode: string | null;
}

/** What `defaultCiSpawn` asks to be spawned with — `Bun.spawn` matches this shape; a test substitutes a fake. */
export type CiBunSpawnFn = (
  argv: string[],
  opts: { stdin: "ignore"; stdout: "pipe"; stderr: "pipe"; timeout: number; killSignal: string; maxBuffer: number },
) => CiBunSubprocess;

/**
 * Builds the real `CiSpawn` adapter around whatever spawns a process —
 * `Bun.spawn` by default, or an injected fake in a test. Exported so
 * `ci-port.test.ts` can drive the timeout/output-cap detection logic below
 * with a fake `Bun.spawn`-shaped result (a killed-by-signal subprocess, a
 * clean one) without spawning anything real.
 */
export function makeDefaultCiSpawn(
  bunSpawn: CiBunSpawnFn = Bun.spawn.bind(Bun) as unknown as CiBunSpawnFn,
): CiSpawn {
  return async (argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    const proc = bunSpawn(argv, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: DEFAULT_GH_SPAWN_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: CI_SPAWN_OUTPUT_CAP_BYTES,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      proc.stdout === null ? Promise.resolve("") : new Response(proc.stdout).text(),
      proc.stderr === null ? Promise.resolve("") : new Response(proc.stderr).text(),
      proc.exited,
    ]);
    // `proc.signalCode` is set (e.g. "SIGKILL") whenever OUR timeout or
    // output cap killed the child — never a normal exit, and
    // `exitCode`/`stderr` at that point describe a truncated capture, not a
    // real `gh` failure. Named explicitly here rather than left to fall
    // through to the generic non-zero-exit message each `CiPort` method
    // raises, which would print a confusing "exited 137: no stderr" instead
    // of naming what actually happened.
    if (proc.signalCode !== null) {
      throw new Error(
        `${argv.join(" ")} did not complete and was killed (signal ${proc.signalCode}): either it exceeded the ` +
          `${DEFAULT_GH_SPAWN_TIMEOUT_MS}ms timeout, or its output exceeded the ${CI_SPAWN_OUTPUT_CAP_BYTES}-byte cap. ` +
          "Never hung: aborted rather than waited out.",
      );
    }
    return { stdout, stderr, exitCode };
  };
}

const defaultCiSpawn: CiSpawn = makeDefaultCiSpawn();

function repoArgs(repo: string | undefined): string[] {
  return repo === undefined ? [] : ["--repo", repo];
}

interface GhJobsJson {
  readonly jobs?: readonly { readonly name?: string; readonly conclusion?: string | null; readonly status?: string }[];
  readonly workflowName?: string;
  readonly headBranch?: string;
  readonly headSha?: string;
  readonly conclusion?: string | null;
}

interface GhRunListEntry {
  readonly databaseId?: number;
  readonly conclusion?: string | null;
  readonly createdAt?: string;
  readonly headBranch?: string;
}

/**
 * The live adapter: `gh run view`/`gh run list`, and no logic beyond parsing
 * — the same discipline `createGhPort` follows in `./pr-comments.ts`.
 */
export function createGhCiPort(spawn: CiSpawn = defaultCiSpawn, repo?: string): CiPort {
  return {
    async runInfo(runId: string): Promise<CiRunInfo> {
      const argv = ["gh", "run", "view", runId, ...repoArgs(repo), "--json", "jobs,workflowName,headBranch,headSha,conclusion"];
      const result = await spawn(argv);
      if (result.exitCode !== 0) {
        throw new Error(`gh run view ${runId} --json ... exited ${result.exitCode}: ${result.stderr.trim() || "no stderr"}`);
      }
      const parsed = JSON.parse(result.stdout) as GhJobsJson;
      return {
        runId,
        workflowName: parsed.workflowName ?? "",
        headBranch: parsed.headBranch ?? "",
        headSha: parsed.headSha ?? "",
        conclusion: parsed.conclusion ?? null,
        jobs: (parsed.jobs ?? []).map((j) => ({
          name: j.name ?? "",
          conclusion: j.conclusion ?? null,
          ...(j.status !== undefined ? { status: j.status } : {}),
        })),
      };
    },
    async failedLog(runId: string): Promise<string> {
      const argv = ["gh", "run", "view", runId, ...repoArgs(repo), "--log-failed"];
      const result = await spawn(argv);
      if (result.exitCode !== 0) {
        throw new Error(`gh run view ${runId} --log-failed exited ${result.exitCode}: ${result.stderr.trim() || "no stderr"}`);
      }
      return result.stdout;
    },
    async recentRuns(workflowName: string, limit = 10): Promise<readonly CiRunHistoryEntry[]> {
      const argv = [
        "gh",
        "run",
        "list",
        ...repoArgs(repo),
        "--workflow",
        workflowName,
        "--json",
        "databaseId,conclusion,createdAt,headBranch",
        "-L",
        String(limit),
      ];
      const result = await spawn(argv);
      if (result.exitCode !== 0) {
        throw new Error(`gh run list --workflow ${workflowName} exited ${result.exitCode}: ${result.stderr.trim() || "no stderr"}`);
      }
      const parsed = JSON.parse(result.stdout) as readonly GhRunListEntry[];
      return parsed.map((r) => ({
        runId: String(r.databaseId ?? ""),
        conclusion: r.conclusion ?? null,
        createdAt: r.createdAt ?? null,
        headBranch: r.headBranch ?? null,
      }));
    },
    // AC1(a): bounded to the last MAX_PRIOR_ATTEMPTS_CHECKED attempts before
    // the current one — a run rerun a handful of times reads a handful of
    // extra `gh run view --attempt` calls, not one per historical attempt
    // ever taken.
    async priorAttempts(runId: string): Promise<readonly CiAttemptJobs[]> {
      const attemptArgv = ["gh", "run", "view", runId, ...repoArgs(repo), "--json", "attempt"];
      const attemptResult = await spawn(attemptArgv);
      if (attemptResult.exitCode !== 0) {
        // Best-effort signal, not a hard dependency: a run whose attempt
        // number cannot be read contributes no rerun evidence rather than
        // failing the whole triage.
        return [];
      }
      let currentAttempt: number;
      try {
        currentAttempt = Number((JSON.parse(attemptResult.stdout) as { attempt?: number }).attempt ?? 1);
      } catch {
        return [];
      }
      if (!Number.isFinite(currentAttempt) || currentAttempt <= 1) {
        return [];
      }
      const first = Math.max(1, currentAttempt - MAX_PRIOR_ATTEMPTS_CHECKED);
      const out: CiAttemptJobs[] = [];
      for (let attempt = first; attempt < currentAttempt; attempt += 1) {
        const argv = ["gh", "run", "view", runId, "--attempt", String(attempt), ...repoArgs(repo), "--json", "jobs"];
        const result = await spawn(argv);
        if (result.exitCode !== 0) continue;
        try {
          const parsed = JSON.parse(result.stdout) as GhJobsJson;
          out.push({
            attempt,
            jobs: (parsed.jobs ?? []).map((j) => ({
              name: j.name ?? "",
              conclusion: j.conclusion ?? null,
              ...(j.status !== undefined ? { status: j.status } : {}),
            })),
          });
        } catch {
          // A malformed attempt read contributes nothing; the others still can.
        }
      }
      return out;
    },
    async changedFiles(headSha: string): Promise<readonly string[]> {
      const path = repo !== undefined ? `repos/${repo}/commits/${headSha}` : "repos/{owner}/{repo}/commits/" + headSha;
      const result = await spawn(["gh", "api", path, "--jq", ".files[].filename"]);
      if (result.exitCode !== 0) {
        return [];
      }
      return result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    },
    async runsForHeadSha(headSha: string, workflowName: string): Promise<readonly CiRunHistoryEntry[]> {
      const argv = [
        "gh",
        "run",
        "list",
        ...repoArgs(repo),
        "--workflow",
        workflowName,
        "--commit",
        headSha,
        "--json",
        "databaseId,conclusion,createdAt,headBranch",
        "-L",
        "10",
      ];
      const result = await spawn(argv);
      if (result.exitCode !== 0) {
        return [];
      }
      try {
        const parsed = JSON.parse(result.stdout) as readonly GhRunListEntry[];
        return parsed.map((r) => ({
          runId: String(r.databaseId ?? ""),
          conclusion: r.conclusion ?? null,
          createdAt: r.createdAt ?? null,
          headBranch: r.headBranch ?? null,
        }));
      } catch {
        return [];
      }
    },
  };
}

/** AC1(a): how many attempts BEFORE the current one `priorAttempts` will actually fetch. */
export const MAX_PRIOR_ATTEMPTS_CHECKED = 5;

export interface CiFixtureFiles {
  /** Keyed by run id. */
  readonly runs?: Readonly<Record<string, CiRunInfo>>;
  /** Keyed by run id: raw `--log-failed` text. */
  readonly logs?: Readonly<Record<string, string>>;
  /** Keyed by workflow name. */
  readonly history?: Readonly<Record<string, readonly CiRunHistoryEntry[]>>;
  /** Keyed by run id: earlier attempts of that run (AC1(a)). Absent/empty = never rerun. */
  readonly attempts?: Readonly<Record<string, readonly CiAttemptJobs[]>>;
  /** Keyed by head sha: file paths that commit touched (AC1(c)). */
  readonly changedFiles?: Readonly<Record<string, readonly string[]>>;
  /** Keyed by `${workflowName}:${headSha}`: every run of that workflow on that exact commit (AC8). */
  readonly runsByHeadSha?: Readonly<Record<string, readonly CiRunHistoryEntry[]>>;
}

export type CiPortCall =
  | { readonly op: "runInfo"; readonly runId: string }
  | { readonly op: "failedLog"; readonly runId: string }
  | { readonly op: "recentRuns"; readonly workflowName: string }
  | { readonly op: "priorAttempts"; readonly runId: string }
  | { readonly op: "changedFiles"; readonly headSha: string }
  | { readonly op: "runsForHeadSha"; readonly headSha: string; readonly workflowName: string };

export type FixtureCiPort = CiPort & { readonly calls: readonly CiPortCall[] };

/**
 * The offline adapter: every read answered from `files`, in memory — the
 * same shape `createFixturePort` gives `GitHubPort` in `./pr-comments.ts`.
 * `calls` records every request in order, guarded ones included, so a test can
 * assert exactly which `gh`-shaped operations a triage run performed (AC9).
 */
export function createFixtureCiPort(files: CiFixtureFiles): FixtureCiPort {
  const calls: CiPortCall[] = [];
  return {
    get calls() {
      return calls;
    },
    async runInfo(runId: string): Promise<CiRunInfo> {
      calls.push({ op: "runInfo", runId });
      const run = files.runs?.[runId];
      if (run === undefined) {
        throw new Error(`no fixture run info for run ${runId}`);
      }
      return run;
    },
    async failedLog(runId: string): Promise<string> {
      calls.push({ op: "failedLog", runId });
      return files.logs?.[runId] ?? "";
    },
    async recentRuns(workflowName: string, limit = 10): Promise<readonly CiRunHistoryEntry[]> {
      calls.push({ op: "recentRuns", workflowName });
      return (files.history?.[workflowName] ?? []).slice(0, limit);
    },
    async priorAttempts(runId: string): Promise<readonly CiAttemptJobs[]> {
      calls.push({ op: "priorAttempts", runId });
      return files.attempts?.[runId] ?? [];
    },
    async changedFiles(headSha: string): Promise<readonly string[]> {
      calls.push({ op: "changedFiles", headSha });
      return files.changedFiles?.[headSha] ?? [];
    },
    async runsForHeadSha(headSha: string, workflowName: string): Promise<readonly CiRunHistoryEntry[]> {
      calls.push({ op: "runsForHeadSha", headSha, workflowName });
      return files.runsByHeadSha?.[`${workflowName}:${headSha}`] ?? [];
    },
  };
}
