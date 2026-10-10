// Completion gate for a managed review run in the shell. The shell's model ends
// a turn at the first friction ("this is not the final report") and the harness
// used to accept it; a review is finished when `keryx review complete` accepts
// the package, not when the model stops writing. Deterministic: no model judges.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { reviewCompletionBlockers, reviewsRoot } from "./managed";

export const MAX_REVIEW_GATE_CONTINUES = 20;
export const MAX_REVIEW_GATE_STALLS = 2;
const RECENT_PACKAGE_MS = 15 * 60 * 1000;

export type OpenManagedReview = {
  reviewId: string;
  packageDir: string;
  blockers: string[];
  /** Changes whenever the package or the working data under it gains or changes an artifact. */
  signature: string;
  recentlyTouched: boolean;
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

/** The newest review-flow package under `cwd` that is not closed, or null. */
export async function findOpenManagedReview(cwd: string, now: number = Date.now()): Promise<OpenManagedReview | null> {
  let names: string[];
  try {
    names = (await readdir(reviewsRoot(cwd), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return null;
  }
  let best: { dir: string; mtime: number; id: string } | null = null;
  for (const name of names) {
    const dir = path.join(reviewsRoot(cwd), name);
    try {
      const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as {
        mode?: string;
        status?: string;
        reviewId?: string;
      };
      if (manifest.mode !== "review-flow" || manifest.status === "closed") continue;
      const info = await stat(path.join(dir, "manifest.json"));
      if (best === null || info.mtimeMs > best.mtime) best = { dir, mtime: info.mtimeMs, id: manifest.reviewId ?? name };
    } catch {
      continue;
    }
  }
  if (best === null) return null;
  const blockers = await reviewCompletionBlockers(best.dir);
  const signature = [
    blockers.join("|"),
    await dirSignature(best.dir),
    await dirSignature(path.join(cwd, ".metaproject", "data", "review")),
  ].join("#");
  return {
    reviewId: best.id,
    packageDir: best.dir,
    blockers,
    signature,
    recentlyTouched: now - best.mtime < RECENT_PACKAGE_MS,
  };
}

/** True when the transcript shows the review skill or a `keryx review` command was used in this session. */
export function reviewRunSeenInHistory(
  history: ReadonlyArray<{ toolCalls?: ReadonlyArray<{ name: string; arguments: string }> | undefined }>,
): boolean {
  for (const message of history) {
    for (const call of message.toolCalls ?? []) {
      if (call.arguments.includes("review-orchestrator") || /keryx review (start|scope|slice|ingest|complete)/.test(call.arguments)) {
        return true;
      }
    }
  }
  return false;
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
  if (open === null || !(input.runSeen || open.recentlyTouched)) return { action: "accept" };
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
      "Do the next missing step now. Step 1 (Build Review Context Pack) has no CLI command; it is a prose step, so mark it done and move on. " +
      "A command that is refused is not a blocker: run `keryx review --help` for the accepted usage and retry with the right flags. " +
      "A plan item you marked blocked for such a reason is not blocked: mark it in_progress. " +
      "Stop only after `review complete` succeeds, or report the one real blocker with its evidence.",
  };
}
