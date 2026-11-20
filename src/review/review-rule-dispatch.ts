import type { DeskRevision, DeskRunKey, DeskRun, DeskSchedule } from "./desk-run-types";
import type { ReviewRule } from "./review-rule-types";
import { withScheduledPermission } from "./review-automation-guard";
import { type RuleWork } from "./review-rule-queue";
import { watcherScope, watcherTransaction } from "./watcher-db";
import { resolveWatcherCheckout } from "./watcher-project";
import type { WatcherKey } from "./watcher-types";

interface SubmittedRuleRun {
  id: string;
  reused?: boolean;
  source?: DeskRun["source"];
  state?: DeskRun["state"];
}

export type DispatchReviewRule = (
  project: string,
  key: DeskRunKey,
  revision: DeskRevision,
  schedule: DeskSchedule,
  authorize: <T>(commit: () => T) => T,
) => Promise<SubmittedRuleRun | null>;

const dispatch: DispatchReviewRule = async (project, key, revision, schedule, authorize) => {
  const { scheduleDeskReview } = await import("./desk-run-service");
  const checkout = await resolveWatcherCheckout(project, key.repo);
  return scheduleDeskReview(checkout, key, revision, schedule, authorize);
};

export async function dispatchReadyRules(
  project: string,
  key: WatcherKey,
  start: DispatchReviewRule = dispatch,
) {
  const scope = watcherScope(project, key);
  const ready = watcherTransaction((db) =>
    db
      .query<RuleWork & { rule: string }, [string]>(
        `SELECT ranked.* FROM (SELECT w.*,r.rule,ROW_NUMBER() OVER(PARTITION BY w.number ORDER BY w.checked,w.rowid) AS priority
      FROM review_rule_work w JOIN review_rules r ON w.watcher=r.watcher AND w.ruleId=r.id
      WHERE w.watcher=? AND w.state='ready' AND w.valid=1) ranked WHERE priority=1 ORDER BY checked,number LIMIT 50`,
      )
      .all(scope),
  );
  for (const work of ready) {
    const target = { ...key, number: work.number };
    const rule = JSON.parse(work.rule) as ReviewRule;
    const schedule: DeskSchedule = {
      project,
      ruleId: rule.id,
      ruleName: rule.name,
      event: rule.event,
      recipient: work.recipient,
      requireGreen: rule.requireGreen,
      author: rule.author,
      assignee: rule.assignee,
      budgetMinutes: rule.budgetMinutes,
      budgetTokens: rule.budgetTokens ?? null,
      attemptKey: work.id,
    };
    const revision = { baseSha: work.baseSha, headSha: work.headSha };
    const authorize = <T>(commit: () => T) =>
      withScheduledPermission(project, target, revision, schedule, commit);
    let run: SubmittedRuleRun | null = null;
    let detail = "An earlier PR revision is still running";
    try {
      authorize(() => undefined);
      run = await start(project, target, revision, schedule, authorize);
    } catch (err) {
      detail =
        err instanceof Error && /^(configuration|access|stale|unavailable):/.test(err.message)
          ? err.message
          : "Could not submit the scheduled review. It will be rechecked on the next poll.";
    }
    const at = new Date().toISOString();
    watcherTransaction((db) => {
      if (run) {
        // Every eligible match on this range is fulfilled by the same durable desk run.
        const matches = db
          .query<RuleWork & { rule: string }, [string, number, string, string]>(
            `SELECT w.*,r.rule FROM review_rule_work w JOIN review_rules r ON r.watcher=w.watcher AND r.id=w.ruleId
           WHERE w.watcher=? AND w.number=? AND w.baseSha=? AND w.headSha=? AND w.valid=1 AND w.state='ready'`,
          )
          .all(scope, work.number, work.baseSha, work.headSha);
        for (const match of matches) {
          const matchedRule = JSON.parse(match.rule) as ReviewRule;
          const trigger =
            matchedRule.event === "push" ? "new head commit" : "review requested from " + match.recipient;
          const launched = match.id === work.id && !run.reused;
          const detail = run.reused
            ? `Linked to a ${run.source} review (${run.state})`
            : launched
              ? "Submitted scheduled review"
              : "Covered by the same scheduled review";
          db.run("UPDATE review_rule_work SET state=?,reason=?,at=?,runId=?,checked=0 WHERE id=?", [
            launched ? "started" : "linked",
            `${matchedRule.name}: ${trigger}. ${detail}`,
            at,
            run.id,
            match.id,
          ]);
        }
      } else {
        db.run(
          `UPDATE review_rule_work SET reason=?,at=?,checked=? WHERE id=? AND valid=1 AND state='ready'`,
          [`${rule.name}: ${detail}`, at, Date.now(), work.id],
        );
      }
    });
  }
}
