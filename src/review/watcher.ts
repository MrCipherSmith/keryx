import type { RunPrRepair } from "./watcher-repair";
import { scheduledRunOutcomes } from "./desk-run-store";
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { watcherTransaction as access, watcherScope as scope } from "./watcher-db";
import { linkedReviewRuns, observeRules } from "./review-rule-queue";
import { invalidateRuleWork } from "./review-rules";
import { dispatchReadyRules, type DispatchReviewRule } from "./review-rule-dispatch";
import { listReviewCards } from "./board";
import { boardGraphql, projectGithubConnection } from "./board-github";
import { projectGithubBinding, saveProjectGithubBinding, verifyProjectGithubAccountIntent } from "./github-account-store";
import { resolveWatcherCheckout } from "./watcher-project";
import { rebaseWatchedPullRequests } from "./watcher-rebase";
import type { ReviewCard, ReviewBoardSnapshot } from "./board-types";
import { recordPrSubscriptionEvents } from "./watcher-subscriptions";
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
  const { warning, ...state } = db
    .query<State & { warning: string | null }, [string]>(
      `SELECT state,intervalMinutes,lastAttemptAt,lastSuccessAt,lastError,warning
       FROM watchers LEFT JOIN watcher_recovery_warnings ON watcher=id WHERE id=?`,
    )
    .get(id) ?? {
    state: "disabled",
    intervalMinutes: DEFAULT_WATCHER_MINUTES,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    warning: null,
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
    ...(warning ? { recoveryWarning: warning } : {}),
    events: rows.map((r) => JSON.parse(r.event) as WatcherEvent),
  };
}

export function readWatcher(cwd: string, key: WatcherKey): WatcherSnapshot {
  return access((db) => snapshot(db, scope(cwd, key)));
}

export function listConfiguredWatchers(cwd: string, connection?: Database): WatcherKey[] {
  if (!connection) return access((db) => listConfiguredWatchers(cwd, db));
  return connection.query<{ target: string }, [string]>("SELECT target FROM watchers WHERE cwd=? ORDER BY id")
    .all(cwd)
    .map((row) => JSON.parse(row.target) as WatcherKey);
}

export function configureWatcher(
  cwd: string, key: WatcherKey, intervalMinutes: number,
  guard?: { project: string; order: number },
): WatcherSnapshot {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
    throw new Error("configuration: Choose an interval between 1 and 1440 minutes.");
  }
  const id = scope(cwd, key);
  return access((db) => {
    if (guard) {
      const binding = projectGithubBinding(guard.project, db);
      if (binding && (binding.generation > guard.order ||
          binding.login?.toLowerCase() !== key.viewer.toLowerCase())) {
        throw new Error("access: The project's GitHub account changed. Refresh Review.");
      }
    }
    db.run(
      `INSERT INTO watchers (id,cwd,target,state,intervalMinutes) VALUES (?,?,?,'enabled',?)
      ON CONFLICT(id) DO UPDATE SET state='enabled', target=excluded.target, intervalMinutes=excluded.intervalMinutes`,
      [id, cwd, JSON.stringify(key), intervalMinutes],
    );
    return snapshot(db, id);
  });
}

function nextOperation(db: Database): number {
  return db.query<{ ordinal: number }, []>(
    `INSERT INTO watcher_operation_order (id,ordinal)
      VALUES (1, (SELECT COALESCE(MAX(generation),0) + 1 FROM watcher_pauses))
      ON CONFLICT(id) DO UPDATE SET ordinal=MAX(watcher_operation_order.ordinal+1,excluded.ordinal)
      RETURNING ordinal`,
  ).get()!.ordinal;
}

/** Reserve the user's ordering before any asynchronous checkout or GitHub lookup. */
export function beginWatcherOperation(): number {
  return access(nextOperation);
}

/** An explicit pause cancels installation requests still waiting for GitHub. */
export function watcherPauseGeneration(cwd: string, key: WatcherKey): number {
  return access(db => db.query<{generation: number}, [string]>("SELECT generation FROM watcher_pauses WHERE watcher=?")
    .get(scope(cwd, key))?.generation ?? 0);
}

function pauseWatcherInTransaction(db: Database, id: string, order: number) {
  db.run(
    `INSERT INTO watcher_pauses(watcher,generation) VALUES(?,?)
     ON CONFLICT(watcher) DO UPDATE SET generation=MAX(generation,excluded.generation)`,
    [id, order],
  );
  invalidateRuleWork(db, id, "Watcher paused");
  db.run("UPDATE watchers SET state='paused',baseline=NULL,lease=NULL,pid=NULL WHERE id=?", [id]);
}

