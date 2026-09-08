// LWG-4 freshness evaluation, both paths (flow 226, phase 1).
//
// "Has this page's code moved since anyone last verified it?" has two answers
// depending on what the project has, and the package requires BOTH to exist
// from the start (specification §4.1). Different projects treat
// `.metaproject/` differently — keryx tracks it, vantage-frontend ignores it,
// and `src/commands/init.no-git.test.ts` pins a project with no git at all as
// supported — so a git-only answer serves one case out of three.
//
//   git-log     `VerifiedAt` resolves in this history ⇒ count the commits
//               touching the describe-set since it. Cheap, precise, and it
//               yields "how far behind", which is what makes a backlog
//               orderable.
//   scope-hash  no git, or a `VerifiedAt` this history has never heard of ⇒
//               recompute `VerifiedScope` and compare. Strictly coarser:
//               changed or unchanged, no commit count, no per-file detail.
//               Findings derived this way are therefore capped at
//               `review-suggested` — claiming `must-refresh` off a binary
//               answer would dress a weaker measurement as a stronger one.
//   undecidable neither is available. NOT the same as fresh, and the report
//               must never round it to one.

import type { GraphData } from "../../gdgraph/types";
import type { GitCmdResult } from "../../sync/provenance";
import { computeVerifiedScope } from "../provenance";

export type FreshnessBasis = "git-log" | "scope-hash" | "undecidable";

export interface PageFreshness {
  /** Wiki-relative page path. */
  page: string;
  basis: FreshnessBasis;
  /** False also means "no evidence of change", never "verified correct". */
  changed: boolean;
  /** Only meaningful on the `git-log` basis. */
  commitsBehind: number;
  /** Describe-set files touched since `VerifiedAt`; empty on the hash basis. */
  changedFiles: string[];
  /** The strongest confidence a finding from this basis may claim. */
  confidenceCap: "must-refresh" | "review-suggested";
  /**
   * Set only when `basis === "undecidable"` BECAUSE a git operation could not
   * be completed — flow 236 T7, AFC-22 clause 2 / AFC-W05 clause 3: "a git
   * failure yields unknown". This is deliberately a distinct fact from the
   * ordinary "nobody has verified this page yet" undecidable (no reason set):
   * a `VerifiedAt` naming a commit this history genuinely does not contain
   * (AC12 — a rebase, a shallow clone) is git successfully ANSWERING "no",
   * not a failure, and never sets this field.
   */
  gitFailure?: string;
}

/**
 * Injected so tests need no repository, and so a missing git degrades.
 *
 * AFC-22 (flow 236 T13, F236-01): this used to be
 * `(cwd, args) => Promise<string | null>`, and that type — not any one
 * consumer — is what made "git failed" unrepresentable downstream. `null`
 * had to stand for a spawn error, a non-zero exit, AND (for `cat-file -e`) a
 * legitimate negative answer, so `revisionExists` could not tell a removed or
 * permission-changed repository from "this commit is not in this history",
 * and reported a git failure as an ordinary scope-hash measurement. Widening
 * it to `GitCmdResult` costs every consumer a `kind` check — `report.ts`,
 * `run.ts`, the benchmark harness and the fixtures below — which is the
 * honest price of the distinction surviving the seam instead of dying at it.
 */
export type GitRunner = (cwd: string, args: string[]) => Promise<GitCmdResult>;

