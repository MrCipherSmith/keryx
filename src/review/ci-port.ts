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

export interface CiPort {
  /** `gh run view <runId> --json jobs,workflowName,headBranch,headSha,conclusion`. */
  runInfo(runId: string): Promise<CiRunInfo>;
  /** `gh run view <runId> --log-failed`: raw failed-step log text. */
  failedLog(runId: string): Promise<string>;
  /** Recent runs of `workflowName`, newest first. See the file header on "job name" history. */
  recentRuns(workflowName: string, limit?: number): Promise<readonly CiRunHistoryEntry[]>;
}

export type CiSpawn = (argv: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

async function defaultCiSpawn(argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

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
  };
}

export interface CiFixtureFiles {
  /** Keyed by run id. */
  readonly runs?: Readonly<Record<string, CiRunInfo>>;
  /** Keyed by run id: raw `--log-failed` text. */
  readonly logs?: Readonly<Record<string, string>>;
  /** Keyed by workflow name. */
  readonly history?: Readonly<Record<string, readonly CiRunHistoryEntry[]>>;
}

export type CiPortCall =
  | { readonly op: "runInfo"; readonly runId: string }
  | { readonly op: "failedLog"; readonly runId: string }
  | { readonly op: "recentRuns"; readonly workflowName: string };

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
  };
}
