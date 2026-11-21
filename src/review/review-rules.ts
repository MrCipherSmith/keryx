import { isDeepStrictEqual } from "node:util";
import type { Database } from "bun:sqlite";
import type {
  ReviewPrMode,
  ReviewRule,
  ReviewRuleAction,
  ReviewRuleActivity,
  ReviewRuleSnapshot,
} from "./review-rule-types";
import { readPrSubscriptions, savePrSubscription } from "./watcher-subscriptions";
import type { WatcherKey } from "./watcher-types";
import { watcherScope, watcherTransaction } from "./watcher-db";

export interface StoredRule {
  rule: string;
  armed: number;
}
export interface StoredMode {
  number: number;
  choice: string;
  armed: number;
}

export function ruleRows(db: Database, scope: string) {
  return db
    .query<StoredRule, [string]>("SELECT rule,armed FROM review_rules WHERE watcher=? ORDER BY id")
    .all(scope);
}

export function modeFor(db: Database, scope: string, number: number): ReviewPrMode {
  const row = db
    .query<{ choice: string }, [string, number]>(
      "SELECT choice FROM review_pr_modes WHERE watcher=? AND number=?",
    )
    .get(scope, number);
  return row ? (JSON.parse(row.choice) as ReviewPrMode) : { mode: "project" };
}

/** Pending jobs are cancelled, and an already linked run that has not yet spent budget loses permission. */
export function invalidateRuleWork(
  db: Database,
  scope: string,
  reason: string,
  ruleId: string | null = null,
  number: number | null = null,
) {
  // A poll begun before this change cannot establish its baseline.
  db.run("UPDATE watchers SET lease=NULL,pid=NULL WHERE id=? AND lease IS NOT NULL", [scope]);
  db.run(
    `UPDATE review_rule_work SET valid=0,
    reason=CASE WHEN state IN ('started','linked') THEN reason ELSE ? END,
    at=CASE WHEN state IN ('started','linked') THEN at ELSE ? END,
    state=CASE WHEN state IN ('started','linked') THEN state ELSE 'skipped' END
    WHERE watcher=? AND valid=1 AND (? IS NULL OR ruleId=?) AND (? IS NULL OR number=?)`,
    [reason, new Date().toISOString(), scope, ruleId, ruleId, number, number],
  );
}

export function applyReviewRuleAction(
  project: string,
  key: WatcherKey,
  action: ReviewRuleAction,
): ReviewRuleSnapshot {
  const scope = watcherScope(project, key);
  return watcherTransaction((db) => {
    const mutatingRule = action.kind === "save" || action.kind === "delete";
    const current = mutatingRule
      ? db.query<{ rule: string }, [string, string]>("SELECT rule FROM review_rules WHERE watcher=? AND id=?")
          .get(scope, action.kind === "save" ? action.rule.id : action.id)
      : null;
    if (mutatingRule && action.expected !== undefined &&
        !isDeepStrictEqual(action.expected, current ? JSON.parse(current.rule) : null)) {
      throw new Error("conflict: This rule was changed or deleted. Refresh the rules and open the editor again.");
    }
    if (action.kind === "save") {
      const encoded = JSON.stringify(action.rule);
      if (current?.rule !== encoded) {
        invalidateRuleWork(db, scope, `Rule settings changed: ${action.rule.name}`, action.rule.id);
        db.run(
          `INSERT INTO review_rules(watcher,id,rule) VALUES(?,?,?) ON CONFLICT(watcher,id)
          DO UPDATE SET rule=excluded.rule, armed=0`,
          [scope, action.rule.id, encoded],
        );
      }
    } else if (action.kind === "delete") {
      if (current) {
        invalidateRuleWork(
          db,
          scope,
          `Rule deleted: ${(JSON.parse(current.rule) as ReviewRule).name}`,
          action.id,
        );
        db.run("DELETE FROM review_rules WHERE watcher=? AND id=?", [scope, action.id]);
      }
    } else if (action.kind === "subscription") {
      savePrSubscription(db, scope, action.number, action.topics);
    } else if (action.kind === "mode") {
      if (action.choice.mode === "auto") {
        const rule = db
          .query<{ rule: string }, [string, string]>("SELECT rule FROM review_rules WHERE watcher=? AND id=?")
          .get(scope, action.choice.ruleId);
        if (!rule || !(JSON.parse(rule.rule) as ReviewRule).enabled)
          throw new Error("configuration: Select an enabled review rule.");
      }
      const choice = JSON.stringify(action.choice);
      if (JSON.stringify(modeFor(db, scope, action.number)) !== choice) {
        invalidateRuleWork(db, scope, "PR automation mode changed", null, action.number);
        db.run(
          `INSERT INTO review_pr_modes(watcher,number,choice) VALUES(?,?,?)
          ON CONFLICT(watcher,number) DO UPDATE SET choice=excluded.choice, armed=0`,
          [scope, action.number, choice],
        );
      }
    }
    const number = action.number ?? null;
    const activity = db
      .query<
        Omit<ReviewRuleActivity, "runId"> & { runId: string | null },
        [string, number | null, number | null]
      >(
        `SELECT number,at,headSha,reason,state,runId FROM review_rule_work
       WHERE watcher=? AND (? IS NULL OR number=?) ORDER BY at DESC,rowid DESC LIMIT 50`,
      )
      .all(scope, number, number)
      .map(({ runId, ...row }) => (runId ? { ...row, runId } : row));
    return {
      version: 1,
      rules: ruleRows(db, scope).map((row) => JSON.parse(row.rule) as ReviewRule),
      choice: number === null ? { mode: "project" } : modeFor(db, scope, number),
      activity,
      subscriptions: readPrSubscriptions(db, scope, number),
    };
  });
}
