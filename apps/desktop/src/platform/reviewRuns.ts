import type { DeskRunKey, DeskRunSnapshot } from "../../../../src/review/desk-run-types";
import { invoke } from "./backend";

import { ReviewReadLane } from "./reviewReadLane";

const histories = new ReviewReadLane<DeskRunSnapshot>();
let mutationVersion = 0;

export type ReviewRunAction =
  | { kind: "status"; id?: string; activityId?: string }
  | { kind: "start"; baseSha: string; headSha: string }
  | { kind: "cancel"; id: string };

export async function reviewRun(cwd: string, key: DeskRunKey, action: ReviewRunAction): Promise<DeskRunSnapshot> {
  const call = () => invoke<DeskRunSnapshot>("review_run", { cwd, target: key, action });
  let result: DeskRunSnapshot;
  if (action.kind !== "status") {
    mutationVersion++;
    try { result = await call(); } finally { mutationVersion++; }
  } else if (action.id) {
    // Explicit report lookups may target several simultaneously expanded reports.
    result = await call();
  } else {
    result = await histories.read(JSON.stringify([mutationVersion, cwd, key, action.activityId]), call);
  }
  if (result?.version !== 1 || !Array.isArray(result.runs)) {
    throw new Error("configuration: Check that your selected Keryx CLI supports Desktop review runs.");
  }
  return result;
}