export function pauseWatcher(cwd: string, key: WatcherKey, order?: number): WatcherSnapshot {
  const id = scope(cwd, key);
  return access((db) => {
    pauseWatcherInTransaction(db, id, order ?? nextOperation(db));
    return snapshot(db, id);
  });
}

/** The binding change and invalidation of existing scheduled work share one transaction. */
export function changeProjectGithubBinding(project: string, cwd: string, login: string | null, order: number): WatcherKey[] {
  return access((db) => {
    verifyProjectGithubAccountIntent(db, project, order);
    const previous = projectGithubBinding(project, db);
    const selected = login?.toLowerCase();
    if (previous && previous.login?.toLowerCase() === selected) return [];
    // A matching legacy watcher has already verified this viewer and repository.
    // Preserve its schedule and baseline when the same viewer is first made explicit.
    const keys = listConfiguredWatchers(cwd, db).filter(key => previous !== null || key.viewer.toLowerCase() !== selected);
    for (const key of keys) pauseWatcherInTransaction(db, scope(cwd, key), order);
    saveProjectGithubBinding(db, project, login, order);
    return keys;
  });
}

async function fetchOpenCards(cwd: string, key: WatcherKey): Promise<ReviewBoardSnapshot> {
  const checkout = await resolveWatcherCheckout(cwd, key.repo);
  const auth = await projectGithubConnection(checkout, process.env, key.viewer);
  return listReviewCards(
    key.repo,
    [key.repo],
    "open",
    (query, params) => boardGraphql(checkout, query, params, auth),
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
    dispatch,
    runPrRepair,
    outcomes = scheduledRunOutcomes,
  }: {
    dispatch?: DispatchReviewRule;
    runPrRepair?: RunPrRepair;
    outcomes?: typeof scheduledRunOutcomes;
    fetch?: (cwd: string, key: WatcherKey) => Promise<ReviewBoardSnapshot>;
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
  let openCards: ReviewCard[] = [];
  let failure: string | null = null;
  let recoveryWarning: string | null = null;
  let settled: { links: ReturnType<typeof linkedReviewRuns>; outcomes: ReturnType<typeof scheduledRunOutcomes> } | undefined;
  try {
    const board = await fetch(cwd, key);
    validateObservation(board, key);
    cards = observedCards(board.cards);
    openCards = board.cards;
    try {
      const links = access((db) => db.query("SELECT 1 FROM watchers WHERE id=? AND lease=? AND state='enabled'").get(id, token)
        ? linkedReviewRuns(db, id) : []);
      if (links.length) {
        // Read a verdict outside the SQLite transaction and only after verifying this account.
        const { reconcileLinkedScheduledRuns } = await import("./desk-run-service");
        if (!await reconcileLinkedScheduledRuns(cwd, key, links, new Set(board.cards.map(card => card.number)))) {
          recoveryWarning = "A scheduled review could not be recovered. The watcher will retry.";
        }
        settled = { links, outcomes: outcomes(links.map(link => link.runId)) };
      }
    } catch {
      recoveryWarning = "Scheduled review history could not be recovered. The watcher will retry.";
    }
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
      observeRules(db, id, cards, changes, at, settled);
      recordPrSubscriptionEvents(db, id, changes);
      if (changes.length) {
        const insert = db.prepare("INSERT INTO watcher_events (watcher,event) VALUES (?,?)");
        for (const event of changes.slice(-historyLimit)) insert.run(id, JSON.stringify(event));
        db.run(`DELETE FROM watcher_events WHERE watcher=? AND id < (
          SELECT id FROM watcher_events WHERE watcher=? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
        [id, id, historyLimit - 1]);
      }
      if (recoveryWarning) {
        db.run(`INSERT INTO watcher_recovery_warnings(watcher,warning) VALUES(?,?)
          ON CONFLICT(watcher) DO UPDATE SET warning=excluded.warning`, [id, recoveryWarning]);
      } else {
        db.run("DELETE FROM watcher_recovery_warnings WHERE watcher=?", [id]);
      }
      db.run("UPDATE watchers SET lease=NULL,pid=NULL,lastError=NULL,lastSuccessAt=?,baseline=? WHERE id=?", [
        at,
        JSON.stringify(cards),
        id,
      ]);
    }
    return !!cards;
  });
  if (observed) {
    const branchUpdates = openCards.filter(card => card.watcherMergeState === "BEHIND" || card.watcherMergeState === "DIRTY");
    if (branchUpdates.length) await rebaseWatchedPullRequests(cwd, key, branchUpdates);
    await dispatchReadyRules(cwd, key, dispatch);
    if (runPrRepair) {
      const { repairWatchedPullRequests } = await import("./watcher-repair");
      await repairWatchedPullRequests(cwd, key, openCards, runPrRepair);
    }
  }
  return readWatcher(cwd, key);
}
