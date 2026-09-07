import type { RunProvenance } from "./types";

export async function collectGitProvenance(cwd: string): Promise<RunProvenance> {
  const [commit, branch, worktree] = await Promise.all([
    git(cwd, ["rev-parse", "HEAD"]),
    git(cwd, ["branch", "--show-current"]),
    git(cwd, ["rev-parse", "--show-toplevel"]),
  ]);
  return {
    commit,
    branch: branch || null,
    worktree,
    sources: [
      {
        name: "git",
        path: ".git",
        timestamp: new Date().toISOString(),
        reliability: commit ? "exact" : "unknown",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Isolation manifest (AC7 / AC-M07)
// ---------------------------------------------------------------------------
//
// "Перед дорогим запуском preflight проверяет standalone checkout из parent
//  snapshot, недоступность answer commit/remotes ... Isolation manifest фиксирует
//  filesystem/network границы: отсутствие remotes не доказывает полный sandbox."
//
// Three separate questions, deliberately kept separate in the result so a reader
// can see which one actually held:
//
//  - Is this checkout the parent snapshot, and only the parent snapshot?
//  - Can the answer commit still be reached from here?
//  - Are there remotes through which anything at all could be fetched?
//
// The norm's own caveat is honoured by the type: `status: "verified"` here means
// "these three checks passed", not "this is a sandbox". The last clause of the
// norm says so explicitly, so nothing in this module claims otherwise.
//
// Fail-closed on every unknown. If git is missing, if the directory is not a
// repository, or if the caller declined to name an answer commit, the result is
// `unverified` — which the preflight blocks on. "I could not check" is never
// allowed to read the same as "I checked and it was fine".

export type IsolationStatus = "verified" | "unverified" | "violated";

export type IsolationReport = {
  readonly status: IsolationStatus;
  readonly remotes: readonly string[];
  readonly parentSnapshotCommit: string;
  readonly headCommit: string | null;
  readonly checkoutMatchesParent: boolean | null;
  readonly answerCommitReachable: boolean | null;
  readonly problems: readonly string[];
};

export type IsolationRequest = {
  readonly agentRoot: string;
  readonly parentSnapshotCommit: string;
  /**
   * The commit carrying the solution. `null` is not "there isn't one" — it is
   * "nobody said", and it leaves the report `unverified`.
   */
  readonly answerCommit: string | null;
};

export async function collectIsolationReport(request: IsolationRequest): Promise<IsolationReport> {
  const problems: string[] = [];

  if (!Bun.which("git")) {
    return {
      status: "unverified",
      remotes: [],
      parentSnapshotCommit: request.parentSnapshotCommit,
      headCommit: null,
      checkoutMatchesParent: null,
      answerCommitReachable: null,
      problems: ["git is not available: isolation could not be checked"],
    };
  }

  const headCommit = await git(request.agentRoot, ["rev-parse", "HEAD"]);
  if (headCommit === null) {
    return {
      status: "unverified",
      remotes: [],
      parentSnapshotCommit: request.parentSnapshotCommit,
      headCommit: null,
      checkoutMatchesParent: null,
      answerCommitReachable: null,
      problems: [`not a readable git checkout: ${request.agentRoot}`],
    };
  }

  const remotesRaw = await git(request.agentRoot, ["remote"]);
  const remotes = (remotesRaw ?? "").split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (remotes.length > 0) problems.push(`remotes are configured: ${remotes.join(", ")}`);

  const checkoutMatchesParent = headCommit === request.parentSnapshotCommit;
  if (!checkoutMatchesParent) {
    problems.push(`checkout is at ${headCommit}, not the parent snapshot ${request.parentSnapshotCommit}`);
  }

  let answerCommitReachable: boolean | null = null;
  if (request.answerCommit === null) {
    problems.push("no answer commit was named: its unreachability was never checked");
  } else {
    const exit = await gitExit(request.agentRoot, ["cat-file", "-e", `${request.answerCommit}^{commit}`]);
    if (exit === null) {
      problems.push(`answer commit reachability could not be determined for ${request.answerCommit}`);
    } else {
      answerCommitReachable = exit === 0;
      if (answerCommitReachable) problems.push(`answer commit ${request.answerCommit} is reachable from this checkout`);
    }
  }

  const violated =
    remotes.length > 0 || checkoutMatchesParent === false || answerCommitReachable === true;
  const undetermined = answerCommitReachable === null;
  const status: IsolationStatus = violated ? "violated" : undetermined ? "unverified" : "verified";

  return {
    status,
    remotes,
    parentSnapshotCommit: request.parentSnapshotCommit,
    headCommit,
    checkoutMatchesParent,
    answerCommitReachable,
    problems,
  };
}

async function gitExit(cwd: string, args: string[]): Promise<number | null> {
  if (!Bun.which("git")) return null;
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
  return await proc.exited;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  if (!Bun.which("git")) return null;
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 ? stdout.trim() || null : null;
}
