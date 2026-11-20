import type { scheduledRunOutcomes } from "./desk-run-store";
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { watcherTransaction as access, watcherScope as scope } from "./watcher-db";
import { linkedReviewRuns, observeRules } from "./review-rule-queue";
import { invalidateRuleWork } from "./review-rules";
import { dispatchReadyRules, type DispatchReviewRule } from "./review-rule-dispatch";
import { listReviewCards } from "./board";
import { boardGraphql } from "./board-github";
import { resolveWatcherCheckout } from "./watcher-project";
import type { ReviewBoardSnapshot } from "./board-types";
import { observedCards, watcherChanges, type WatchedCard } from "./watcher-events";
import {
  DEFAULT_WATCHER_MINUTES,
  type WatcherEvent,
  type WatcherKey,
  type WatcherSnapshot,
} from "./watcher-types";

type State = Pick<
  WatcherSnapshot,
  "state" | "intervalMinutes" | "lastAttemptAt" | "lastSuccessAt" | "lastError"
>;
type Row = State & { baseline: string | null; lease: string | null; pid: number | null };
const historyLimit = 50;

function snapshot(db: Database, id: string): WatcherSnapshot {
  const state = db
    .query<State, [string]>(
      "SELECT state,intervalMinutes,lastAttemptAt,lastSuccessAt,lastError FROM watchers WHERE id=?",
    )
    .get(id) ?? {
    state: "disabled",
    intervalMinutes: DEFAULT_WATCHER_MINUTES,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
  };
  const rows = db
    .query<{ event: string }, [string, number]>(
      "SELECT event FROM watcher_events WHERE watcher=? ORDER BY id DESC LIMIT ?",
    )
    .all(id, historyLimit);
  return {
    version: 1,
    installed: false,
    ...state,
    events: rows.map((r) => JSON.parse(r.event) as WatcherEvent),
  };
}

export function readWatcher(cwd: string, key: WatcherKey): WatcherSnapshot {
  return access((db) => snapshot(db, scope(cwd, key)));
}

export function listConfiguredWatchers(cwd: string): WatcherKey[] {
  return access((db) =>
    db
      .query<{ target: string }, [string]>("SELECT target FROM watchers WHERE cwd=? ORDER BY id")
      .all(cwd)
      .map((row) => JSON.parse(row.target) as WatcherKey),
  );
}

export function configureWatcher(cwd: string, key: WatcherKey, intervalMinutes: number): WatcherSnapshot {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
    throw new Error("configuration: Choose an interval between 1 and 1440 minutes.");
  }
  const id = scope(cwd, key);
  return access((db) => {
    db.run(
      `INSERT INTO watchers (id,cwd,target,state,intervalMinutes) VALUES (?,?,?,'enabled',?)
      ON CONFLICT(id) DO UPDATE SET state='enabled', target=excluded.target, intervalMinutes=excluded.intervalMinutes`,
      [id, cwd, JSON.stringify(key), intervalMinutes],
    );
    return snapshot(db, id);
  });
}

/** An explicit pause cancels installation requests still waiting for GitHub. */
export function watcherPauseGeneration(cwd: string, key: WatcherKey): number {
  return access(db => db.query<{generation: number}, [string]>("SELECT generation FROM watcher_pauses WHERE watcher=?")
    .get(scope(cwd, key))?.generation ?? 0);
}

export function pauseWatcher(cwd: string, key: WatcherKey): WatcherSnapshot {
  const id = scope(cwd, key);
  return access((db) => {
    db.run("INSERT INTO watcher_pauses(watcher,generation) VALUES(?,1) ON CONFLICT(watcher) DO UPDATE SET generation=generation+1", [id]);
    invalidateRuleWork(db, id, "Watcher paused");
    db.run("UPDATE watchers SET state='paused',baseline=NULL,lease=NULL,pid=NULL WHERE id=?", [id]);
    return snapshot(db, id);
  });
}

async function fetchOpenCards(cwd: string, key: WatcherKey): Promise<ReviewBoardSnapshot> {
  const checkout = await resolveWatcherCheckout(cwd, key.repo);
  return listReviewCards(
    key.repo,
    [key.repo],
    "open",
    (query, params) => boardGraphql(checkout, query, params),
    true,
  );
}

