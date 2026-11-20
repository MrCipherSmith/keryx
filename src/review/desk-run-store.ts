import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { localBadge, type BadgeCard } from "./board-badges";
import type { ReviewBoardSnapshot } from "./board-types";
import { ensureKeryxConfigDir, keryxDataDir, readConfigFile } from "../lib/config-dir";
import { processPresence, type ProcessIdentity } from "../lib/hub-machine/process-identity";
import { DESK_RUN_SCOPE } from "./desk-run-types";
import { summarizeReviewerAssignments } from "./reviewer-activity";
import type { DeskFinish, DeskRevision, DeskRun, DeskRunKey, DeskRunSnapshot, DeskSchedule } from "./desk-run-types";

export const deskRunRoot = () => path.join(keryxDataDir(), "desktop-review");
export const MAX_SCHEDULED_PREFLIGHT_ATTEMPTS = 3;
const maxScheduledWorkers = 4;
const liveStates = "('running', 'cancelling')";
const scheduledReservation = "state IN ('queued','running','cancelling') AND json_extract(details,'$.source')='scheduled'";
type ScheduledLink = { project: string; runId: string };
const linkedActiveRow = `FROM runs WHERE id=? AND repo=? AND pr=? AND viewer=?
  AND state IN ${liveStates} AND json_extract(details,'$.source')='scheduled'
  AND json_extract(details,'$.schedule.project')=?`;
const linkParams = (key: DeskRunKey, link: ScheduledLink): [string, string, number, string, string] =>
  [link.runId, key.repositoryId, key.number, key.viewer, link.project];
