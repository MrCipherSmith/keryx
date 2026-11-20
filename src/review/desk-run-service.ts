import { collectPrContext } from "./pr-context";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { SAFE_BUN_SPAWN_ARGS } from "../lib/safe-exec";
import { isCompiledBinaryEntry } from "../lib/self-invocation";
import { readProcessIdentity } from "../lib/hub-machine/process-identity";
import { verifyVisiblePullNumbers } from "./board-badge-read";
import { resolveWatcherCheckout } from "./watcher-project";
import { verifyScheduledSubject } from "./board";
import { withScheduledPermission } from "./review-automation-guard";
import { readExistingReviews } from "./desk-run-legacy";
import { boardGraphql, reviewRepositories, selectRepository } from "./board-github";
import { createWorkerRoster } from "./desk-worker-roster";
import { readDeskReviewerProgress } from "./desk-reviewer-progress";
import { DeskRunStore, deskRunRoot, type Attempt } from "./desk-run-store";
import { DESK_RUN_SCOPE } from "./desk-run-types";
import type { DeskFinish, DeskRevision, DeskRunKey, DeskRunSnapshot, DeskSchedule, DeskRun } from "./desk-run-types";
import { executeDeskReview, recoverDeskExecution, type DeskModelSelector, type DeskExecutionResult } from "./desk-run-executor";

const query = `query($owner:String!, $name:String!, $number:Int!) {
  viewer { login } repository(owner:$owner,name:$name) { id pullRequest(number:$number) { title state baseRefOid headRefOid } }
}`;
export async function resolveDeskSubject(cwd: string, requested: string, number: number) {
  const repo = selectRepository(await reviewRepositories(cwd), requested);
  const [owner, name] = repo.split("/");
  const data = await boardGraphql<{
    viewer: { login: string };
    repository: {
      id: string;
      pullRequest: {
        title: string;
        state: string;
        baseRefOid: string;
        headRefOid: string;
      } | null;
    } | null;
  }>(cwd, query, { owner: owner!, name: name!, number });
  const pr = data.repository?.pullRequest;
  if (!data.viewer?.login || !data.repository?.id || !pr) {
    throw new Error("access: The pull request is unavailable to the current GitHub account.");
  }
  return { key: { repo, number, viewer: data.viewer.login, repositoryId: data.repository.id }, pr };
}

export async function verifyDeskSubject(cwd: string, key: DeskRunKey, revision?: DeskRevision) {
  const { key: actual, pr } = await resolveDeskSubject(cwd, key.repo, key.number);
  if (actual.viewer.toLowerCase() !== key.viewer.toLowerCase() || actual.repositoryId !== key.repositoryId) {
    throw new Error("access: GitHub account or repository changed. Refresh the board.");
  }
  if (revision) {
    if (pr.state !== "OPEN") throw new Error("stale: This pull request is no longer open. Refresh the board.");
    if (revision.baseSha !== pr.baseRefOid || revision.headSha !== pr.headRefOid) {
      throw new Error(
        "stale: The pull request revision has changed. Refresh the board to review its current range.",
      );
    }
  }
  return pr;
}

export function finishExecution(out: DeskExecutionResult): DeskFinish {
  const states = {
    complete: "completed",
    incomplete: "partial",
    blocked: "blocked",
    budget: "budget",
    failed: "failed",
    cancelled: "cancelled",
  } as const;
  return {
    state: states[out.outcome],
    phase: out.outcome,
    reason: out.reason,
    ...(out.usage ? { usage: out.usage } : {}),
    ...(out.retryableBeforeSpend ? { retryableBeforeSpend: true } : {}),
    result: {
      reviewed:
        out.checkedBase && out.checkedHead ? { baseSha: out.checkedBase, headSha: out.checkedHead } : null,
      verdict: out.verdict,
      coverage: out.coverage,
      findings: out.findings,
      findingsKnown: out.findingsKnown ?? (out.coverage === "complete" || Object.values(out.findings).some(count => count > 0)),
      report: out.report ?? "",
    },
  };
}
async function recoverFinish(directory: string, attempt: Attempt) {
  let finish: DeskFinish | null = null;
  const file = path.join(directory, "execution-result.json");
  if (existsSync(file)) {
    try {
      const stored = JSON.parse(readFileSync(file, "utf8")) as DeskExecutionResult;
      const checkpoint = finishExecution(stored);
      if (checkpoint.state && typeof checkpoint.reason === "string" && checkpoint.result?.findings) finish = checkpoint;
    } catch {
      /* Reconstruct the attempt from its verified package below. */
    }
  }
  if (!finish) {
    const recovered = await recoverDeskExecution(directory, {
      repo: attempt.key.repo, number: attempt.key.number, baseSha: attempt.run.baseSha, headSha: attempt.run.headSha,
      cancelled: attempt.run.state === "cancelling", scope: attempt.run.scope,
    });
    if (recovered) finish = finishExecution(recovered);
  }
  if (finish) {
    const roster = readDeskReviewerProgress(directory, attempt.key, { ...attempt.run, ...finish }, false);
    if (roster) finish.reviewerProgress = roster;
  }
  return finish;
}

