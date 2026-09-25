// Reference-document conformance mode — flow 308, AC3: `pr`-kind state read
// port. Narrow, following the SAME live/fixture split `src/review/ci-port.ts`
// already established for CI triage (flow 306), which itself followed
// `createGhPort`/`createFixturePort` (`src/review/pr-comments.ts`) — a live
// `gh` adapter with no logic beyond parsing, and a fixture adapter answering
// from files on disk, so the whole pr-kind path is exercised offline with no
// network and no real pull request.
//
// A SEPARATE small port from `pr-comments.ts`'s `GitHubPort`, deliberately:
// that port's `guardGitHubRequest` allow-list is scoped to the comment
// endpoints flow's own AC12 fixed (reads: the PR resource, its three comment
// sources; writes: a threaded reply, a PR-level comment) and does not cover
// `gh pr diff`, which this mode needs for AC3's size/hand-written-line facts.
// Reusing that allow-list would mean widening a security-relevant guard for
// an unrelated feature; a second narrow port, exactly like `ci-port.ts`,
// keeps the two capabilities separately auditable.

export interface ConformPrInfo {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  /** Unified diff text, in the same shape `git diff`/`review scope --diff` already consume. */
  readonly diff: string;
}

export interface ConformPrPort {
  pr(number: number): Promise<ConformPrInfo>;
}

export type ConformSpawn = (argv: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

async function defaultConformSpawn(argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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

interface GhPrViewJson {
  readonly title?: string;
  readonly body?: string;
}

/** The live adapter: `gh pr view --json title,body` + `gh pr diff`, no logic beyond parsing. */
export function createGhConformPrPort(spawn: ConformSpawn = defaultConformSpawn, repo?: string): ConformPrPort {
  return {
    async pr(number: number): Promise<ConformPrInfo> {
      const viewArgv = ["gh", "pr", "view", String(number), ...repoArgs(repo), "--json", "title,body"];
      const view = await spawn(viewArgv);
      if (view.exitCode !== 0) {
        throw new Error(`gh pr view ${number} --json title,body exited ${view.exitCode}: ${view.stderr.trim() || "no stderr"}`);
      }
      const parsed = JSON.parse(view.stdout) as GhPrViewJson;
      const diffArgv = ["gh", "pr", "diff", String(number), ...repoArgs(repo)];
      const diff = await spawn(diffArgv);
      if (diff.exitCode !== 0) {
        throw new Error(`gh pr diff ${number} exited ${diff.exitCode}: ${diff.stderr.trim() || "no stderr"}`);
      }
      return { number, title: parsed.title ?? "", body: parsed.body ?? "", diff: diff.stdout };
    },
  };
}

export interface ConformPrFixtureFiles {
  readonly pr?: ConformPrInfo;
}

export type ConformPrPortCall = { readonly op: "pr"; readonly number: number };

export type FixtureConformPrPort = ConformPrPort & { readonly calls: readonly ConformPrPortCall[] };

/** The offline adapter: the one PR this fixture describes, in memory — same shape `createFixtureCiPort` gives `CiPort`. */
export function createFixtureConformPrPort(files: ConformPrFixtureFiles): FixtureConformPrPort {
  const calls: ConformPrPortCall[] = [];
  return {
    get calls() {
      return calls;
    },
    async pr(number: number): Promise<ConformPrInfo> {
      calls.push({ op: "pr", number });
      if (files.pr === undefined) {
        throw new Error(`no fixture PR info for ${number}`);
      }
      return files.pr;
    },
  };
}
