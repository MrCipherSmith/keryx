import type { ReviewRuleAction, ReviewRuleSnapshot } from "../../../../src/review/review-rule-types";
import type { WatcherKey } from "../../../../src/review/watcher-types";
import { invoke } from "./backend";

export async function reviewRules(cwd: string, target: WatcherKey, action: ReviewRuleAction): Promise<ReviewRuleSnapshot> {
  const snapshot = await invoke<ReviewRuleSnapshot>("review_rules", { cwd, target, action });
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.rules) || !snapshot.choice || !Array.isArray(snapshot.activity)) {
    throw new Error("Check that the selected Keryx CLI supports Review automation rules.");
  }
  return snapshot;
}