export interface Attempt {
  key: DeskRunKey;
  cwd: string;
  run: DeskRun;
  pid: number | null;
  workerIdentity?: ProcessIdentity | undefined;
}
interface Row {
  request: string;
  details: string;
  pid: number | null;
  cwd: string;
}
const decode = (row: Row): Attempt => {
  const { workerIdentity, ...run } = JSON.parse(row.details) as DeskRun & { workerIdentity?: ProcessIdentity };
  return { key: JSON.parse(row.request) as DeskRunKey, run, pid: row.pid, cwd: row.cwd, workerIdentity };
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
function processMayRemain(pid: number, identity?: ProcessIdentity): boolean {
  if (identity?.pid === pid && Number.isSafeInteger(identity.pgid) && identity.pgid > 0 &&
      typeof identity.startedAt === "string" && identity.startedAt) return processPresence(identity) !== "absent";
  // Checkpoints from prior versions and platforms without identity support
  // retain the conservative numeric check.
  return alive(pid) || (process.platform !== "win32" && alive(-pid));
}

// A dead worker can leave its last session checkpoints in both current and older history rows.
function finalizeReviewerProgress(run: DeskRun) {
  const progress = run.reviewerProgress;
  if (!progress || ["running", "cancelling", "queued"].includes(run.state)) return;
  for (const session of progress.sessions) {
    if (session.state === "running" || session.state === "planned") session.state = "unknown";
  }
  Object.assign(progress, summarizeReviewerAssignments(progress.sessions));
}

export class DeskRunStore {
  private readonly db: Database;
  constructor(readonly root = deskRunRoot(), readOnly = false) {
    if (readOnly) {
      this.db = new Database(path.join(root, "runs.sqlite"), { readonly: true });
      this.db.exec("PRAGMA busy_timeout=8000");
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
    CREATE INDEX IF NOT EXISTS active_scheduled ON runs(id) WHERE ${scheduledReservation};
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

  latestAdmission(key: DeskRunKey): string | null {
    // The last admitted attempt remains in the journal when its queue slot
    // empties. Comparing only the queued ID would miss that transition.
    return this.db.query<{ id: string }, [string, number, string]>(
      `SELECT id FROM runs WHERE repo=? AND pr=? AND viewer=?
       AND json_extract(details,'$.source') IN ('manual','scheduled') ORDER BY rowid DESC LIMIT 1`,
    ).get(key.repositoryId, key.number, key.viewer)?.id ?? null;
  }

  /** Hold the dispatch transaction while comparing the admission journal. */
  requestManual(cwd: string, key: DeskRunKey, revision: DeskRevision, observedAdmission: string | null) {
    const latest = this.latestAdmission(key);
    if (latest !== observedAdmission) {
      const existing = [this.active(key), this.queued(key)].find(attempt => attempt &&
        attempt.key.viewer.toLowerCase() === key.viewer.toLowerCase() &&
        attempt.run.baseSha === revision.baseSha && attempt.run.headSha === revision.headSha);
      if (existing) return existing.run.id;
      const previous = this.previousAttempt(key, revision);
      if (previous?.id === latest && previous.state === "completed" && previous.complete) return previous.id;
      throw new Error("stale: Another review was requested during validation. Refresh the board and try again.");
    }
    return this.request(cwd, key, revision);
  }

  save(a: Attempt) {
    this.db.run("UPDATE runs SET state=?, pid=?, details=? WHERE id=?", [
      a.run.state,
      a.pid,
      JSON.stringify({ ...a.run, workerIdentity: a.workerIdentity }),
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
    finalizeReviewerProgress(a.run);
    if (!retryable) delete a.run.retryableBeforeSpend;
    a.pid = null;
    delete a.workerIdentity;
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

  reportForSearch(key: DeskRunKey, id: string): string | undefined {
    return this.db.query<{ report: string | null }, [string, number, string, string]>(
      "SELECT json_extract(details,'$.result.report') AS report FROM runs WHERE repo=? AND pr=? AND viewer=? AND id=?",
    ).get(key.repositoryId, key.number, key.viewer, id)?.report ?? undefined;
  }

  history(key: DeskRunKey, id?: string): DeskRunSnapshot {
    // Keep periodic IPC responses bounded. The database retains full reports.
    // Return small recent reports inline and load the rest by attempt id.
    const reportSelect =
      id === undefined ? "CASE WHEN cumulative <= 131072 THEN report ELSE '' END" : "substr(report,1,524288)";
    type Item = { details: string; bytes: number; chars: number; report: string };
    const selected = id === undefined ? "" : " AND id=?";
    const sql = `WITH scoped AS (
        SELECT rowid AS seq,json_extract(details,'$.createdAt') AS created, json_remove(details,'$.result.report','$.workerIdentity') AS metadata,
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
      finalizeReviewerProgress(run);
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

  attachBadges(snapshot: { repositoryId: string; viewer: string; cards: BadgeCard[] }) {
    type Row = { pr: number; state: DeskRun["state"]; source: DeskRun["source"]; base: string | null;
      head: string | null; baseSha: string; headSha: string; planned: number | null; finished: number | null; wave: number | null };
    // Join the requested cards using the (repo,viewer,pr) index. Historical rows for other PRs or
    // other revisions never cross the SQLite boundary. No reports or session histories are returned.
    const query = this.db.query<Row, [string, string, string]>(`
      SELECT DISTINCT r.pr,r.state,json_extract(r.details,'$.source') AS source,
        json_extract(r.details,'$.result.reviewed.baseSha') AS base,json_extract(r.details,'$.result.reviewed.headSha') AS head,
        json_extract(r.details,'$.baseSha') AS baseSha,json_extract(r.details,'$.headSha') AS headSha,
        CASE WHEN r.state IN ('running','cancelling','queued') THEN json_extract(r.details,'$.reviewerProgress.planned') END AS planned,
        CASE WHEN r.state IN ('running','cancelling','queued') THEN json_extract(r.details,'$.reviewerProgress.finished') END AS finished,
        CASE WHEN r.state IN ('running','cancelling','queued') THEN json_extract(r.details,'$.reviewerProgress.wave') END AS wave
      FROM json_each(?) wanted CROSS JOIN runs r
      WHERE r.repo=? AND r.viewer=? AND r.pr=json_extract(wanted.value,'$.number')
        AND source IN ('manual','scheduled') AND
        (r.state IN ('running','cancelling','queued') OR
          (base=json_extract(wanted.value,'$.baseSha') AND head=json_extract(wanted.value,'$.headSha')))`);
    for (let i = 0; i < snapshot.cards.length; i += 200) {
      const cards = snapshot.cards.slice(i, i + 200);
      const rows = query.all(JSON.stringify(cards.map(({number, baseSha, headSha}) => ({number,baseSha,headSha}))), snapshot.repositoryId, snapshot.viewer);
      const byPr = new Map<number, Parameters<typeof localBadge>[0][number][]>();
      for (const row of rows) {
        const runs = byPr.get(row.pr) ?? [];
        if (!runs.length) byPr.set(row.pr, runs);
        runs.push({ ...row, result: row.base && row.head ? { reviewed: { baseSha: row.base, headSha: row.head } } : null,
          reviewerProgress: row.finished === null ? undefined : { planned: row.planned, finished: row.finished, wave: row.wave } });
      }
      for (const card of cards) {
        const runs = byPr.get(card.number);
        if (runs) card.localReview = localBadge(runs, card);
      }
    }
  }

  private previousAttempt(key: DeskRunKey, revision: DeskRevision) {
    return this.db
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
         AND NOT (state='skipped' AND coalesce(json_extract(details,'$.phase'),'')='Superseded'
           AND json_extract(details,'$.startedAt') IS NULL AND json_extract(details,'$.result') IS NULL
           AND json_extract(details,'$.usage') IS NULL)
       ORDER BY rowid DESC LIMIT 1`,
      )
      .get(DESK_RUN_SCOPE, key.repositoryId, key.number, key.viewer, revision.baseSha, revision.headSha);
  }

  /** Check only local scheduler occupancy, without reading private review output. */
  private scheduledCapacityReached(): boolean {
    const runs = this.db.query<{ id: string; pid: number | null; workerIdentity: string | null }, []>(
      `SELECT id, pid, json_extract(details,'$.workerIdentity') AS workerIdentity FROM runs
       WHERE ${scheduledReservation}`,
    );
    let reserved = 0;
    for (const row of runs.iterate()) {
      try {
        if (row.pid != null && !processMayRemain(row.pid, row.workerIdentity
          ? JSON.parse(row.workerIdentity) as ProcessIdentity : undefined) && !this.childMayRemain(row.id)) continue;
      } catch { /* Unknown process ownership still reserves a slot. */ }
      if (++reserved === maxScheduledWorkers) return true;
    }
    return false;
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
    const previous = this.previousAttempt(key, revision);
    // Failures, cancellations and partial results may already have consumed budget.
    // Only an explicit manual request may buy another attempt for this same range.
    if (
      previous &&
      ((schedule && !previous.retryable) || (previous.state === "completed" && previous.complete))
    ) {
      return { id: previous.id, reused: true };
    }
    if (schedule && this.scheduledCapacityReached()) {
      throw new Error(`unavailable: ${maxScheduledWorkers} scheduled Review workers are already reserved. The watcher will try again on its next poll.`);
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

  liveScheduledLinks(key: Omit<DeskRunKey, "number">, project: string, links: { number: number; runId: string }[]) {
    return this.db.query<{ number: number; runId: string }, [string, string, string, string]>(
      `SELECT r.pr AS number,r.id AS runId FROM json_each(?) wanted
        CROSS JOIN runs r WHERE r.id=json_extract(wanted.value,'$.runId')
          AND r.pr=json_extract(wanted.value,'$.number') AND r.repo=? AND r.viewer=?
          AND r.state IN ${liveStates} AND json_extract(r.details,'$.source')='scheduled'
          AND json_extract(r.details,'$.schedule.project')=?`,
    ).all(JSON.stringify(links), key.repositoryId, key.viewer, project);
  }

  scheduledOwnerExited(key: DeskRunKey, link: ScheduledLink): boolean {
    // Liveness alone is sufficient to decide whether a missing-from-board PR needs a fresh access check.
    const row = this.db.query<{ pid: number | null; workerIdentity: string | null }, ReturnType<typeof linkParams>>(
      `SELECT pid,json_extract(details,'$.workerIdentity') AS workerIdentity ${linkedActiveRow}`,
    ).get(...linkParams(key, link));
    return row?.pid != null && !processMayRemain(row.pid, row.workerIdentity ? JSON.parse(row.workerIdentity) as ProcessIdentity : undefined);
  }

  /** Verify both owner and descendant liveness before freeing the single execution slot. */
  private orphan(key: DeskRunKey, link?: ScheduledLink): Attempt | undefined {
    let a: Attempt | undefined;
    if (link) {
      // A linked PR can now be occupied by another user, project, or a manual successor.
      // Constrain the row before reading process markers or any private recovery artifacts.
      const row = this.db.query<Row, ReturnType<typeof linkParams>>(
        `SELECT request,details,pid,cwd ${linkedActiveRow}`,
      ).get(...linkParams(key, link));
      a = row ? decode(row) : undefined;
    } else {
      a = this.active(key);
    }
    if (!a || a.key.viewer.toLowerCase() !== key.viewer.toLowerCase() ||
        a.pid === null || processMayRemain(a.pid, a.workerIdentity)) return;
    return this.childMayRemain(a.run.id) ? undefined : a;
  }

  private childMayRemain(id: string): boolean {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) return true;
    const marker = readConfigFile(path.join(this.directory(id), "child.json"));
    if (!marker.ok) {
      if (marker.reason === "absent") return false;
      throw new Error("Cannot inspect the Review worker process marker.");
    }
    const child = JSON.parse(marker.text) as { pid: number; identity?: ProcessIdentity };
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error("Invalid Review worker process marker.");
    return processMayRemain(child.pid, child.identity);
  }

  async reconcile(key: DeskRunKey, readFinish: (directory: string, attempt: Attempt) => DeskFinish | null | Promise<DeskFinish | null>, link?: ScheduledLink) {
    const orphan = this.orphan(key, link);
    if (!orphan) return;
    const directory = this.directory(orphan.run.id);
    const finish = await readFinish(directory, orphan);
    const committed = this.atomic(() => {
      // Another reconciler may have finished the dead attempt and started its successor while we read its verdict.
      const a = this.orphan(key, link);
      if (!a || a.run.id !== orphan.run.id || a.pid !== orphan.pid) return;
      const cancelled = a.run.state === "cancelling";
      if (finish) {
        this.end(a, cancelled && finish.state !== "completed" ? { ...finish, state: "cancelled", phase: "cancelled" } : finish);
      } else {
        this.end(a, {
          state: cancelled ? "cancelled" : "failed",
          phase: "Interrupted",
          reason: cancelled ? "The review stopped after cancellation." : "The review worker exited without a final result. Retry the review.",
          result: null,
        });
      }
      return true;
    });
    if (!committed || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(orphan.run.id)) return;
    let ownedDirectory: string;
    try {
      ownedDirectory = realpathSync(directory);
      if (ownedDirectory !== path.join(realpathSync(this.root), "attempts", orphan.run.id)) return;
    } catch { return; }
    // A finished row alone does not prove the worker archived all the evidence it wrote.
    const { checkoutIsDisposable } = await import("./desk-run-executor-recovery");
    if (!await checkoutIsDisposable(ownedDirectory)) return;
    await Promise.allSettled([
      rm(path.join(ownedDirectory, "checkout"), { recursive: true, force: true }),
      rm(path.join(ownedDirectory, "child.json"), { force: true }),
    ]);
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

// Reading badges must neither create a new store nor change a run or dispatch a worker.
export function readLocalBadges(snapshot: { repositoryId: string; viewer: string; cards: BadgeCard[] }) {
  if (!existsSync(path.join(deskRunRoot(), "runs.sqlite"))) return;
  const store = new DeskRunStore(deskRunRoot(), true);
  try { store.attachBadges(snapshot); } finally { store.close(); }
}

export function attachDeskRunBadges(snapshot: ReviewBoardSnapshot) {
  try { readLocalBadges(snapshot); } catch { snapshot.warnings.push("Local review progress could not be read."); }
  return snapshot;
}
