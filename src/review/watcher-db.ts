import { Database } from "bun:sqlite";
import { join } from "node:path";
import { ensureKeryxSubdir, keryxDataDir } from "../lib/config-dir";
import type { WatcherKey } from "./watcher-types";

export function watcherTransaction<T>(action: (db: Database) => T): T {
  const root = ensureKeryxSubdir(["desktop-review"], keryxDataDir());
  const db = new Database(join(root, "watchers.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout=8000");
    db.exec(`CREATE TABLE IF NOT EXISTS watchers (
      id TEXT PRIMARY KEY, cwd TEXT NOT NULL, target TEXT NOT NULL, state TEXT NOT NULL,
      intervalMinutes INTEGER NOT NULL, lastAttemptAt TEXT, lastSuccessAt TEXT, lastError TEXT,
      baseline TEXT, lease TEXT, pid INTEGER
    );
    CREATE TABLE IF NOT EXISTS watcher_pauses (watcher TEXT PRIMARY KEY, generation INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS watcher_events (id INTEGER PRIMARY KEY, watcher TEXT NOT NULL, event TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS recent_watcher_events ON watcher_events(watcher, id DESC);
    CREATE TABLE IF NOT EXISTS review_rules (
      watcher TEXT NOT NULL, id TEXT NOT NULL, rule TEXT NOT NULL, armed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (watcher, id)
    );
    CREATE TABLE IF NOT EXISTS review_pr_modes (
      watcher TEXT NOT NULL, number INTEGER NOT NULL, choice TEXT NOT NULL, armed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (watcher, number)
    );
    CREATE TABLE IF NOT EXISTS review_rule_work (
      id TEXT PRIMARY KEY, watcher TEXT NOT NULL, number INTEGER NOT NULL, ruleId TEXT NOT NULL,
      baseSha TEXT NOT NULL, headSha TEXT NOT NULL, recipient TEXT, state TEXT NOT NULL,
      reason TEXT NOT NULL, at TEXT NOT NULL, runId TEXT, valid INTEGER NOT NULL DEFAULT 1,
      checked INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS review_rule_queue ON review_rule_work(watcher, state, number);
    CREATE INDEX IF NOT EXISTS review_rule_history ON review_rule_work(watcher, at DESC);`);
    return db.transaction(() => action(db)).immediate();
  } finally {
    db.close();
  }
}

export const watcherScope = (cwd: string, key: WatcherKey) =>
  JSON.stringify([cwd, key.repositoryId, key.viewer.toLowerCase()]);
