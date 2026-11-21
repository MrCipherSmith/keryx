import type { Database } from "bun:sqlite";
import type { PrSubscription, PrWatchTopic, WatcherEvent } from "./watcher-types";

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

export function savePrSubscription(db: Database, scope: string, number: number, selected: PrWatchTopic[]) {
  if (selected.length) {
    const encoded = JSON.stringify([...new Set(selected)].sort());
    db.run(`INSERT INTO review_pr_subscriptions(watcher,number,topics) VALUES(?,?,?)
      ON CONFLICT(watcher,number) DO UPDATE SET topics=excluded.topics
      WHERE topics<>excluded.topics`, [scope, number, encoded]);
  } else {
    db.run("DELETE FROM review_pr_subscriptions WHERE watcher=? AND number=?", [scope, number]);
    db.run("DELETE FROM review_pr_subscription_events WHERE watcher=? AND number=?", [scope, number]);
  }
}

export function readPrSubscriptions(db: Database, scope: string, number: number | null): PrSubscription[] {
  const rows = db.query<{number: number; topics: string}, [string]>(
    "SELECT number,topics FROM review_pr_subscriptions WHERE watcher=? ORDER BY number",
  ).all(scope);
  return rows.map(row => ({
    number: row.number,
    topics: JSON.parse(row.topics) as PrWatchTopic[],
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
  const seen = new Set<number>();
  for (const event of events) {
    const topic = topics[event.kind];
    if (!topic || !subscriptions.get(event.number)?.includes(topic)) continue;
    db.run("INSERT INTO review_pr_subscription_events(watcher,number,event) VALUES(?,?,?)",
      [scope, event.number, JSON.stringify(event)]);
    seen.add(event.number);
  }
  for (const number of seen) {
    db.run(`DELETE FROM review_pr_subscription_events WHERE watcher=? AND number=? AND id <= (
      SELECT id FROM review_pr_subscription_events WHERE watcher=? AND number=? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
    [scope, number, scope, number, historyLimit]);
  }
}
