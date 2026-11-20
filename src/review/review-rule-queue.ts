import { scheduledRunOutcomes } from "./desk-run-store";
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { ReviewPrMode, ReviewRule, ReviewRuleActivity } from "./review-rule-types";
import { ruleRows, type StoredMode } from "./review-rules";
import type { WatcherEvent } from "./watcher-types";
import type { WatchedCard } from "./watcher-events";

export interface RuleWork {
  id: string;
  number: number;
  ruleId: string;
  baseSha: string;
  headSha: string;
  recipient: string | null;
  state: ReviewRuleActivity["state"];
  reason: string;
  valid: number;
}

export function selectedRule(choice: ReviewPrMode, rule: ReviewRule) {
  return rule.enabled && (choice.mode === "project" || (choice.mode === "auto" && choice.ruleId === rule.id));
}
const includesLogin = (values: string[], filter: string) =>
  values.some((value) => value.toLowerCase() === filter.toLowerCase());
export function matchesCard(rule: ReviewRule, card: WatchedCard, recipient: string | null) {
  return (
    (!rule.author || card.author?.toLowerCase() === rule.author.toLowerCase()) &&
    (!rule.assignee || includesLogin(card.assignees ?? [], rule.assignee)) &&
    (!rule.reviewer || includesLogin(card.reviewers, rule.reviewer)) &&
    (!recipient || includesLogin(card.reviewers, recipient))
  );
}

export function updateWork(
  db: Database,
  id: string,
  state: ReviewRuleActivity["state"],
  reason: string,
  at: string,
) {
  db.run(
    `UPDATE review_rule_work SET state=?,reason=?,at=?,valid=?
    WHERE id=? AND valid=1 AND state IN ('ready','waiting') AND (state<>? OR reason<>?)`,
    [state, reason, at, state === "skipped" ? 0 : 1, id, state, reason],
  );
}

export function linkedReviewRuns(db: Database, scope: string) {
  return db.query<{ runId: string; number: number }, [string]>(
    `SELECT runId,number FROM review_rule_work WHERE watcher=?
      AND state IN ('started','linked') AND checked>=0 AND runId IS NOT NULL
      GROUP BY runId,number ORDER BY MIN(checked),MIN(rowid) LIMIT 50`,
  ).all(scope);
}

/** Only an explicit zero-spend refusal from the runner permits another automatic attempt. */
function refreshLinkedRuns(db: Database, scope: string, outcomes: typeof scheduledRunOutcomes, at: string,
  linked: ReturnType<typeof linkedReviewRuns>) {
  if (!linked.length) return;
  const { retryable, terminal } = outcomes(linked.map((row) => row.runId));
  for (const { runId } of linked) {
    if (retryable.has(runId)) {
      db.run("UPDATE review_rule_work SET checked=-1 WHERE watcher=? AND runId=? AND valid=0", [scope, runId]);
      db.run(
        `UPDATE review_rule_work SET state='waiting',runId=NULL,reason='Rechecking after preflight stopped before spending budget',at=?,checked=0
        WHERE watcher=? AND runId=? AND valid=1 AND state IN ('started','linked')`,
        [at, scope, runId],
      );
    } else {
      db.run("UPDATE review_rule_work SET checked=? WHERE watcher=? AND runId=?", [
        terminal.has(runId) ? -1 : Date.now(),
        scope,
        runId,
      ]);
    }
  }
}

/** Advance the outbox in the very transaction which commits this complete GitHub observation. */
export function observeRules(
  db: Database,
  scope: string,
  cards: WatchedCard[],
  events: WatcherEvent[],
  at: string,
  outcomes: typeof scheduledRunOutcomes = scheduledRunOutcomes,
  linked = linkedReviewRuns(db, scope),
) {
  refreshLinkedRuns(db, scope, outcomes, at, linked);
  const rules = new Map<string, ReviewRule>();
  for (const row of ruleRows(db, scope)) {
    const rule = JSON.parse(row.rule) as ReviewRule;
    if (rule.enabled && row.armed) rules.set(rule.id, rule);
  }
  const modes = new Map(
    db
      .query<StoredMode, [string]>("SELECT number,choice,armed FROM review_pr_modes WHERE watcher=?")
      .all(scope)
      .map((row) => [row.number, { choice: JSON.parse(row.choice) as ReviewPrMode, armed: row.armed }]),
  );
  const applies = (pr: number, rule: ReviewRule) => {
    const mode = modes.get(pr);
    return !mode || (mode.armed && selectedRule(mode.choice, rule));
  };
  const board = new Map(cards.map((card) => [card.number, card]));
  const pending = db
    .query<RuleWork, [string]>(
      "SELECT * FROM review_rule_work WHERE watcher=? AND valid=1 AND state IN ('ready','waiting')",
    )
    .all(scope);
  const seen = new Set<string>();
  const insert =
    db.prepare(`INSERT INTO review_rule_work(id,watcher,number,ruleId,baseSha,headSha,recipient,state,reason,at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`);
  function consider(rule: ReviewRule, card: WatchedCard, recipient: string | null, existing?: RuleWork) {
    const trigger = rule.event === "push" ? "new head commit" : `review requested from ${recipient}`;
    const wait = rule.requireGreen && card.ci !== "passed";
    const state = wait ? "waiting" : "ready";
    const reason = `${rule.name}: ${trigger}. ${wait ? "Waiting for green CI" : "Ready for scheduled review"}`;
    const fingerprint = JSON.stringify([rule.id, card.number, recipient?.toLowerCase()]);
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    if (existing) {
      // Preserve the last dispatch diagnostic while it is waiting for the next attempt.
      if (existing.state !== state) updateWork(db, existing.id, state, reason, at);
    } else {
      insert.run(
        randomUUID(),
        scope,
        card.number,
        rule.id,
        card.baseSha,
        card.headSha,
        recipient,
        state,
        reason,
        at,
      );
    }
  }
  for (const work of pending) {
    const rule = rules.get(work.ruleId);
    const card = board.get(work.number);
    if (!card || !rule || !applies(work.number, rule) || !matchesCard(rule, card, work.recipient)) {
      const cause = !card ? "PR is no longer open" : "Rule conditions no longer match";
      updateWork(db, work.id, "skipped", `${rule?.name ?? "Scheduled review"}: ${cause}`, at);
      continue;
    }
    if (work.headSha !== card.headSha || work.baseSha !== card.baseSha) {
      updateWork(db, work.id, "skipped", `${rule.name}: Replaced by the current PR revision`, at);
      // A request still pending on the PR follows its latest reviewable range.
      consider(rule, card, work.recipient);
    } else {
      consider(rule, card, work.recipient, work);
    }
  }
  for (const event of events) {
    if (event.kind !== "push" && event.kind !== "review_requested") continue;
    const card = board.get(event.number);
    if (!card) continue;
    for (const rule of rules.values()) {
      if (rule.event !== event.kind || !applies(event.number, rule)) continue;
      if (
        event.kind === "review_requested" &&
        rule.reviewer &&
        rule.reviewer.toLowerCase() !== event.reviewer?.toLowerCase()
      )
        continue;
      const recipient = event.kind === "review_requested" ? event.reviewer : rule.reviewer || null;
      if (recipient === undefined || !matchesCard(rule, card, recipient)) continue;
      consider(rule, card, recipient);
    }
  }
  // An enabling edit or a PR mode switch acquires its own baseline with this complete poll.
  db.run("UPDATE review_rules SET armed=1 WHERE watcher=? AND armed=0", [scope]);
  db.run("UPDATE review_pr_modes SET armed=1 WHERE watcher=? AND armed=0", [scope]);
}
