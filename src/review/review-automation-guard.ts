import type { DeskRevision, DeskRunKey, DeskSchedule } from "./desk-run-types";
import type { ReviewRule } from "./review-rule-types";
import { matchesCard, selectedRule, type RuleWork } from "./review-rule-queue";
import { modeFor } from "./review-rules";
import { watcherScope, watcherTransaction } from "./watcher-db";
import type { WatchedCard } from "./watcher-events";

/** Keep the policy write lock through the local enqueue or first paid process spawn.
 * Never perform async/network work inside this callback. */
export function withScheduledPermission<T>(
  project: string,
  key: DeskRunKey,
  revision: DeskRevision,
  schedule: DeskSchedule,
  commit: () => T,
): T {
  const scope = watcherScope(project, key);
  return watcherTransaction((db) => {
    const watcher = db
      .query<{ state: string; lastError: string | null; baseline: string | null }, [string]>(
        "SELECT state,lastError,baseline FROM watchers WHERE id=?",
      )
      .get(scope);
    const work = db
      .query<RuleWork & { rule: string }, [string, string]>(
        `SELECT w.*,r.rule FROM review_rule_work w JOIN review_rules r ON r.watcher=w.watcher AND r.id=w.ruleId
        WHERE w.watcher=? AND w.id=?`,
      )
      .get(scope, schedule.attemptKey);
    if (
      !watcher ||
      watcher.state !== "enabled" ||
      !work?.valid ||
      work.state === "skipped" ||
      work.number !== key.number ||
      work.baseSha !== revision.baseSha ||
      work.headSha !== revision.headSha ||
      work.ruleId !== schedule.ruleId
    ) {
      throw new Error("stale: This scheduled review is no longer enabled.");
    }
    if (watcher.lastError || !watcher.baseline)
      throw new Error("unavailable: Waiting for a complete watcher poll.");
    const rule = JSON.parse(work.rule) as ReviewRule;
    const card = (JSON.parse(watcher.baseline) as WatchedCard[]).find((pr) => pr.number === key.number);
    if (
      !selectedRule(modeFor(db, scope, key.number), rule) ||
      (schedule.budgetTokens ?? null) !== (rule.budgetTokens ?? null) ||
      schedule.budgetMinutes !== rule.budgetMinutes ||
      !card ||
      card.baseSha !== revision.baseSha ||
      card.headSha !== revision.headSha ||
      !matchesCard(rule, card, work.recipient) ||
      (rule.requireGreen && card.ci !== "passed")
    ) {
      throw new Error("stale: The PR revision or rule conditions changed.");
    }
    return commit();
  });
}
