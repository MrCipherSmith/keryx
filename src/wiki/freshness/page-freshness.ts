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
}

/** Injected so tests need no repository, and so a missing git degrades. */
export type GitRunner = (cwd: string, args: string[]) => Promise<string | null>;

export async function evaluatePageFreshness(input: {
  cwd: string;
  page: { path: string; verifiedAt: string | null; verifiedScope: string | null };
  describePaths: readonly string[];
  graph: GraphData;
  git: GitRunner;
}): Promise<PageFreshness> {
  const { cwd, page, describePaths, graph, git } = input;

  const base: Omit<PageFreshness, "basis" | "changed" | "confidenceCap"> = {
    page: page.path,
    commitsBehind: 0,
    changedFiles: [],
  };

  if (describePaths.length === 0) {
    // Nothing to measure against. §4.4.1: excluded from scoring entirely.
    return { ...base, basis: "undecidable", changed: false, confidenceCap: "review-suggested" };
  }

  if (page.verifiedAt && (await revisionExists(git, cwd, page.verifiedAt))) {
    const log = await git(cwd, [
      "log",
      "--format=%H",
      `${page.verifiedAt}..HEAD`,
      "--",
      ...describePaths,
    ]);
    if (log !== null) {
      const commits = log.split("\n").filter((line) => line.trim().length > 0);
      const names =
        commits.length > 0
          ? ((await git(cwd, [
              "diff",
              "--name-only",
              `${page.verifiedAt}..HEAD`,
              "--",
              ...describePaths,
            ])) ?? "")
          : "";
      return {
        ...base,
        basis: "git-log",
        changed: commits.length > 0,
        commitsBehind: commits.length,
        changedFiles: names.split("\n").filter((line) => line.trim().length > 0),
        confidenceCap: "must-refresh",
      };
    }
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
