import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { PrRepairSettings, PrRepairSource, PrSubscription, PrWatchTopic, WatcherEvent } from "./watcher-types";

const historyLimit = 30;
const topics: Partial<Record<WatcherEvent["kind"], PrWatchTopic>> = {
  review_submitted: "reviews",
  review_requested: "requests",
  review_request_removed: "requests",
  opened: "status",
  left_open: "status",
  draft_changed: "status",
  decision: "status",
  ci: "checks",
};

export function savePrSubscription(db: Database, scope: string, number: number, selected: PrWatchTopic[], rebase = false, repair?: PrRepairSettings, source?: PrRepairSource) {
  if (repair) {
    if (!source) throw new Error("configuration: Verify the pull request source before enabling automatic repairs.");
    db.run(`INSERT INTO review_pr_repairs(watcher,number,settings,repositoryId,branch,generation) VALUES(?,?,?,?,?,?)
      ON CONFLICT(watcher,number) DO UPDATE SET settings=excluded.settings,repositoryId=excluded.repositoryId,
        branch=excluded.branch,generation=excluded.generation
      WHERE settings<>excluded.settings OR repositoryId<>excluded.repositoryId OR branch<>excluded.branch`,
    [scope, number, JSON.stringify(repair), source.repositoryId, source.branch, randomUUID()]);
  } else {
    db.run("DELETE FROM review_pr_repairs WHERE watcher=? AND number=?", [scope, number]);
  }
  if (selected.length || rebase || repair) {
    const encoded = JSON.stringify([...new Set(selected)].sort());
    db.run(`INSERT INTO review_pr_subscriptions(watcher,number,topics,rebase) VALUES(?,?,?,?)
      ON CONFLICT(watcher,number) DO UPDATE SET topics=excluded.topics,rebase=excluded.rebase
      WHERE topics<>excluded.topics OR rebase<>excluded.rebase`, [scope, number, encoded, Number(rebase)]);
  } else {
    db.run("DELETE FROM review_pr_subscriptions WHERE watcher=? AND number=?", [scope, number]);
    db.run("DELETE FROM review_pr_rebase_attempts WHERE watcher=? AND number=?", [scope, number]);
    db.run("DELETE FROM review_pr_subscription_events WHERE watcher=? AND number=?", [scope, number]);
  }
}

export function readPrSubscriptions(db: Database, scope: string, number: number | null): PrSubscription[] {
  const rows = db.query<{number: number; topics: string; rebase: number; settings: string | null}, [string]>(
    `SELECT s.number,s.topics,s.rebase,r.settings FROM review_pr_subscriptions s
      LEFT JOIN review_pr_repairs r ON r.watcher=s.watcher AND r.number=s.number WHERE s.watcher=? ORDER BY s.number`,
  ).all(scope);
  return rows.map(row => ({
    number: row.number,
    topics: JSON.parse(row.topics) as PrWatchTopic[],
    ...(row.rebase && { rebase: true as const }),
    ...(row.settings && { repair: JSON.parse(row.settings) as PrRepairSettings }),
    ...(number === row.number && {
      activity: db.query<{event: string}, [string, number, number]>(
        "SELECT event FROM review_pr_subscription_events WHERE watcher=? AND number=? ORDER BY id DESC LIMIT ?",
      ).all(scope, row.number, historyLimit).map(item => JSON.parse(item.event) as WatcherEvent),
    }),
  }));
}

export function recordPrSubscriptionEvents(db: Database, scope: string, events: WatcherEvent[]) {
  if (!events.length) return;
  const subscriptions = new Map(readPrSubscriptions(db, scope, null).map(sub => [sub.number, sub.topics]));
  for (const event of events) {
    const topic = topics[event.kind];
    if (!topic || !subscriptions.get(event.number)?.includes(topic)) continue;
    appendPrSubscriptionEvent(db, scope, event);
  }
}

export function appendPrSubscriptionEvent(db: Database, scope: string, event: WatcherEvent) {
  const { number } = event;
  db.run("INSERT INTO review_pr_subscription_events(watcher,number,event) VALUES(?,?,?)",
    [scope, number, JSON.stringify(event)]);
  db.run(`DELETE FROM review_pr_subscription_events WHERE watcher=? AND number=? AND id <= (
      SELECT id FROM review_pr_subscription_events WHERE watcher=? AND number=? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
    [scope, number, scope, number, historyLimit]);
}
