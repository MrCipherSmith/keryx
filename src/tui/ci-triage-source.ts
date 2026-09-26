// Flow 306 (AC12): the production data source behind `/ci` — resolves the
// current branch's pull request, its recent failed CI runs and jobs, and
// runs one job's triage through the Phase 0/Phase 1 pipeline. Thin glue over
// `src/review/ci-port.ts` (core) and `src/harness/decision/jev-client.ts`
// (client): `src/tui/` is a CLIENT zone (`src/lib/import-zones.ts`) and may
// import both freely — the restriction is only ever "core never imports
// client/adapter".
//
// Same opt-in/credential gate as `keryx review ci-triage`
// (`src/commands/review.ts`), checked again here rather than trusted from the
// CLI: the TUI is a second, independent entry point into the same advisory
// pipeline, and AC10 applies to every entry point, not just the first one
// written.

import {
  applyDeterministicOverride,
  buildCiTriageQuestions,
  buildCiTriageState,
  computeCiSignals,
  computeCiTriageVerdict,
  extractFailingTestName,
  readCiTriageEnabled,
} from "../review/ci-triage";
import { createGhCiPort } from "../review/ci-port";
import { callJevSystemOne, DEFAULT_JEV_MODEL, JevTimeoutError, resolveJevApiKey } from "../harness/decision/jev-client";
import type { CiTriageJobItem, CiTriageListRead, CiTriageRunResult } from "./ci-triage-inspector";

export interface CiSpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type CiSourceSpawn = (argv: string[], cwd: string) => Promise<CiSpawnResult>;

