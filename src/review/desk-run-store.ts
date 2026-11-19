import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ReviewBoardSnapshot } from "./board-types";
import { ensureKeryxConfigDir, keryxDataDir, readConfigFile } from "../lib/config-dir";
import { DESK_RUN_SCOPE } from "./desk-run-types";
import type { DeskFinish, DeskRevision, DeskRun, DeskRunKey, DeskRunSnapshot, DeskSchedule } from "./desk-run-types";

export const deskRunRoot = () => path.join(keryxDataDir(), "desktop-review");
export const MAX_SCHEDULED_PREFLIGHT_ATTEMPTS = 3;
const liveStates = "('running', 'cancelling')";
export interface Attempt {
  key: DeskRunKey;
  cwd: string;
  run: DeskRun;
  pid: number | null;
}
interface Row {
  request: string;
  details: string;
  pid: number | null;
  cwd: string;
}
const decode = (row: Row): Attempt => ({
  key: JSON.parse(row.request) as DeskRunKey,
  run: JSON.parse(row.details) as DeskRun,
  pid: row.pid,
  cwd: row.cwd,
});
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export class DeskRunStore {
  private readonly db: Database;
  constructor(readonly root = deskRunRoot(), readOnly = false) {
    if (readOnly) {
      this.db = new Database(path.join(root, "runs.sqlite"), { readonly: true });
      return;
    }
    ensureKeryxConfigDir(root);
    this.db = new Database(path.join(root, "runs.sqlite"));
    this.db.exec("PRAGMA busy_timeout=8000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, repo TEXT NOT NULL, pr INTEGER NOT NULL, viewer TEXT COLLATE NOCASE NOT NULL,
      state TEXT NOT NULL, pid INTEGER, cwd TEXT NOT NULL, request TEXT NOT NULL, details TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history_scans (
      cwd TEXT NOT NULL, repo TEXT NOT NULL, pr INTEGER NOT NULL, viewer TEXT COLLATE NOCASE NOT NULL,
      scanned INTEGER NOT NULL, PRIMARY KEY(cwd,repo,pr,viewer)
    );
    CREATE INDEX IF NOT EXISTS review_history ON runs(repo, viewer, pr);
    CREATE UNIQUE INDEX IF NOT EXISTS active_pr ON runs(repo, pr) WHERE state IN ${liveStates};
    CREATE UNIQUE INDEX IF NOT EXISTS next_pr_for_viewer ON runs(repo, pr, viewer) WHERE state='queued';`);
  }

  close() {
    this.db.close();
  }
  atomic<T>(fn: () => T) {
    return this.db.transaction(fn).immediate();
  }
  directory(id: string) {
    return path.join(this.root, "attempts", id);
  }

  byId(id: string): Attempt | undefined {
    const row = this.db.query<Row, [string]>("SELECT * FROM runs WHERE id=?").get(id);
    return row ? decode(row) : undefined;
  }

  private forPr(key: DeskRunKey, condition: string) {
    const row = this.db
      .query<Row, [string, number]>(
        `SELECT * FROM runs WHERE repo=? AND pr=? AND ${condition} ORDER BY rowid DESC LIMIT 1`,
      )
      .get(key.repositoryId, key.number);
    return row ? decode(row) : undefined;
  }
  active(key: DeskRunKey) {
    return this.forPr(key, `state IN ${liveStates}`);
  }
  queued(key: DeskRunKey) {
    const row = this.db
      .query<Row, [string, number, string]>(
        "SELECT * FROM runs WHERE repo=? AND pr=? AND viewer=? AND state='queued'",
      )
      .get(key.repositoryId, key.number, key.viewer);
    return row ? decode(row) : undefined;
  }

  save(a: Attempt) {
    this.db.run("UPDATE runs SET state=?, pid=?, details=? WHERE id=?", [
      a.run.state,
      a.pid,
      JSON.stringify(a.run),
      a.run.id,
    ]);
  }

  end(a: Attempt, finish: DeskFinish) {
    const retryable =
      finish.retryableBeforeSpend &&
      a.run.source === "scheduled" &&
      a.run.state !== "cancelling" &&
      (a.run.preflightAttempt ?? 1) < MAX_SCHEDULED_PREFLIGHT_ATTEMPTS;
    Object.assign(a.run, finish, { finishedAt: new Date().toISOString() });
    if (!retryable) delete a.run.retryableBeforeSpend;
    a.pid = null;
    this.save(a);
  }

  claimHistoryScan(cwd: string, key: DeskRunKey): boolean {
    const now = Date.now();
    return (
      this.db.run(
        `INSERT INTO history_scans (cwd,repo,pr,viewer,scanned) VALUES (?,?,?,?,?)
      ON CONFLICT(cwd,repo,pr,viewer) DO UPDATE SET scanned=excluded.scanned WHERE scanned < ?`,
        [cwd, key.repositoryId, key.number, key.viewer, now, now - 300_000],
      ).changes > 0
    );
  }

  recordExisting(cwd: string, key: DeskRunKey, runs: DeskRun[]) {
    for (const run of runs) {
      this.db.run(
        `INSERT INTO runs (id,repo,pr,viewer,state,cwd,request,details) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET details=excluded.details
        WHERE json_extract(runs.details,'$.source')='existing'`,
        [
          run.id,
          key.repositoryId,
          key.number,
          key.viewer,
          run.state,
          cwd,
          JSON.stringify(key),
          JSON.stringify(run),
        ],
      );
    }
  }

  history(key: DeskRunKey, id?: string): DeskRunSnapshot {
    // Keep periodic IPC responses bounded. The database retains full reports.
    // Return small recent reports inline and load the rest by attempt id.
    const reportSelect =
      id === undefined ? "CASE WHEN cumulative <= 131072 THEN report ELSE '' END" : "substr(report,1,524288)";
    type Item = { details: string; bytes: number; chars: number; report: string };
    const selected = id === undefined ? "" : " AND id=?";
    const sql = `WITH scoped AS (
        SELECT rowid AS seq,json_extract(details,'$.createdAt') AS created, json_remove(details,'$.result.report') AS metadata,
          coalesce(json_extract(details,'$.result.report'),'') AS report
        FROM runs WHERE repo=? AND pr=? AND viewer=?${selected}
      ), measured AS (
        SELECT *,length(CAST(report AS BLOB)) AS bytes,
          sum(length(CAST(report AS BLOB))) OVER (ORDER BY created DESC,seq DESC) AS cumulative
        FROM scoped
      ) SELECT metadata AS details,bytes,length(report) AS chars,${reportSelect} AS report
        FROM measured ORDER BY created DESC,seq DESC`;
    const params = [key.repositoryId, key.number, key.viewer];
    if (id !== undefined) params.push(id);
    const rows = this.db.query<Item, (string | number)[]>(sql).all(...params);
    if (id !== undefined && !rows.length)
      throw new Error("access: This attempt is unavailable for the selected account and pull request.");
    const runs = rows.map((row) => {
      const run = JSON.parse(row.details) as DeskRun;
      if (run.result) {
        run.result.report = row.report;
        if (id === undefined && row.bytes > 0 && !row.report) run.result.reportDeferred = true;
        if (id !== undefined && row.chars > 524288) {
          run.result.report +=
            "\n\nPreview truncated. Full result: " +
            path.join(this.directory(run.id), "execution-result.json");
        }
      }
      return run;
    });
    return { version: 1, runs };
  }

  attachBadges(snapshot: ReviewBoardSnapshot) {
    type BadgeRow = {
      pr: number;
      state: string;
      base: string | null;
      head: string | null;
      requestedBase: string;
      requestedHead: string;
      planned: number | null;
      finished: number | null;
      wave: number | null;
    };
    const rows = this.db
      .query<BadgeRow, [string, string]>(
        `
      SELECT pr,state,json_extract(details,'$.result.reviewed.baseSha') AS base,
        json_extract(details,'$.result.reviewed.headSha') AS head,
        json_extract(details,'$.baseSha') AS requestedBase, json_extract(details,'$.headSha') AS requestedHead,
        json_extract(details,'$.reviewerProgress.planned') AS planned, json_extract(details,'$.reviewerProgress.finished') AS finished,
        json_extract(details,'$.reviewerProgress.wave') AS wave
      FROM runs WHERE repo=? AND viewer=? AND json_extract(details,'$.source') IN ('manual','scheduled')`,
      )
      .all(snapshot.repositoryId, snapshot.viewer);
    const cards = new Map(snapshot.cards.map((card) => [card.number, card]));
    for (const row of rows) {
      const card = cards.get(row.pr);
      if (!card) continue;
      const badge = (card.localReview ??= { active: false, ready: false });
      if (["queued", "running", "cancelling"].includes(row.state)) {
        badge.active = true;
        if (row.finished !== null && row.requestedBase === card.baseSha && row.requestedHead === card.headSha) {
          badge.progress = { planned: row.planned, finished: row.finished, wave: row.wave };
        }
      }
      if (
        ["completed", "partial", "budget"].includes(row.state) &&
        row.base === card.baseSha &&
        row.head === card.headSha
      )
        badge.ready = true;
    }
  }

  /** Called inside the dispatch transaction. An automatic request never queues behind,
   * or supersedes, a different revision: the watcher rechecks eligibility at its next poll. */
  request(cwd: string, key: DeskRunKey, revision: DeskRevision, schedule?: DeskSchedule): string | null {
    return this.requestAttempt(cwd, key, revision, schedule)?.id ?? null;
  }

  requestAttempt(
    cwd: string,
    key: DeskRunKey,
    revision: DeskRevision,
    schedule?: DeskSchedule,
  ): { id: string; reused: boolean } | null {
    const match = (a: Attempt) =>
      a.key.viewer.toLowerCase() === key.viewer.toLowerCase() &&
      a.run.baseSha === revision.baseSha &&
      a.run.headSha === revision.headSha;
    const active = this.active(key);
    const queued = this.queued(key);
    if (active && match(active)) return { id: active.run.id, reused: true };
    if (queued && match(queued)) return { id: queued.run.id, reused: true };
    if (schedule && (active || queued)) return null;
    if (queued) {
      this.end(queued, {
        state: "skipped",
        phase: "Superseded",
        reason: "A newer revision was requested.",
        result: null,
      });
    }
    const previous = this.db
      .query<
        { id: string; state: string; complete: number; retryable: number | null; attempt: number | null },
        [string, string, number, string, string, string]
      >(
        `SELECT id,state,json_extract(details,'$.retryableBeforeSpend') AS retryable,
         json_extract(details,'$.preflightAttempt') AS attempt,
         (json_extract(details,'$.scope')=? AND json_extract(details,'$.result.coverage')='complete'
          AND json_extract(details,'$.result.reviewed.baseSha')=json_extract(details,'$.baseSha')
          AND json_extract(details,'$.result.reviewed.headSha')=json_extract(details,'$.headSha')) AS complete
       FROM runs WHERE repo=? AND pr=? AND viewer=? AND json_extract(details,'$.baseSha')=?
         AND json_extract(details,'$.headSha')=? AND json_extract(details,'$.source') IN ('manual','scheduled')
       ORDER BY rowid DESC LIMIT 1`,
      )
      .get(DESK_RUN_SCOPE, key.repositoryId, key.number, key.viewer, revision.baseSha, revision.headSha);
    // Failures, cancellations and partial results may already have consumed budget.
    // Only an explicit manual request may buy another attempt for this same range.
    if (
      previous &&
      ((schedule && !previous.retryable) || (previous.state === "completed" && previous.complete))
    ) {
      return { id: previous.id, reused: true };
    }
    const run: DeskRun = {
      id: randomUUID(),
      source: schedule ? "scheduled" : "manual",
      ...(schedule ? { schedule, preflightAttempt: (previous?.attempt ?? 0) + 1 } : {}),
      scope: DESK_RUN_SCOPE,
      ...revision,
      state: "queued",
      phase: "Queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      reason: "Waiting to start.",
      result: null,
    };
    this.db.run("INSERT INTO runs (id,repo,pr,viewer,state,cwd,request,details) VALUES (?,?,?,?,?,?,?,?)", [
      run.id,
      key.repositoryId,
      key.number,
      key.viewer,
      run.state,
      cwd,
      JSON.stringify(key),
      JSON.stringify(run),
    ]);
    return { id: run.id, reused: false };
  }

  cancel(key: DeskRunKey, id: string) {
    const a = this.byId(id);
    if (
      !a ||
      a.key.repositoryId !== key.repositoryId ||
      a.key.number !== key.number ||
      a.key.viewer.toLowerCase() !== key.viewer.toLowerCase()
    ) {
      throw new Error("access: This attempt is unavailable for the selected account and pull request.");
    }
    if (a.run.state === "queued")
      this.end(a, {
        state: "cancelled",
        phase: "Cancelled",
        reason: "Cancelled before dispatch.",
        result: null,
      });
    if (a.run.state === "running") {
      Object.assign(a.run, {
        state: "cancelling",
        phase: "Stopping",
        reason: "Cancellation requested.",
      });
      this.save(a);
    }
  }

  /** Verify both owner and descendant liveness before freeing the single execution slot. */
  reconcile(key: DeskRunKey, readFinish: (directory: string, attempt: Attempt) => DeskFinish | null) {
    const a = this.active(key);
    if (!a || a.pid === null || alive(a.pid)) return;
    const directory = this.directory(a.run.id);
    const guard = path.join(directory, "child.json");
    const marker = readConfigFile(guard);
    if (!marker.ok && marker.reason !== "absent") throw new Error("Cannot inspect the Review worker process marker.");
    if (marker.ok) {
      const child = JSON.parse(marker.text) as { pid: number };
      if (
        Number.isSafeInteger(child.pid) &&
        child.pid > 0 &&
        (alive(child.pid) || (process.platform !== "win32" && alive(-child.pid)))
      )
        return;
    }
    // A detached worker is a process-group leader on macOS/Linux. This also
    // covers a crash immediately after spawning its runner, before child.json.
    if (process.platform !== "win32" && alive(-a.pid)) return;
    const finish = readFinish(directory, a);
    if (finish) {
      this.end(a, finish);
      return;
    }
    const cancelled = a.run.state === "cancelling";
    this.end(a, {
      state: cancelled ? "cancelled" : "failed",
      phase: "Interrupted",
      reason: cancelled
        ? "The review stopped after cancellation."
        : "The review worker exited without a final result. Retry the review.",
      result: null,
    });
  }
}

/** A scheduler may re-arm only a known pre-spend refusal. A missing or interrupted
 * worker never proves that an already launched model consumed zero budget. */
export function scheduledRunOutcomes(ids: string[], root = deskRunRoot()): {retryable: Set<string>; terminal: Set<string>} {
  const pathToStore = path.join(root, "runs.sqlite");
  const result = {retryable: new Set<string>(), terminal: new Set<string>()};
  if (!ids.length || !existsSync(pathToStore)) return result;
  const db = new Database(pathToStore, {readonly: true});
  try {
    db.exec("PRAGMA busy_timeout=8000");
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      const rows = db.query<{id:string; retryable:number | null},string[]>(
        `SELECT id, json_extract(details,'$.retryableBeforeSpend') AS retryable FROM runs
         WHERE id IN (${batch.map(() => "?").join(",")}) AND state NOT IN ('queued','running','cancelling')`
      ).all(...batch);
      for (const row of rows) (row.retryable ? result.retryable : result.terminal).add(row.id);
    }
    return result;
  } finally { db.close(); }
}

// A project without review history can list its PRs without creating a store.
export function attachDeskRunBadges(snapshot: ReviewBoardSnapshot) {
  if (!existsSync(path.join(deskRunRoot(), "runs.sqlite"))) return snapshot;
  let store: DeskRunStore | undefined;
  try {
    store = new DeskRunStore();
    store.attachBadges(snapshot);
  } catch {
    snapshot.warnings.push("Local review progress could not be read.");
  } finally {
    store?.close();
  }
  return snapshot;
}
