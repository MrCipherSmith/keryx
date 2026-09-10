// Proving the workspace does not contain the answer.
//
// `assertAnswerUnreachable` settles one question: can this tree reach the commit
// that holds the diff. It says nothing about the second, which only exists because
// keryx's workspace is generated text: did the provisioning step WRITE the answer
// into the workspace in prose. A wiki page describing exactly the change a task
// asks about is the answer, handed to the context arm inside its own workspace, and
// no reachability check would notice.
//
// `src/metrics/leakage.ts` already does this and is reused rather than
// reimplemented. Its `wikiDirs` option exists precisely so a hit inside the wiki
// is attributed as `kind: "wiki"` rather than lumped in with source code, and its
// `unverified` status — returned when the scan could not actually read anything —
// is treated as a refusal here, not as a pass. "We looked and found nothing" and
// "we could not look" are different claims, and only one of them clears an arm.
//
// For T2 the needles include phrases from the root-cause analysis published on the
// ticket itself. That analysis names the file, the function and the line numbers,
// so if an arm's isolation ever leaks to GitHub the answer is sitting there in
// full. Checking for it costs nothing and closes a hole that was opened
// deliberately, by publishing.

import { checkAnswerReachability } from "../../src/metrics/leakage";

export interface LeakageRefusal {
  readonly status: "reachable" | "unverified";
  readonly detail: string;
}

/**
 * Refuse an arm whose workspace holds the answer, or whose workspace could not be
 * checked.
 *
 * Throws rather than returning a flag. A leaked answer is not a quality to record
 * alongside a score; it means the score is about a different experiment.
 */
export function assertAnswerNotInWorkspace(
  treePath: string,
  needles: readonly string[],
  wikiDirs: readonly string[] = [".metaproject/wiki"],
): void {
  if (needles.length === 0) return;

  const report = checkAnswerReachability(treePath, { answerNeedles: needles, wikiDirs });

  if (report.status === "reachable") {
    const where = report.reachable
      .slice(0, 5)
      .map((hit) => `${hit.kind}:${hit.where}${hit.needle === null ? "" : ` (${hit.needle})`}`)
      .join(", ");
    throw new Error(
      `the answer is present in the arm's own workspace: ${where} — ` +
        "a context arm that was handed the answer measures a different experiment, " +
        `scanned ${report.scannedFiles} files`,
    );
  }

  if (report.status === "unverified") {
    throw new Error(
      `the workspace could not be checked for the answer (${report.problems.join("; ")}) — ` +
        '"we could not look" is not "we looked and found nothing", and only the second clears an arm',
    );
  }
}

/**
 * The check as the runner wants it: a plain callback, bound to the wiki roots.
 *
 * Kept separate so a test can substitute its own and so the runner does not have to
 * know where a wiki lives.
 */
export function createLeakageCheck(wikiDirs?: readonly string[]) {
  return (treePath: string, needles: readonly string[]): void => {
    assertAnswerNotInWorkspace(treePath, needles, wikiDirs);
  };
}