async function defaultSpawn(argv: string[], cwd: string): Promise<CiSpawnResult> {
  const proc = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

interface GhPrView {
  readonly number?: number;
  readonly headRefName?: string;
}

interface GhRunListEntry {
  readonly databaseId?: number;
  readonly conclusion?: string | null;
  readonly workflowName?: string;
  readonly headBranch?: string;
  readonly createdAt?: string;
}

/**
 * AC12's list: every failed job across the current branch's pull request's
 * recent failed CI runs. Never throws — every failure mode (not opted in, no
 * PR, `gh` unavailable, nothing failed) is a `note`, so the modal always has
 * something to say rather than an empty panel with no explanation.
 */
export async function loadCiTriageList(cwd: string, spawn: CiSourceSpawn = defaultSpawn): Promise<CiTriageListRead> {
  // Flow 346: computed BEFORE the gate (not after, as `resolveJevApiKey` used
  // to be called only once a credential was already needed) so the shared
  // default-on resolver (`resolveJevProfileFlag`) can see whether a
  // credential is actually available — see `readCiTriageEnabled`'s own doc.
  const jevAvailable = resolveJevApiKey(process.env) !== undefined;
  if (!(await readCiTriageEnabled(cwd, { jevAvailable }))) {
    return {
      items: [],
      note:
        'review.jev.ci_triage is not enabled for this project (default: on when a Jev/OpenRouter credential is available and /external is on). ' +
        'Enable it explicitly in .metaproject/tasks.config.json ({"review":{"jev":{"ci_triage":true}}}) — CI triage sends a redacted log excerpt to OpenRouter/TypeSafe.',
    };
  }
  const pr = await spawn(["gh", "pr", "view", "--json", "number,headRefName"], cwd);
  if (pr.exitCode !== 0) {
    return { items: [], note: "No pull request found for the current branch (`gh pr view` failed)." };
  }
  let prInfo: GhPrView;
  try {
    prInfo = JSON.parse(pr.stdout) as GhPrView;
  } catch {
    return { items: [], note: "Could not parse `gh pr view`'s output." };
  }
  const branch = prInfo.headRefName;
  if (branch === undefined || branch.length === 0) {
    return { items: [], note: "The current branch has no associated pull request." };
  }
  const runs = await spawn(
    ["gh", "run", "list", "--branch", branch, "--json", "databaseId,conclusion,workflowName,headBranch,createdAt", "-L", "20"],
    cwd,
  );
  if (runs.exitCode !== 0) {
    return { items: [], note: `Could not list CI runs for ${branch} (\`gh run list\` failed).` };
  }
  let runList: readonly GhRunListEntry[];
  try {
    runList = JSON.parse(runs.stdout) as readonly GhRunListEntry[];
  } catch {
    return { items: [], note: "Could not parse `gh run list`'s output." };
  }
  const failedRuns = runList.filter((run) => run.conclusion === "failure");
  if (failedRuns.length === 0) {
    return { items: [], note: `No failed CI runs on ${branch}.` };
  }
  const port = createGhCiPort((argv) => spawn(argv, cwd));
  const items: CiTriageJobItem[] = [];
  for (const run of failedRuns) {
    const runId = String(run.databaseId ?? "");
    if (runId === "") continue;
    try {
      const info = await port.runInfo(runId);
      for (const job of info.jobs) {
        if (job.conclusion === "failure") {
          items.push({
            runId,
            jobName: job.name,
            workflowName: info.workflowName,
            headBranch: info.headBranch,
            conclusion: job.conclusion,
            createdAt: run.createdAt ?? null,
          });
        }
      }
    } catch {
      // One bad run's job list should not blank the whole list — the others
      // still say something.
    }
  }
  return items.length > 0 ? { items } : { items, note: `No failed jobs found across ${failedRuns.length} failed run(s) on ${branch}.` };
}

/**
 * AC12/AC7: triage one job, through the exact Phase 0/Phase 1 pipeline
 * `keryx review ci-triage` uses. Flow 307 (AC4): also computes the same
 * deterministic signals the CLI does (AC1), through the same `CiPort`, so
 * `/ci`'s detail view shows the same evidence lines `keryx review ci-triage`
 * prints — one pipeline, two entry points.
 *
 * `signal` (flow 306 review, items 1/3) is forwarded to `callJevSystemOne`:
 * the caller (the `/ci` modal) aborts it when the modal closes, so a request
 * still in flight after the operator has moved on is cancelled rather than
 * left to run to `callJevSystemOne`'s own 30s default timeout in the
 * background. Either the external `signal` or that default firing surfaces
 * here as `JevTimeoutError`, reported back as `timedOut: true` so the caller
 * can show "timed out" rather than a generic error.
 */
export async function runCiTriageForItem(
  cwd: string,
  item: CiTriageJobItem,
  spawn: CiSourceSpawn = defaultSpawn,
  fetchFn: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<CiTriageRunResult> {
  const apiKey = resolveJevApiKey(process.env);
  if (!(await readCiTriageEnabled(cwd, { jevAvailable: apiKey !== undefined && apiKey.length > 0 }))) {
    return { ok: false, reason: "review.jev.ci_triage is not enabled for this project (default: on when a Jev/OpenRouter credential is available and /external is on)." };
  }
  if (apiKey === undefined || apiKey.length === 0) {
    return { ok: false, reason: "OPENROUTER_API_KEY is not set, and no openrouterKey is saved in the keryx shell config." };
  }
  try {
    const port = createGhCiPort((argv) => spawn(argv, cwd));
    const info = await port.runInfo(item.runId);
    const rawLog = await port.failedLog(item.runId);
    const testName = extractFailingTestName(rawLog, item.jobName);
    const signals = await computeCiSignals(port, {
      runId: item.runId,
      jobName: item.jobName,
      testName,
      rawLog,
      headSha: info.headSha,
      workflowName: info.workflowName,
    });
    const state = buildCiTriageState({
      testName: testName ?? "(unknown test)",
      jobName: item.jobName,
      rawLog,
      ...(signals.lines.length > 0 ? { signalLines: signals.lines } : {}),
    });
    const questions = buildCiTriageQuestions(true);
    const result = await callJevSystemOne(fetchFn, { model: DEFAULT_JEV_MODEL, state, questions }, { ...(signal !== undefined ? { signal } : {}) });
    const rawVerdict = computeCiTriageVerdict(result.answers as Record<string, { noul?: number }>);
    const verdict = applyDeterministicOverride(rawVerdict, signals);
    return { ok: true, verdict, signalLines: signals.lines, ...(testName !== undefined ? { testName } : {}) };
  } catch (error) {
    if (error instanceof JevTimeoutError) {
      return { ok: false, reason: error.message, timedOut: true };
    }
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
