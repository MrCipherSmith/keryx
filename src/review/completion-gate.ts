// Completion gate for a managed review run in the shell. The shell's model ends
// a turn at the first friction ("this is not the final report") and the harness
// used to accept it; a review is finished when `keryx review complete` accepts
// the package, not when the model stops writing. Deterministic: no model judges.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { reviewCompletionBlockers, reviewsRoot } from "./managed";

export const MAX_REVIEW_GATE_CONTINUES = 20;
export const MAX_REVIEW_GATE_STALLS = 3;

export type OpenManagedReview = {
  reviewId: string;
  packageDir: string;
  blockers: string[];
  /** Changes whenever the package or the working data under it gains or changes an artifact. */
  signature: string;
};

async function dirSignature(dir: string): Promise<string> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const parts: string[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const info = await stat(path.join(dir, entry.name)).catch(() => null);
      parts.push(`${entry.name}:${info?.size ?? 0}`);
    }
    return parts.join(",");
  } catch {
    return "";
  }
}

/**
 * The state `keryx review complete` is waiting on. `null` when a review-flow package was closed since
 * `since` (the run is done). Otherwise the newest open package, or — before `review start` has opened
 * one — a placeholder whose blocker is exactly that: a run that built scope and slices but never opened
 * a package is not finished either.
 */
export async function findReviewGateState(cwd: string, since: number): Promise<OpenManagedReview | null> {
  let names: string[];
  try {
    names = (await readdir(reviewsRoot(cwd), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    names = [];
  }
  let best: { dir: string; mtime: number; id: string } | null = null;
  let closedAt = 0;
  for (const name of names) {
    const dir = path.join(reviewsRoot(cwd), name);
    try {
      const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as {
        mode?: string;
        status?: string;
        reviewId?: string;
      };
      if (manifest.mode !== "review-flow") continue;
      const info = await stat(path.join(dir, "manifest.json"));
      if (manifest.status === "closed") {
        if (info.mtimeMs >= since) closedAt = Math.max(closedAt, info.mtimeMs);
        continue;
      }
      if (best === null || info.mtimeMs > best.mtime) best = { dir, mtime: info.mtimeMs, id: manifest.reviewId ?? name };
    } catch {
      continue;
    }
  }
  if (closedAt > 0 && (best === null || best.mtime < closedAt)) return null;
  const working = await dirSignature(path.join(cwd, ".metaproject", "data", "review"));
  if (best === null) {
    return {
      reviewId: "(no package yet)",
      packageDir: "",
      blockers: ["no review package exists: `keryx review start` has not opened one"],
      signature: `none#${working}`,
    };
  }
  const blockers = await reviewCompletionBlockers(best.dir);
  return {
    reviewId: best.id,
    packageDir: best.dir,
    blockers,
    signature: [blockers.join("|"), await dirSignature(best.dir), working].join("#"),
  };
}

/** True when the transcript shows the review skill was loaded or a `keryx review` command was run in this session. */
export function reviewRunSeenInHistory(
  history: ReadonlyArray<{ toolCalls?: ReadonlyArray<{ name: string; arguments: string }> | undefined }>,
): boolean {
  for (const message of history) {
    for (const call of message.toolCalls ?? []) {
      if (call.name === "skill_load" && call.arguments.includes("review-orchestrator")) return true;
      if (/keryx review (start|scope|slice|ingest|complete)/.test(call.arguments)) return true;
    }
  }
  return false;
}

/** The earliest message timestamp in the transcript: packages closed before it are not this run's. */
export function sessionStartedAt(history: ReadonlyArray<{ ts?: string | undefined }>): number {
  for (const message of history) {
    const at = message.ts === undefined ? Number.NaN : Date.parse(message.ts);
    if (!Number.isNaN(at)) return at;
  }
  return Date.now();
}

function nextStep(open: OpenManagedReview): string {
  if (open.packageDir === "") {
    return "Next: `keryx review start --pr <n> --report <path>` opens the package; then dispatch the reviewers per slice, save each result, `keryx review ingest ... --research <ledger.json>`, then `keryx review complete`.";
  }
  if (open.blockers.some((b) => /research|dispatch/.test(b))) {
    return "Next: dispatch the reviewers per slice, record the dispatch in the research ledger, `keryx review ingest ... --research <ledger.json>`, then `keryx review complete`.";
  }
  return "Next: write or ingest the missing artifacts (`keryx review ingest`), then `keryx review complete`.";
}

export type ReviewGateInput = {
  open: OpenManagedReview | null;
  runSeen: boolean;
  continues: number;
  stalls: number;
  lastSignature: string | undefined;
};

export type ReviewGateDecision =
  | { action: "accept" }
  | { action: "continue"; message: string; stalls: number; signature: string }
  | { action: "stop"; report: string };

export function describeBlockers(open: OpenManagedReview): string {
  return open.blockers.length > 0
    ? open.blockers.map((b) => `- ${b}`).join("\n")
    : "- none listed; run `keryx review complete` to close the package";
}

export function decideReviewGate(input: ReviewGateInput): ReviewGateDecision {
  const { open } = input;
  if (open === null || !input.runSeen) return { action: "accept" };
  const stalls = input.lastSignature === open.signature ? input.stalls + 1 : 0;
  if (input.continues >= MAX_REVIEW_GATE_CONTINUES || stalls >= MAX_REVIEW_GATE_STALLS) {
    return {
      action: "stop",
      report:
        `Review ${open.reviewId} is not complete after ${input.continues} continue(s)` +
        `${stalls >= MAX_REVIEW_GATE_STALLS ? " and no new artifact in the last " + stalls : ""}. ` +
        `\`keryx review complete\` still refuses on:\n${describeBlockers(open)}`,
    };
  }
  return {
    action: "continue",
    stalls,
    signature: open.signature,
    message:
      `The managed review ${open.reviewId} is not finished: it is finished when \`keryx review complete\` accepts the package, not when you stop writing. ` +
      `It still refuses on:\n${describeBlockers(open)}\n` +
      `${nextStep(open)}\n` +
      "Do the next missing step now. Step 1 (Build Review Context Pack) has no CLI command; it is a prose step, so mark it done and move on. " +
      "A command that is refused is not a blocker: run `keryx review --help` for the accepted usage and retry with the right flags. " +
      "A plan item you marked blocked for such a reason is not blocked: mark it in_progress. " +
      "A tool loop guard or an empty child result is not a reason to ask the operator to resend the request or to continue: change the arguments, retry the failed pass on a smaller slice, and keep going. " +
      "Stop only after `review complete` succeeds, or report the one real blocker with its evidence.",
  };
}
