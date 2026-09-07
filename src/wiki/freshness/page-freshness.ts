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

/** Injected so tests need no repository, and so a missing git degrades. */
export type GitRunner = (cwd: string, args: string[]) => Promise<string | null>;

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

    if (await revisionExists(git, cwd, page.verifiedAt)) {
      const log = await git(cwd, [
        "log",
        "--format=%H",
        `${page.verifiedAt}..HEAD`,
        "--",
        ...describePaths,
      ]);
      if (log === null) {
        // Git answered `cat-file` fine but THIS call failed — a corrupt
        // object, an index lock, a permission error. That is not the same
        // event as "nothing changed" (an empty, SUCCESSFUL log is `""`,
        // handled below) and must not be read as one.
        return undecidableGitFailure("`git log` failed for a revision known to exist");
      }
      const commits = log.split("\n").filter((line) => line.trim().length > 0);
      let names = "";
      if (commits.length > 0) {
        const diff = await git(cwd, [
          "diff",
          "--name-only",
          `${page.verifiedAt}..HEAD`,
          "--",
          ...describePaths,
        ]);
        if (diff === null) {
          // `log` reported real commits but the follow-up `diff` failed —
          // reporting `git-log` here would assert a changed-file list that
          // was never actually measured.
          return undecidableGitFailure("`git diff` failed after `git log` reported commits");
        }
        names = diff;
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
    // `revisionExists` returned false: AC12's legitimate fallthrough — git
    // ran fine and answered "this commit is not in this history" (a clean
    // `cat-file -e` negative, not a failure). Falls through to the
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
 * Whether this history contains the revision.
 *
 * A `VerifiedAt` naming a commit that is not reachable — a rebase, a shallow
 * clone, a page copied between repositories — must fall through to the hash
 * path rather than erroring (flow 226 AC12). A stale pointer is a reason to
 * measure differently, not a reason to fail.
 */
async function revisionExists(git: GitRunner, cwd: string, revision: string): Promise<boolean> {
  const result = await git(cwd, ["cat-file", "-e", `${revision}^{commit}`]);
  return result !== null;
}