/** Recover terminal bookkeeping only; a watcher check must never claim the execution slot or spawn a worker. */
export async function reconcileLinkedScheduledRuns(
  project: string, key: Omit<DeskRunKey, "number">, links: {number: number; runId: string}[], visible: ReadonlySet<number>,
  verifyMissing = async (numbers: number[]) => {
    const cwd = await resolveWatcherCheckout(project, key.repo);
    return verifyVisiblePullNumbers(key, numbers, (q, params) => boardGraphql(cwd, q, params));
  },
) {
  if (!links.length || !existsSync(path.join(deskRunRoot(), "runs.sqlite"))) return;
  const store = new DeskRunStore();
  try {
    const missing = links.filter(({number, runId}) => !visible.has(number) && store.scheduledOwnerExited({...key, number}, {project, runId}));
    // A completed or merged PR may have left the board. Read no artifacts until its permission is confirmed.
    const additional = missing.length ? await verifyMissing([...new Set(missing.map(link => link.number))]) : new Set<number>();
    for (const {number, runId} of links) {
      if (visible.has(number) || additional.has(number)) await store.reconcile({...key, number}, recoverFinish, {project, runId});
    }
  } finally { store.close(); }
}

function spawnWorker(a: Attempt) {
  const script = process.argv[1];
  if (!script) throw new Error("Keryx executable could not be resolved.");
  const args = isCompiledBinaryEntry(script) ? [] : [...SAFE_BUN_SPAWN_ARGS, path.resolve(script)];
  args.push("review", "desk-run", "worker", "--id", a.run.id);
  const child = spawn(process.execPath, args, {
    cwd: a.cwd,
    stdio: "ignore",
    detached: true,
  });
  child.on("error", () => {}); // A failed spawn has no pid; the attempt records that below.
  child.unref();
  if (!child.pid) throw new Error("Keryx review worker could not be started.");
  return child.pid;
}

/** Caller owns a write transaction. A worker must acquire that transaction
 * and match its pid before it can act, including after a launcher crash. */
export function dispatchNext(store: DeskRunStore, key: DeskRunKey, launch = spawnWorker) {
  if (store.active(key)) return;
  const a = store.queued(key);
  if (!a) return;
  try {
    a.pid = launch(a);
    a.workerIdentity = readProcessIdentity(a.pid) ?? undefined;
    Object.assign(a.run, {
      scope: DESK_RUN_SCOPE,
      state: "running",
      phase: "Preparing",
      reason: "Validating the requested revision.",
      startedAt: new Date().toISOString(),
    });
    store.save(a);
  } catch {
    store.end(a, {
      state: "failed",
      phase: "Dispatch failed",
      reason: "Could not start the review worker. Retry the review.",
      result: null,
    });
  }
}

async function verifyScheduled(cwd: string, key: DeskRunKey, revision: DeskRevision, rule: DeskSchedule) {
  selectRepository(await reviewRepositories(cwd), key.repo);
  await verifyScheduledSubject(key, revision, rule, (q, params) => boardGraphql(cwd, q, params));
}

/** The watcher holds its policy transaction only during the synchronous dispatch decision.
 * A competing manual request and a replay after a watcher crash get the existing run id. */
export async function scheduleDeskReview(
  cwd: string,
  key: DeskRunKey,
  revision: DeskRevision,
  schedule: DeskSchedule,
  authorize: <T>(commit: () => T) => T,
): Promise<{ id: string; reused: boolean; state: DeskRun["state"]; source: DeskRun["source"] } | null> {
  if (
    !Number.isInteger(schedule.budgetMinutes) ||
    schedule.budgetMinutes < 1 ||
    schedule.budgetMinutes > 30 ||
    (schedule.budgetTokens != null && (!Number.isSafeInteger(schedule.budgetTokens) || schedule.budgetTokens < 1))
  ) {
    throw new Error("configuration: Invalid review rule budget.");
  }
  await verifyScheduled(cwd, key, revision, schedule);
  const store = new DeskRunStore();
  try {
    await store.reconcile(key, recoverFinish);
    return authorize(() =>
      store.atomic(() => {
        const admission = store.requestAttempt(cwd, key, revision, schedule);
        dispatchNext(store, key);
        if (!admission) return null;
        const { run } = store.byId(admission.id)!;
        return { ...admission, state: run.state, source: run.source };
      }),
    );
  } finally {
    store.close();
  }
}

export type DeskAction =
  | { action: "status"; id?: string; activityId?: string }
  | { action: "start"; revision: DeskRevision }
  | { action: "cancel"; id: string };
