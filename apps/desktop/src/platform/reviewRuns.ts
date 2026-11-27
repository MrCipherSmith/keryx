import type { DeskReviewAction, DeskRunKey, DeskRunSnapshot } from "../../../../src/review/desk-run-types";
import type { DeskReviewOptions } from "../../../../src/review/desk-run-options";
import { invoke } from "./backend";

import { ReviewReadLane } from "./reviewReadLane";

const histories = new ReviewReadLane<DeskRunSnapshot>();
let mutationVersion = 0;

export type ReviewRunAction =
  | { kind: "status"; id?: string; activityId?: string; activityBefore?: number }
  | { kind: "start"; sessionId?: string; baseSha: string; headSha: string; options?: DeskReviewOptions }
  /** The update round of the attempt's Review on this range. In the app, App's board runner sends it to the PR's
   * session as a turn (review/updateRound.ts); calling `reviewRun` with it runs `keryx review advance`. */
  | { kind: "advance"; id: string; baseSha: string; headSha: string }
  | { kind: "continue"; id: string; guidance?: string }
  | { kind: "cancel"; id: string }
  | { kind: "readiness"; id: string }
  | { kind: "decide"; id: string; decision: DeskReviewAction; reason: string; waive?: string[] }
  | { kind: "answer"; id: string; questionId: string; answer: string };

export async function reviewRun(cwd: string, key: DeskRunKey, action: ReviewRunAction): Promise<DeskRunSnapshot> {
  const call = () => invoke<DeskRunSnapshot>("review_run", { cwd, target: key, action });
  let result: DeskRunSnapshot;
  if (action.kind === "readiness") {
    result = await call();
  } else if (action.kind !== "status") {
    mutationVersion++;
    try { result = await call(); } finally { mutationVersion++; }
  } else if (action.id) {
    // Explicit report lookups may target several simultaneously expanded reports.
    result = await call();
  } else {
    result = await histories.read(JSON.stringify([mutationVersion, cwd, key, action.activityId, action.activityBefore]), call);
  }
  if (result?.version !== 1 || !Array.isArray(result.runs)) {
    throw new Error("configuration: Check that your selected Keryx CLI supports Desktop review runs.");
  }
  return result;
}

type ReviewRunListener = (cwd: string, key: DeskRunKey, snapshot: DeskRunSnapshot) => void;
const launchListeners = new Set<ReviewRunListener>();

export function publishSessionReview(cwd: string, key: DeskRunKey, snapshot: DeskRunSnapshot) {
  for (const listener of launchListeners) listener(cwd, key, snapshot);
}

export function subscribeSessionReview(listener: ReviewRunListener) {
  launchListeners.add(listener);
  return () => { launchListeners.delete(listener); };
}
