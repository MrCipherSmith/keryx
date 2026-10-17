// The base a review range is read from, resolved from git. Shared by round planning (prior-round.ts) and the coverage
// gate's light recheck (coverage.ts) — a leaf module with no review imports, so neither side reaches into the other
// (prior-round imports publish -> readiness -> coverage, and coverage needs the same base).

export type GitResult = { stdout: string; exitCode: number };
/** Runs `git <args>` in `cwd`, with `input` on stdin when given. Never throws: a failure is a non-zero exit. */
export type GitRunner = (args: string[], options?: { input?: string }) => Promise<GitResult>;

const SHA = /^[0-9a-f]{7,64}$/i;

/**
 * `git` at `cwd`. With `timeoutMs`, a git that hangs (a locked index, a credential prompt on a remote ref) is killed with
 * SIGKILL after that long and reads as a failure — the coverage gate runs inside a long-lived shell and must not wait forever.
 */
export function defaultGitRunner(cwd: string, options: { timeoutMs?: number | undefined } = {}): GitRunner {
  return async (args, runOptions = {}) => {
    try {
      const proc = Bun.spawn(["git", ...args], {
        cwd,
        stdin: runOptions.input === undefined ? "ignore" : new TextEncoder().encode(runOptions.input),
        stdout: "pipe",
        stderr: "ignore",
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs, killSignal: "SIGKILL" as const }),
      });
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return { stdout, exitCode: proc.signalCode !== null && proc.signalCode !== undefined ? 124 : exitCode };
    } catch {
      return { stdout: "", exitCode: 127 };
    }
  };
}

export async function mergeBaseOf(git: GitRunner, ref: string, head: string): Promise<string | null> {
  if (ref.startsWith("-") || head.startsWith("-")) return null;
  const result = await git(["merge-base", "--end-of-options", ref, head]);
  const sha = result.stdout.trim();
  return result.exitCode === 0 && SHA.test(sha) ? sha : null;
}

/** The default branches a base falls back to, in order. */
export const DEFAULT_BASE_CANDIDATES: readonly string[] = ["origin/main", "main", "origin/master", "master"];

const sameCommit = (sha: string, head: string): boolean => head.toLowerCase().startsWith(sha.toLowerCase()) || sha.toLowerCase().startsWith(head.toLowerCase());

/**
 * The base ref a target's merge-base is read from, and that merge-base: the recorded base (--base / `review plan --ref` /
 * the manifest's target base) when it resolves — kept even when it gives an empty range, so the caller warns rather than
 * silently replacing it — else the first of origin/main, main, origin/master, master. A merged pull request's merge-base
 * with origin/main is its own head (an empty range), so a default that gives an empty range yields to the next one; when
 * every default is empty the first is returned and the caller warns loudly ({@link emptyRangeWarning}). The recorded base
 * is probed alone first (one git call in the common case); only without it are the defaults probed, together.
 */
export async function resolveBase(git: GitRunner, target: { kind?: string; ref?: string; base?: string | undefined }, head: string): Promise<{ ref: string; sha: string } | null> {
  const recorded = target.base !== undefined && target.base !== "" && !target.base.startsWith("-") ? target.base : undefined;
  if (recorded !== undefined) {
    const sha = await mergeBaseOf(git, recorded, head);
    if (sha !== null) return { ref: recorded, sha };
  }
  const candidates = DEFAULT_BASE_CANDIDATES.filter((ref) => ref !== recorded);
  const shas = await Promise.all(candidates.map((ref) => mergeBaseOf(git, ref, head)));
  let empty: { ref: string; sha: string } | null = null;
  for (const [at, ref] of candidates.entries()) {
    const sha = shas[at] ?? null;
    if (sha === null) continue;
    if (!sameCommit(sha, head)) return { ref, sha };
    empty ??= { ref, sha };
  }
  return empty;
}

/** The loud warning for a round whose range is empty: base and head are the same commit (typically a merged pull request read against its own target branch). */
export function emptyRangeWarning(base: { ref: string; sha: string } | null, head: string | null): string | undefined {
  if (base === null || head === null || !sameCommit(base.sha, head)) return undefined;
  return `empty review range: base ${base.ref} (${base.sha.slice(0, 12)}) equals head ${head.slice(0, 12)}, so there is nothing to slice. A merged pull request's merge-base with its target branch is its own head: pass the pull request's recorded base (\`review start --base <sha|ref>\`, \`review plan --ref <base>\`) or review an unmerged head.`;
}