function validateObservation(board: ReviewBoardSnapshot, key: WatcherKey) {
  if (
    board.repositoryId !== key.repositoryId ||
    board.viewer.toLowerCase() !== key.viewer.toLowerCase() ||
    board.repo.toLowerCase() !== key.repo.toLowerCase()
  ) {
    throw new Error("access: The GitHub account or repository changed. Check the connection in Review.");
  }
  if (board.cards.some((card) => card.ci === "unknown")) {
    throw new Error(
      "unavailable: Could not verify CI for the current PR head. The watcher will retry on the next poll.",
    );
  }
  if (
    board.warnings.length ||
    board.cards.some(
      (card) =>
        card.state !== "open" ||
        !card.headSha ||
        !card.baseSha ||
        card.reviewersComplete === false ||
        card.assigneesComplete === false ||
        card.decision === undefined,
    )
  ) {
    throw new Error("unavailable: Incomplete PR snapshot. The watcher will retry on the next poll.");
  }
}

// listReviewCards bounds the complete traversal at 100s; allow room for the
// remote lookup and final in-flight gh call before reclaiming a stranded lease.
function activeLease(row: Row): boolean {
  if (!row.lease || !row.pid || !row.lastAttemptAt || Date.now() - Date.parse(row.lastAttemptAt) > 180_000)
    return false;
  try {
    process.kill(row.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function pollWatcher(
  cwd: string,
  key: WatcherKey,
  {
    fetch = fetchOpenCards,
    beforeFetch,
    dispatch,
    outcomes,
  }: {
    dispatch?: DispatchReviewRule;
    outcomes?: typeof scheduledRunOutcomes;
    fetch?: (cwd: string, key: WatcherKey) => Promise<ReviewBoardSnapshot>;
    beforeFetch?: () => Promise<void>;
  } = {},
): Promise<WatcherSnapshot> {
  const id = scope(cwd, key),
    token = randomUUID();
  const claimed = access((db) => {
    const row = db
      .query<Row, [string]>("SELECT state,lease,pid,lastAttemptAt FROM watchers WHERE id=?")
      .get(id);
    if (!row || row.state !== "enabled" || activeLease(row)) return false;
    db.run("UPDATE watchers SET lease=?,pid=?,lastAttemptAt=? WHERE id=?", [
      token,
      process.pid,
      new Date().toISOString(),
      id,
    ]);
    return true;
  });
  if (!claimed) return readWatcher(cwd, key);
  let cards: WatchedCard[] | undefined;
  let failure: string | null = null;
  let links: ReturnType<typeof linkedReviewRuns> = [];
  try {
    if (beforeFetch) await beforeFetch();
    const board = await fetch(cwd, key);
    validateObservation(board, key);
    links = access((db) => db.query("SELECT 1 FROM watchers WHERE id=? AND lease=? AND state='enabled'").get(id, token)
      ? linkedReviewRuns(db, id) : []);
    if (links.length) {
      // This can read an on-disk verdict. Keep it outside both SQLite transactions and only
      // after verifying this account. The commit below validates the lease again.
      const { reconcileLinkedScheduledRuns } = await import("./desk-run-service");
      await reconcileLinkedScheduledRuns(cwd, key, links, new Set(board.cards.map(card => card.number)));
    }
    cards = observedCards(board.cards);
  } catch (error) {
    failure =
      error instanceof Error && /^(unavailable|access|configuration):/.test(error.message)
        ? error.message
        : "unavailable: PR poll failed. The watcher will retry on the next poll.";
  }
  const observed = access((db) => {
    const row = db
      .query<{ baseline: string | null }, [string, string]>(
        "SELECT baseline FROM watchers WHERE id=? AND lease=?",
      )
      .get(id, token);
    if (!row) return false; // Another process paused or reclaimed the run.
    if (!cards) {
      db.run("UPDATE watchers SET lease=NULL,pid=NULL,lastError=? WHERE id=?", [failure, id]);
    } else {
      const at = new Date().toISOString();
      const changes =
        row.baseline === null ? [] : watcherChanges(JSON.parse(row.baseline) as WatchedCard[], cards, at);
      observeRules(db, id, cards, changes, at, outcomes, links);
      if (changes.length) {
        const insert = db.prepare("INSERT INTO watcher_events (watcher,event) VALUES (?,?)");
        for (const event of changes) insert.run(id, JSON.stringify(event));
        db.run(`DELETE FROM watcher_events WHERE watcher=? AND id < (
          SELECT id FROM watcher_events WHERE watcher=? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
        [id, id, historyLimit - 1]);
      }
      db.run("UPDATE watchers SET lease=NULL,pid=NULL,lastError=NULL,lastSuccessAt=?,baseline=? WHERE id=?", [
        at,
        JSON.stringify(cards),
        id,
      ]);
    }
    return !!cards;
  });
  if (observed) await dispatchReadyRules(cwd, key, dispatch);
  return readWatcher(cwd, key);
}