export async function evaluatePageFreshness(input: {
  cwd: string;
  page: { path: string; verifiedAt: string | null; verifiedScope: string | null };
  describePaths: readonly string[];
  graph: GraphData;
  git: GitRunner;
  /**
   * Whether git could answer at all this run, established ONCE per report by
   * a single up-front probe (mirrors `gdgraph/staleness.ts`'s
   * `checkGraphStaleness`, which does the same thing for the same reason).
   * Defaults to `true` so a direct caller that never exercises this failure
   * mode (every pre-existing fixture in this file) is unaffected; the real
   * report builder (`report.ts`) always supplies the measured value.
   */
  gitAvailable?: boolean;
}): Promise<PageFreshness> {
  const { cwd, page, describePaths, graph, git, gitAvailable = true } = input;

  const base: Omit<PageFreshness, "basis" | "changed" | "confidenceCap"> = {
    page: page.path,
    commitsBehind: 0,
    changedFiles: [],
  };
  const undecidableGitFailure = (detail: string): PageFreshness => ({
    ...base,
    basis: "undecidable",
    changed: false,
    confidenceCap: "review-suggested",
    gitFailure: detail,
  });

  if (describePaths.length === 0) {
    // Nothing to measure against. §4.4.1: excluded from scoring entirely.
    return { ...base, basis: "undecidable", changed: false, confidenceCap: "review-suggested" };
  }

  if (page.verifiedAt) {
    if (!gitAvailable) {
      // Git could not be asked at all this run (the up-front `rev-parse
      // HEAD` probe failed). Silently falling through to VerifiedScope here
      // is exactly the defect this task closes: a git-log measurement that
      // never ran would read as a legitimate, if weaker, result instead of
      // "unknown". A page with no `VerifiedAt` at all never reaches this
      // branch and is unaffected — VerifiedScope alone never depended on git.
      return undecidableGitFailure(
        "git was unavailable this run (rev-parse HEAD failed); the git-log measurement could not be attempted",
      );
    }

    const known = await revisionExists(git, cwd, page.verifiedAt);
    if (known.kind === "failed") {
      // The `cat-file -e` probe itself could not be completed. Its non-zero
      // exit is ALSO how git says "no such revision" (AC12's legitimate
      // fallthrough), so before this the two were the same event and a broken
      // repository quietly produced a scope-hash "measurement".
      return undecidableGitFailure(known.detail);
    }
    if (known.kind === "present") {
      const logResult = await git(cwd, [
        "log",
        "--format=%H",
        `${page.verifiedAt}..HEAD`,
        "--",
        ...describePaths,
      ]);
      if (logResult.kind !== "ok") {
        // Git answered `cat-file` fine but THIS call failed — a corrupt
        // object, an index lock, a permission error. That is not the same
        // event as "nothing changed" (an empty, SUCCESSFUL log is `""`,
        // handled below) and must not be read as one.
        return undecidableGitFailure("`git log` failed for a revision known to exist");
      }
      const commits = logResult.stdout.split("\n").filter((line) => line.trim().length > 0);
      let names = "";
      if (commits.length > 0) {
        const diff = await git(cwd, [
          "diff",
          "--name-only",
          `${page.verifiedAt}..HEAD`,
          "--",
          ...describePaths,
        ]);
        if (diff.kind !== "ok") {
          // `log` reported real commits but the follow-up `diff` failed —
          // reporting `git-log` here would assert a changed-file list that
          // was never actually measured.
          return undecidableGitFailure("`git diff` failed after `git log` reported commits");
        }
        names = diff.stdout;
      }
      return {
        ...base,
        basis: "git-log",
        changed: commits.length > 0,
        commitsBehind: commits.length,
        changedFiles: names.split("\n").filter((line) => line.trim().length > 0),
        confidenceCap: "must-refresh",
      };
    }
    // `known.kind === "absent"`: AC12's legitimate fallthrough — git ran fine
    // and answered "this commit is not in this history". Falls through to the
    // scope-hash basis below, exactly as before.
  }

  if (page.verifiedScope) {
    const current = await computeVerifiedScope(cwd, describePaths, graph);
    return {
      ...base,
      basis: "scope-hash",
      changed: current !== page.verifiedScope,
      // A binary verdict cannot justify the strongest category. Capping here
      // is what keeps a git-free project's report honest rather than
      // confident-looking.
      confidenceCap: "review-suggested",
    };
  }

  return { ...base, basis: "undecidable", changed: false, confidenceCap: "review-suggested" };
}

/**
 * Whether this history contains the revision — or whether git could not say.
 *
 * A `VerifiedAt` naming a commit that is not reachable — a rebase, a shallow
 * clone, a page copied between repositories — must fall through to the hash
 * path rather than erroring (flow 226 AC12). A stale pointer is a reason to
 * measure differently, not a reason to fail.
 *
 * But `cat-file -e <rev>^{commit}` uses ONE exit status for both answers.
 * Measured directly (macOS, git 2.x): a healthy repository asked about an
 * absent commit exits 128 `fatal: Not a valid object name`, and a repository
 * whose object store was just made unreadable exits 128 `fatal: not a git
 * repository` — same code, same shape. So the exit status alone cannot carry
 * the distinction, and the previous `result !== null` read every failure as
 * AC12's negative answer.
 *
 * The disambiguator is a health re-probe on the same cwd: `rev-parse
 * --git-dir` succeeds in every repository where `cat-file` is genuinely
 * ANSWERING (including one with a corrupt HEAD ref, measured), and fails in
 * exactly the states where `cat-file`'s non-zero exit was a failure — the
 * repository removed mid-run, or its objects made unreadable. Two real
 * inducements of each are pinned in `page-freshness.test.ts`.
 */
type RevisionLookup =
  | { kind: "present" }
  | { kind: "absent" }
  | { kind: "failed"; detail: string };

async function revisionExists(git: GitRunner, cwd: string, revision: string): Promise<RevisionLookup> {
  const result = await git(cwd, ["cat-file", "-e", `${revision}^{commit}`]);
  if (result.kind === "ok") return { kind: "present" };
  if (result.kind === "spawn-error") {
    return { kind: "failed", detail: `\`git cat-file\` could not be started (${result.message}); reachability of ${revision.slice(0, 12)} is unknown` };
  }
  const health = await git(cwd, ["rev-parse", "--git-dir"]);
  if (health.kind === "ok") return { kind: "absent" };
  const stderr = result.stderr.split("\n")[0] ?? "";
  return {
    kind: "failed",
    detail:
      `\`git cat-file -e ${revision.slice(0, 12)}^{commit}\` failed and the repository itself could not be reached afterwards` +
      `${stderr ? ` (${stderr})` : ""}; whether that revision is in this history is unknown`,
  };
}