export async function requestDeskRun(
  cwd: string,
  key: DeskRunKey,
  input: DeskAction,
): Promise<DeskRunSnapshot> {
  const store = new DeskRunStore();
  try {
    const observedAdmission = input.action === "start" ? store.latestAdmission(key) : null;
    await verifyDeskSubject(cwd, key, input.action === "start" ? input.revision : undefined);
    if (input.action === "status" && !input.id && store.atomic(() => store.claimHistoryScan(cwd, key))) {
      const existing = readExistingReviews(cwd, key);
      store.atomic(() => store.recordExisting(cwd, key, existing));
    }
    await store.reconcile(key, recoverFinish);
    store.atomic(() => {
      if (input.action === "start") store.requestManual(cwd, key, input.revision, observedAdmission);
      if (input.action === "cancel") store.cancel(key, input.id);
      dispatchNext(store, key);
    });
    const snapshot = store.history(key, input.action === "status" ? input.id : undefined);
    for (const run of snapshot.runs) {
      const detailed = input.action === "status" && (input.id === run.id || input.activityId === run.id);
      if (detailed || (!run.reviewerProgress && (run.state === "running" || run.state === "cancelling"))) {
        const progress = readDeskReviewerProgress(store.directory(run.id), key, run, detailed);
        if (progress) run.reviewerProgress = progress;
      }
    }
    return snapshot;
  } finally {
    store.close();
  }
}

export async function runDeskWorker(id: string, selectModel: DeskModelSelector) {
  const store = new DeskRunStore();
  let timer: ReturnType<typeof setInterval> | undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  try {
    const attempt = store.atomic(() => store.byId(id));
    if (!attempt || attempt.pid !== process.pid || !["running", "cancelling"].includes(attempt.run.state))
      return;
    const { cwd, key, run } = attempt;
    const schedule = run.source === "scheduled" ? run.schedule : undefined;
    const runDir = store.directory(id);
    const progress = (phase: string, usage?: DeskRun["usage"], reviewers?: DeskRun["reviewerProgress"]) =>
      store.atomic(() => {
        const a = store.byId(id);
        if (!a || a.pid !== process.pid || a.run.state === "cancelling") {
          abort();
          return;
        }
        if (reviewers || a.run.phase !== phase || (usage && JSON.stringify(a.run.usage) !== JSON.stringify(usage))) {
          if (usage) a.run.usage = usage;
          if (reviewers) a.run.reviewerProgress = reviewers;
          a.run.phase = phase;
          a.run.reason = "";
          store.save(a);
        }
      });
    let finish: DeskFinish;
    let subjectVerified = false;
    process.on("SIGTERM", abort);
    process.on("SIGINT", abort);
    try {
      if (run.source === "scheduled" && !schedule) throw new Error("configuration: Missing recorded review rule.");
      progress("Validating pull request");
      const pr = await verifyDeskSubject(cwd, key, run);
      subjectVerified = true;
      progress("Preparing checkout");
      if (controller.signal.aborted) throw new Error("Cancelled before the review started.");
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      timer = setInterval(() => {
        try {
          if (store.byId(id)?.run.state === "cancelling") abort();
        } catch {
          abort();
        }
      }, 500);
      const previous = store
        .history(key)
        .runs.find(
          (item) =>
            item.source !== "existing" &&
            item.scope === DESK_RUN_SCOPE &&
            item.state === "completed" &&
            item.result?.coverage === "complete",
        );
      const context = await collectPrContext(cwd, key, pr, store);
      const workerRoster = createWorkerRoster(runDir, key, run);
      const out = await executeDeskReview({
        context,
        cwd,
        repo: key.repo,
        number: key.number,
        baseSha: run.baseSha,
        headSha: run.headSha,
        ...(previous ? { previousRunDir: store.directory(previous.id) } : {}),
        ...(schedule ? {
          budgetMinutes: schedule.budgetMinutes,
          budgetTokens: schedule.budgetTokens,
          authorizeSpawn: <T>(commit: () => T) => withScheduledPermission(schedule.project, key, run, schedule, commit),
        } : {}),
        verifyBeforeExecution: async () => {
          if (schedule) await verifyScheduled(cwd, key, run, schedule);
          else await verifyDeskSubject(cwd, key, run);
        },
        runDir,
        signal: controller.signal,
        onProgress: (p) => {
          // Board refreshes use the worker's compact checkpoint in SQLite,
          // including when Desktop is closed. Tool activity stays in the attempt.
          progress(p.phase, p.usage, workerRoster(p));
        },
      }, { selectModel });
      finish = finishExecution(out);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const stale = message.startsWith("stale:");
      const reason = /^(access|configuration|unavailable|stale):/.test(message)
        ? message
        : "The review could not finish. Retry the review.";
      finish = {
        state: controller.signal.aborted ? "cancelled" : stale ? "skipped" : "failed",
        ...(!subjectVerified && schedule && !controller.signal.aborted && message.startsWith("unavailable:") ? { retryableBeforeSpend: true } : {}),
        phase: "Stopped",
        reason: controller.signal.aborted ? "Review cancelled." : reason,
        result: null,
      };
    } finally {
      if (timer !== undefined) clearInterval(timer);
    }
    const reviewerProgress = readDeskReviewerProgress(runDir, key, { ...run, ...finish }, false);
    store.atomic(() => {
      const a = store.byId(id);
      if (!a || a.pid !== process.pid) return;
      if (reviewerProgress) a.run.reviewerProgress = reviewerProgress;
      store.end(a, finish);
      dispatchNext(store, key);
    });
  } finally {
    process.off("SIGTERM", abort);
    process.off("SIGINT", abort);
    store.close();
  }
}
