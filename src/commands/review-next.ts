import { optionValue } from "../lib/args";
import { guardReviewPaths } from "../lib/review-path-flags";
import { reviewNext, renderNext } from "../review/review-next";
import { idleLine, recordWaveEvents } from "../review/wave-events";
import { resolvePackageDir, wantsHelp } from "./review-layers";

export const NEXT_FLAGS = ["--package", "--reviewers", "--apply", "--json", "--help", "-h"] as const;

export function printNextHelp(): void {
  console.log(`keryx review next — usage:

  keryx review next --package <review-dir> [--reviewers a,b] [--apply] [--json]

Answers, for the WHOLE package at once, what is left to dispatch: every reviewer's next wave, so
the orchestrator runs this once after each batch instead of polling \`review retry-plan\` per
reviewer. It reads the slice manifest and its routing, raw/ (every reviewer's latest reply), the
late results the drivers name and the retry state, and decides each reviewer with the same logic
\`retry-plan\` uses. Output, per dispatch: reviewer, wave (and waves left), slice ids and their
absolute paths, the model recorded for the reviewer (drivers/<reviewer>-w<n>.json "model", or
its last reply's), where its reply goes (the driver's "result"), and the reason:
  missing    the reviewer has no result for these slices yet
  retry      its last result was unfinished (INCOMPLETE, BLOCKED, NEEDS_CONTEXT) and moved the scope, or
             asked questions to answer in the re-dispatch
  stalled    its last result covered nothing new: its open slices are re-cut at half the size
  escalated  a major-or-worse finding re-opened a light slice deep and the reviewer now owns it
It prints "done" when nothing is left (a reviewer that is Not run is listed, never a clean pass).
When the operator's plan covers what is dispatched (no confirmation is asked for, or one is
recorded for this plan) and there is something to dispatch, it adds a line after the first one:
the orchestrator goes on without asking. --json carries the same as "planAuthorized" (true, false,
or null when the plan could not be evaluated) and "continue".

Read-only by default: a reply already counted is remembered by hash, so asking again changes
nothing, and it appends an event to tool-calls/wave-events.jsonl (the only file it writes without
--apply; a gap longer than 10 min after the last reply or 15 min for the next one, with slices open
under an authorized plan, adds a warning and an idle event; routing.config.json "reviewWaves"
{idleAfterWaveMinutes, idleWaveReplyMinutes} changes the limits). --apply writes what was decided:
the re-cut slice files, an escalated manifest and the retry state. --reviewers limits the answer to
those reviewers (default: the package's required set, its fix-slice roles and every reviewer a
driver names).
`);
}

export async function runNext(args: string[], deps: { rejectUnknownFlags: (args: readonly string[], allowed: readonly string[], usage: string) => void }): Promise<void> {
  if (wantsHelp(args)) {
    printNextHelp();
    return;
  }
  deps.rejectUnknownFlags(args, NEXT_FLAGS, "next");
  guardReviewPaths("next", args);
  const packageDir = resolvePackageDir(args, process.cwd(), "next");
  const listed = optionValue(args, "--reviewers");
  const reviewers = listed === undefined ? undefined : listed.split(",").map((item) => item.trim()).filter(Boolean);
  const result = await reviewNext({ packageDir, reviewers, apply: args.includes("--apply") });
  const json = args.includes("--json");
  console.log(json ? JSON.stringify(result, null, 2) : renderNext(result));
  const recorded = await recordWaveEvents(result);
  for (const gap of recorded.idle) (json ? console.error : console.log)(idleLine(gap));
}
