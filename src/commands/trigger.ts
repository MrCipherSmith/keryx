// Flow 286 T7-T11: `keryx trigger` — the single entry point every hook, cron
// line, systemd timer and CI job calls to fire, inspect, install and
// schedule a project's declared triggers.
//
// This file is ADAPTER zone (`src/lib/import-zones.ts`: `commands` ->
// `adapter`). The decision logic — which entry `<name>` resolves to, whether
// a run may proceed under the project's trigger lock (`../trigger/run.ts`),
// hook-block bookkeeping (`../trigger/hooks.ts`), schedule-line rendering
// (`../trigger/schedule.ts`), and the fired-trigger record
// (`../trigger/record.ts`) — all live in `../trigger/*`, CORE zone. Core may
// never import this directory (`src/lib/import-policy.ts`, enforced at
// zero), so this file is the only place allowed to import BOTH `../trigger/*`
// (core) and `./sync` / `./gdgraph` (adapter), and it is the one that
// actually dispatches to them.
//
// `reconcile` and `rebuild` reuse the existing command entry points
// (`syncCommand(["--apply"])`, `gdgraphCommand(["build"])`) rather than
// reimplementing what they do — per dispatch instruction, and because those
// two already carry real behaviour this file must not duplicate (delegated-
// runner provenance for `gdgraph build`, the forgetting-stage reconcile for
// `sync --apply`).
//
// `open-flow` and `flow-next` are flow 286 T11: they dispatch to
// `../flow/service.ts` (core) through the SAME composition root
// `../commands/flow.ts` builds for `keryx flow` itself
// (`flowServiceDeps()`) — reused rather than re-declared, so a triggered
// `open-flow`/`flow-next` opens flows through the identical tracker/health/
// security-gate wiring an operator's own `keryx flow init`/`next` uses, not a
// second, drifting composition. `../flow/service.ts` is CORE zone (like
// `../trigger/*`), so it could not have been called from `../trigger/run.ts`
// directly: `flowServiceDeps()` itself pulls in the GitHub tracker adapter,
// the health service and the security guard, all ADAPTER-zone dependencies
// core may never import. This file is the one place both zones meet, exactly
// as it already is for `reconcile`/`rebuild`.

import { gdgraphCommand } from "./gdgraph";
import { syncCommand } from "./sync";
import { flowServiceDeps } from "./flow";
import { createFlowService } from "../flow/service";
import { resolveTriggerForRun, withTriggerRunLock, evaluateTriggerBudget, type TriggerResolution } from "../trigger/run";
import {
  loadTriggersConfig,
  triggersConfigPath,
  type TriggerAction,
  type TriggerEntry,
  type TriggerFire,
} from "../trigger/config";
import {
  appendTriggerRunRecord,
  latestRunByTrigger,
  NO_MODEL_COST,
  openReservations,
  readTriggerRuns,
  type TriggerRunCost,
  type TriggerRunOutcomeKind,
  type TriggerRunRecord,
} from "../trigger/record";
import { hasGitHooksRoot, installTriggerHooks, isTriggerHookInstalled, uninstallTriggerHooks } from "../trigger/hooks";
import { renderScheduleLines, resolveKeryxInvocation, resolveScheduleEntry } from "../trigger/schedule";
import type { FlowService } from "../flow/types";
import type { NextTaskDecision } from "../flow/machine";
import type { TriggerDispatchRecord } from "../trigger/record";
import { NETWORK_ON_WARNING, runFlowNextDispatch, type DispatchDeps, type DispatchResult } from "./trigger-dispatch";

/**
 * Flow 290: in-process seams for `keryx trigger run` — the flow service and
 * the dispatch's model/gate/clock. Production passes none; tests drive a real
 * dispatch with a scripted provider through here.
 */
export interface TriggerRunOverrides {
  readonly service?: FlowService;
  readonly dispatch?: Omit<DispatchDeps, "service">;
}

/** One `keryx trigger run <name>` pass against `projectRoot`, with optional seams (tests). */
export async function runTriggerOnce(projectRoot: string, name: string, overrides: TriggerRunOverrides = {}): Promise<void> {
  await runTrigger(projectRoot, name, overrides);
}

/**
 * Same lazy-singleton shape `../commands/flow.ts` uses for `keryx flow`
 * itself (`getService`/`service` there) — a second, independent singleton
 * rather than importing that module's, because that one is not exported (by
 * design: `flowServiceDeps()` IS exported, precisely so a second composition
 * root like this one can build its own instance from the identical deps
 * without reaching into another command file's private module state).
 */
let flowService: FlowService | null = null;
function getFlowService(): FlowService {
  flowService ??= createFlowService(flowServiceDeps());
  return flowService;
}

export async function triggerCommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printHelp();
    return;
  }

  switch (sub) {
    case "run":
      return runSubcommand(args);
    case "install":
      return installSubcommand();
    case "uninstall":
      return uninstallSubcommand();
    case "list":
      return listSubcommand();
    case "status":
      return statusSubcommand(args);
    case "schedule":
      return scheduleSubcommand(args);
    case "resolve":
      return resolveSubcommand(args);
    default:
      console.error(`Unknown trigger command: ${sub}. See \`keryx trigger --help\`.`);
      printHelp();
      process.exitCode = 1;
      return;
  }
}

// ---------------------------------------------------------------------------
// run (T7, extended with the AC4 fired-trigger record)
// ---------------------------------------------------------------------------

async function runSubcommand(args: string[]): Promise<void> {
  const name = args[1];
  if (args[1] === "--help" || args[1] === "-h") {
    printHelp();
    return;
  }
  if (!name) {
    console.error("Usage: keryx trigger run <name>");
    process.exitCode = 1;
    return;
  }
  await runTrigger(process.cwd(), name);
}

/**
 * Perform exactly one pass of `name`'s action (AC2). Sets `process.exitCode`
 * rather than throwing for every outcome this function itself classifies
 * (config problems, an unknown/disabled/malformed name, a not-yet-
 * implemented action kind, a refused lock) — only an actual action failure
 * (a thrown error from `syncCommand`/`gdgraphCommand`, or either setting a
 * non-zero `process.exitCode` on its own, e.g. `gdgraph build`'s delegated-
 * runner path on a failed child) is left to produce a non-zero exit, which is
 * exactly the line AC2 draws.
 */
async function runTrigger(projectRoot: string, name: string, overrides: TriggerRunOverrides = {}): Promise<void> {
  const resolution = resolveTriggerForRun(projectRoot, name);

  switch (resolution.kind) {
    case "config-absent": {
      console.log(
        `keryx trigger run ${name}: no trigger config declared for this project ` +
          `(${triggersConfigPath(projectRoot)} not found) — nothing to do.`,
      );
      return;
    }
    case "config-broken": {
      console.error(
        `keryx trigger run ${name}: ${triggersConfigPath(projectRoot)} could not be read as a trigger ` +
          `config (${resolution.fileProblem}) — fix the file and retry.`,
      );
      process.exitCode = 1;
      return;
    }
    case "unknown-name": {
      console.error(
        `keryx trigger run: unknown trigger "${name}". ` +
          (resolution.known.length > 0 ? `Known: ${resolution.known.join(", ")}` : "This project declares no valid triggers."),
      );
      process.exitCode = 1;
      return;
    }
    case "rejected": {
      console.error(`keryx trigger run: "${name}" is declared but malformed, so it cannot run:`);
      for (const reason of resolution.reasons) console.error(`  - ${reason}`);
      process.exitCode = 1;
      return;
    }
    case "disabled": {
      console.log(`keryx trigger run ${name}: disabled — nothing to do.`);
      await recordRun(projectRoot, resolution.entry, {
        outcome: "no-op",
        detail: "disabled — nothing to do.",
        cost: { recorded: false, reason: "trigger is disabled — its action never ran" },
      });
      return;
    }
    case "ready": {
      await runReadyTrigger(projectRoot, name, resolution, overrides);
      return;
    }
  }
}

async function runReadyTrigger(
  projectRoot: string,
  name: string,
  resolution: Extract<TriggerResolution, { kind: "ready" }>,
  overrides: TriggerRunOverrides = {},
): Promise<void> {
  const { entry } = resolution;
  const { action } = entry;

  if (action.kind === "open-flow") {
    await runOpenFlow(projectRoot, name, entry, action);
    return;
  }
  if (action.kind === "flow-next") {
    await runFlowNext(projectRoot, name, entry, action, overrides);
    return;
  }

  const outcome = await withTriggerRunLock(projectRoot, async () => {
    const before = process.exitCode;
    process.exitCode = 0;
    if (action.kind === "reconcile") {
      await syncCommand(["--apply"]);
    } else {
      await gdgraphCommand(["build"]);
    }
    // `syncCommand`/`gdgraphCommand` mostly signal failure by throwing, but
    // `gdgraph build`'s delegated-local-runner path (`delegateToLocalRunner`
    // in `./gdgraph.ts`) sets `process.exitCode` from a failed child WITHOUT
    // throwing. Reading it here is how that failure mode is still caught as
    // "the action itself failed" (AC2) instead of silently reading as ok.
    const failed = (process.exitCode ?? 0) !== 0;
    process.exitCode = before;
    return { failed };
  });

  if (!outcome.acquired) {
    console.log(`keryx trigger run ${name}: ${outcome.reason}`);
    await recordRun(projectRoot, entry, {
      outcome: "lock-refused",
      detail: outcome.reason,
      cost: { recorded: false, reason: "run was refused before the action could start" },
    });
    return;
  }

  // Neither `reconcile` (`sync --apply`) nor `rebuild` (`gdgraph build`) call
  // a model — both are deterministic bookkeeping over the graph/wiki/memory
  // layers. `NO_MODEL_COST` is honest for both outcomes below. `open-flow` and
  // `flow-next` never reach this branch — see `runOpenFlow`/`runFlowNext`,
  // which record their own outcomes. Since flow 290 a `flow-next` with a
  // `dispatch` block is the one producer of `{ recorded: true, usd, tokens }`.
  if (outcome.result.failed) {
    console.error(`keryx trigger run ${name}: action "${action.kind}" failed (see output above).`);
    process.exitCode = 1;
    await recordRun(projectRoot, entry, {
      outcome: "failed",
      detail: `action "${action.kind}" failed (see command output above for detail).`,
      cost: NO_MODEL_COST,
    });
    return;
  }

  console.log(`keryx trigger run ${name}: ok — "${action.kind}" completed.`);
  await recordRun(projectRoot, entry, {
    outcome: "ok",
    detail: `action "${action.kind}" completed.`,
    cost: NO_MODEL_COST,
  });
}

// ---------------------------------------------------------------------------
// open-flow (T11, AC7 + AC8)
// ---------------------------------------------------------------------------

/**
 * "Equivalent", for the do-not-duplicate rule (AC7): another flow whose
 * `title` is EXACTLY this entry's `action.template` and whose `status` is not
 * `"done"`. Chosen deliberately narrow, over the two looser readings that were
 * available and rejected:
 *
 *   - Matching on `slug` instead of `title` would tie equivalence to
 *     `slugify()`'s behaviour (lossy — two different templates can slugify to
 *     the same string), when `title` is set from `action.template` verbatim
 *     by `runOpenFlow` below and is therefore an exact, lossless key.
 *   - Treating every non-`"done"` status as equally "open" is what this DOES
 *     do (a `"blocked"` flow still counts — it has not finished, and opening
 *     a second one for the same template while the first is blocked is
 *     exactly the noise AC7 exists to prevent); the narrower alternative
 *     (`"in-progress"` only) was rejected because a freshly-`init`ed flow
 *     that has not yet been `start`ed (`status: "initializing"`) is just as
 *     much "already open for this template" as one mid-task, and letting a
 *     trigger fire again before a human/agent even looks at the first one
 *     would defeat the rule's own purpose.
 *
 * A test (`trigger.test.ts`) pins this exact reading: two `open-flow` fires
 * for the same template, the second a no-op while the first flow is still
 * `"initializing"` (not yet started).
 */
function findEquivalentOpenFlow(
  flows: readonly { id: string; title: string; status: string }[],
  template: string,
): { id: string; title: string; status: string } | undefined {
  return flows.find((flow) => flow.title === template && flow.status !== "done");
}

/**
 * `../trigger/record.ts`'s `NO_MODEL_COST` names "reconcile/rebuild" by name
 * in its own reason string — accurate for those two, but wrong to reuse
 * verbatim for `open-flow`/`flow-next`, which are neither. Each action kind
 * gets its own, honest reason instead.
 */
function noModelCost(reason: string): TriggerRunCost {
  return { recorded: false, reason };
}

const OPEN_FLOW_NO_MODEL_COST = noModelCost(
  'action "open-flow" does not call a model — opening a flow is deterministic bookkeeping (a new flow.json plus scaffold ' +
    "files), no spend to record.",
);
const FLOW_NEXT_NO_MODEL_COST = noModelCost(
  'action "flow-next" does not call a model when it is report-only (no `dispatch` block) — it only reports the next ' +
    "task into this record, so there is nothing to record a cost for.",
);

/**
 * What the locked section below (`runOpenFlow`) decided, so the outer
 * function can turn it into the right console line + recorded outcome AFTER
 * the lock is released, without doing any of the actual I/O twice.
 */
type OpenFlowLockResult =
  | { readonly kind: "skipped"; readonly equivalent: { id: string; title: string; status: string } }
  | { readonly kind: "opened"; readonly flowId: string; readonly dir: string };

/**
 * REVIEW FIX (finding 1, T15): `service.list()` + `findEquivalentOpenFlow()`
 * + `service.init()` used to run with no lock at all, so two `trigger run`
 * firings close together (two hooks, or a hook plus a CI call) could both see
 * "nothing open" and both create a flow with the same title — exactly the
 * duplicate noise AC7 exists to prevent. `../flow/service.ts`'s own lock
 * (`resolveAllocationScope`) only serializes ID MINTING, not title
 * uniqueness, so it never closed this window on its own.
 *
 * Fix: the WHOLE check-then-create sequence now runs inside
 * `withTriggerRunLock` — the same project-wide trigger-run lock AC3 already
 * uses for `reconcile`/`rebuild`, reused rather than introducing a second
 * lock type here. Two reasons this was chosen over taking the flow
 * allocation-scope lock directly: (1) `withTriggerRunLock`'s refusal is
 * already wired end-to-end into this file's `lock-refused` outcome/exit-0
 * handling (see below) — reusing it means a lock refusal here costs no new
 * code path to get right, where a second lock type would need its own
 * refusal-to-outcome mapping invented and tested from scratch; (2) it keeps
 * this file's only two lock-shaped behaviours (reconcile/rebuild vs.
 * open-flow) consistent for an operator reading `keryx trigger status` after
 * a refusal — "another trigger run holds the lock" always means the same
 * thing. The tradeoff, named rather than hidden: this now serializes
 * `open-flow` against reconcile/rebuild/other open-flow firings project-wide,
 * not just against other opens of the SAME template — a deliberately
 * coarser lock than the minimum needed, traded for reusing already-correct,
 * already-tested machinery instead of adding a title-scoped lock this
 * dispatch does not need. Proven with two real concurrent `keryx trigger run`
 * processes (not a stubbed lock), the same pattern AC3's own
 * `trigger-run.e2e.test.ts` uses: `trigger-run-open-flow.e2e.test.ts`.
 */
async function runOpenFlow(
  projectRoot: string,
  name: string,
  entry: TriggerEntry,
  action: Extract<TriggerAction, { kind: "open-flow" }>,
): Promise<void> {
  const budget = await evaluateTriggerBudget(projectRoot, "open-flow");
  if (!budget.allowed) {
    await refuseOnBudget(projectRoot, name, entry, budget.reason);
    return;
  }

  const service = getFlowService();

  let outcome;
  try {
    outcome = await withTriggerRunLock(projectRoot, async (): Promise<OpenFlowLockResult> => {
      if (action.skipIfOpen) {
        const flows = await service.list({ cwd: projectRoot });
        const equivalent = findEquivalentOpenFlow(flows, action.template);
        if (equivalent) {
          return { kind: "skipped", equivalent };
        }
      }
      const result = await service.init({ cwd: projectRoot, title: action.template });
      return { kind: "opened", flowId: result.flow.id, dir: result.dir };
    });
  } catch (error) {
    // `withTriggerRunLock` only ever catches its own lock-timeout error;
    // everything else (here: `service.init`/`service.list` throwing) is
    // rethrown unchanged, exactly as it was when this code ran unlocked —
    // this is the same try/catch that used to wrap `service.init` alone,
    // now wrapping the whole locked section instead.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`keryx trigger run ${name}: action "open-flow" failed: ${message}`);
    process.exitCode = 1;
    await recordRun(projectRoot, entry, {
      outcome: "failed",
      detail: `action "open-flow" failed: ${message}`,
      cost: OPEN_FLOW_NO_MODEL_COST,
    });
    return;
  }

  if (!outcome.acquired) {
    console.log(`keryx trigger run ${name}: ${outcome.reason}`);
    await recordRun(projectRoot, entry, {
      outcome: "lock-refused",
      detail: outcome.reason,
      cost: { recorded: false, reason: "run was refused before the action could start" },
    });
    return;
  }

  if (outcome.result.kind === "skipped") {
    const { equivalent } = outcome.result;
    const detail =
      `flow ${equivalent.id} ("${equivalent.title}", status: ${equivalent.status}) is already open for ` +
      `template "${action.template}" and \`skipIfOpen\` is set — not opening a second one.`;
    console.log(`keryx trigger run ${name}: ${detail}`);
    await recordRun(projectRoot, entry, { outcome: "no-op", detail, cost: OPEN_FLOW_NO_MODEL_COST });
    return;
  }

  const { flowId, dir } = outcome.result;
  const detail = `opened flow ${flowId} ("${action.template}") at ${dir}.`;
  console.log(`keryx trigger run ${name}: ok — ${detail}`);
  await recordRun(projectRoot, entry, { outcome: "ok", detail, cost: OPEN_FLOW_NO_MODEL_COST });
}

// ---------------------------------------------------------------------------
// flow-next (T11, AC8)
// ---------------------------------------------------------------------------
//
// Flow 286 scoped `flow-next` to REPORTING the next task. Flow 290 keeps that
// as the behaviour of an entry WITHOUT a `dispatch` block ("report-only", so
// the 0.2.154 shape keeps working), and adds the dispatching path: with a
// `dispatch` block the entry names the runner (provider/model), its
// permission mode, its rates and its own spend ceiling — the things 286 said
// an unattended fire could not supply — and `./trigger-dispatch.ts` works the
// task in a throwaway worktree under the unattended posture.
async function runFlowNext(
  projectRoot: string,
  name: string,
  entry: TriggerEntry,
  action: Extract<TriggerAction, { kind: "flow-next" }>,
  overrides: TriggerRunOverrides = {},
): Promise<void> {
  const dispatch = action.dispatch;
  const budget = await evaluateTriggerBudget(
    projectRoot,
    "flow-next",
    {},
    dispatch === undefined ? undefined : { name: entry.name, ceilingUsd: dispatch.ceilingUsd },
  );
  if (!budget.allowed) {
    await refuseOnBudget(projectRoot, name, entry, budget.reason);
    return;
  }

  const service = overrides.service ?? getFlowService();
  if (dispatch !== undefined) {
    // Flow 290: a `dispatch` block turns the report into real work.
    let result: DispatchResult;
    try {
      // `budget` above is the fast, lock-free refusal; the authoritative
      // decision is the spend RESERVATION the dispatch takes under the
      // project-wide spend lock before its first model call (AC14).
      result = await runFlowNextDispatch(projectRoot, entry, action.flow, dispatch, {
        ...overrides.dispatch,
        service,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`keryx trigger run ${name}: dispatch for flow ${action.flow} failed: ${message}`);
      process.exitCode = 1;
      await recordRun(projectRoot, entry, {
        outcome: "failed",
        detail: `dispatch for flow ${action.flow} failed: ${message}`,
        cost: { recorded: false, reason: "the dispatch failed before its cost could be measured" },
      });
      return;
    }
    const line = `keryx trigger run ${name}: ${result.outcome} — ${result.detail}`;
    if (result.exitCode === 0) console.log(line);
    else console.error(line);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    await recordRun(projectRoot, entry, {
      outcome: result.outcome,
      detail: result.detail,
      cost: result.cost,
      dispatch: result.dispatch,
    });
    return;
  }
  try {
    const decision = await service.next({ cwd: projectRoot, id: action.flow });
    const detail = describeNextTaskDecision(action.flow, decision);
    console.log(`keryx trigger run ${name}: ok — ${detail}`);
    await recordRun(projectRoot, entry, { outcome: "ok", detail, cost: FLOW_NEXT_NO_MODEL_COST });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`keryx trigger run ${name}: action "flow-next" failed: ${message}`);
    process.exitCode = 1;
    await recordRun(projectRoot, entry, {
      outcome: "failed",
      detail: `action "flow-next" failed: ${message}`,
      cost: FLOW_NEXT_NO_MODEL_COST,
    });
  }
}

function describeNextTaskDecision(flowId: string, decision: NextTaskDecision): string {
  const unresolvedNote =
    decision.unresolved.length > 0
      ? ` (${decision.unresolved.length} other not-done task(s) carry an open, unresolved attempt.)`
      : "";
  if (decision.kind === "ready") {
    return (
      `flow ${flowId}'s next task is ${decision.task.id} ("${decision.task.title}"), resume: ${decision.resume.kind}.` +
      unresolvedNote
    );
  }
  if (decision.kind === "blocked") {
    const waiting = decision.blocked
      .map((entry) => `${entry.task.id} (waiting on ${entry.waitingOn.join(", ")})`)
      .join("; ");
    return `flow ${flowId} has work remaining but nothing startable — blocked: ${waiting}.${unresolvedNote}`;
  }
  return `flow ${flowId} has no undone task — nothing to report.${unresolvedNote}`;
}

/** Shared by `runOpenFlow`/`runFlowNext`: AC8's budget refusal — exit 0, recorded, never a crash. */
async function refuseOnBudget(projectRoot: string, name: string, entry: TriggerEntry, reason: string): Promise<void> {
  console.log(`keryx trigger run ${name}: ${reason}`);
  await recordRun(projectRoot, entry, {
    outcome: "budget-refused",
    detail: reason,
    cost: { recorded: false, reason: "run was refused on the spend ceiling before the action could start" },
  });
}

/**
 * Append the fired-trigger record (AC4) and, on failure to write it, warn
 * without changing the run's own exit code — the record of what happened is
 * not the same fact as what happened, exactly like `runForgettingStage`'s own
 * "trail NOT recorded" line in `./sync.ts` never turns a successful sync into
 * a failed one.
 */
async function recordRun(
  projectRoot: string,
  entry: TriggerEntry,
  outcome: { outcome: TriggerRunOutcomeKind; detail: string; cost: TriggerRunCost; dispatch?: TriggerDispatchRecord },
): Promise<void> {
  const append = await appendTriggerRunRecord(projectRoot, {
    at: new Date().toISOString(),
    trigger: entry.name,
    firedBy: entry.fire,
    action: entry.action,
    outcome: outcome.outcome,
    detail: outcome.detail,
    cost: outcome.cost,
    ...(outcome.dispatch !== undefined ? { dispatch: outcome.dispatch } : {}),
  });
  if (append.status === "failed") {
    console.error(`keryx trigger run ${entry.name}: ! ${append.reason}`);
  }
}

// ---------------------------------------------------------------------------
// install / uninstall (T9, AC5)
// ---------------------------------------------------------------------------

async function installSubcommand(): Promise<void> {
  const cwd = process.cwd();
  if (!(await hasGitHooksRoot(cwd))) {
    console.log("No .git directory — nothing installed.");
    return;
  }
  const results = await installTriggerHooks(cwd);
  if (results.length === 0) {
    console.log(
      "keryx trigger install: no event-fired trigger declared " +
        `(${triggersConfigPath(cwd)}) — nothing to install. Schedule-fired and \`ci\`-fired entries install no hook; ` +
        "see `keryx trigger schedule <name>` for a schedule entry.",
    );
    return;
  }
  console.log(`keryx trigger install: installed ${results.length} hook block(s), extending the existing hook file(s):`);
  for (const result of results) {
    console.log(`  - ${result.name} -> ${result.hook} (${result.wrote ? "written" : "NOT written"})`);
  }
  console.log(
    "\nOther managed blocks already in these hook files (e.g. `keryx sync install-hooks`'s `keryx-sync` block, " +
      "or a `keryx update`-installed `*-post-commit` block) are untouched and still run.",
  );
}

async function uninstallSubcommand(): Promise<void> {
  const cwd = process.cwd();
  const results = await uninstallTriggerHooks(cwd);
  const removed = results.filter((r) => r.wrote);
  console.log(
    removed.length > 0
      ? `keryx trigger uninstall: removed ${removed.length} hook block(s): ${removed.map((r) => `${r.name} (${r.hook})`).join(", ")}`
      : "keryx trigger uninstall: no installed trigger hook block found to remove.",
  );
}

// ---------------------------------------------------------------------------
// list (T9, AC5)
// ---------------------------------------------------------------------------

async function listSubcommand(): Promise<void> {
  const cwd = process.cwd();
  const { triggers, rejected, fileProblem } = loadTriggersConfig(cwd);

  if (fileProblem === "absent") {
    console.log(`keryx trigger list: no trigger config declared (${triggersConfigPath(cwd)} not found).`);
    return;
  }
  if (fileProblem !== undefined) {
    console.error(`keryx trigger list: ${triggersConfigPath(cwd)} could not be read as a trigger config (${fileProblem}).`);
    process.exitCode = 1;
    return;
  }

  if (triggers.length === 0 && rejected.length === 0) {
    console.log("keryx trigger list: the trigger config declares no entries.");
    return;
  }

  console.log(`keryx trigger list (${triggersConfigPath(cwd)}):`);
  for (const entry of triggers) {
    const hookNote = await describeHookInstalled(cwd, entry);
    console.log(
      `  - ${entry.name}  [${entry.enabled ? "enabled" : "disabled"}]  ${describeFire(entry.fire)}  -> ${describeAction(entry.action)}  hook: ${hookNote}`,
    );
  }
  for (const bad of rejected) {
    console.log(`  - ${bad.name ?? `(entry #${bad.index})`}  [REJECTED]  ${bad.reasons.join("; ")}`);
  }
}

async function describeHookInstalled(cwd: string, entry: TriggerEntry): Promise<string> {
  if (entry.fire.kind === "schedule") {
    return `n/a (schedule — see \`keryx trigger schedule ${entry.name}\`)`;
  }
  if (entry.fire.event === "ci") {
    return "n/a (ci — fired by a CI job's own `keryx trigger run` call)";
  }
  return (await isTriggerHookInstalled(cwd, entry)) ? `installed (${entry.fire.event})` : `NOT installed (${entry.fire.event})`;
}

// ---------------------------------------------------------------------------
// status (T8, AC4)
// ---------------------------------------------------------------------------

async function statusSubcommand(args: string[]): Promise<void> {
  const filterName = args[1];
  const cwd = process.cwd();
  const { triggers, fileProblem } = loadTriggersConfig(cwd);

  if (fileProblem === "absent") {
    console.log(`keryx trigger status: no trigger config declared (${triggersConfigPath(cwd)} not found).`);
    return;
  }
  if (fileProblem !== undefined) {
    console.error(`keryx trigger status: ${triggersConfigPath(cwd)} could not be read as a trigger config (${fileProblem}).`);
    process.exitCode = 1;
    return;
  }

  const runsRead = await readTriggerRuns(cwd);
  if (runsRead.state === "unreadable") {
    console.error(`keryx trigger status: ${runsRead.reason}`);
    process.exitCode = 1;
    return;
  }
  const latest = latestRunByTrigger(runsRead.state === "present" ? runsRead.records : []);

  const entries = filterName ? triggers.filter((entry) => entry.name === filterName) : triggers;
  if (filterName && entries.length === 0) {
    console.error(`keryx trigger status: unknown trigger "${filterName}". Known: ${triggers.map((t) => t.name).join(", ") || "(none)"}`);
    process.exitCode = 1;
    return;
  }
  if (entries.length === 0) {
    console.log("keryx trigger status: the trigger config declares no entries.");
    return;
  }

  console.log(`keryx trigger status (reading ${runsRead.state === "present" ? runsRead.path : "no run record yet"}):`);
  // Flow 290 T13 (AC14): a reservation no run has closed — in flight, or left
  // by a killed run — still counts against both ceilings.
  const open = openReservations(runsRead.state === "present" ? runsRead.records : []);
  for (const reservation of open) {
    console.log(
      `  ! open spend reservation: run ${reservation.runId} (trigger ${reservation.trigger}) holds $${reservation.usd.toFixed(4)} ` +
        `since ${reservation.at} — if that run is no longer alive, close it with \`keryx trigger resolve ${reservation.runId} --spent <usd>\``,
    );
  }
  for (const entry of entries) {
    console.log(`  - ${entry.name}  [${entry.enabled ? "enabled" : "disabled"}]  ${describeFire(entry.fire)}  -> ${describeAction(entry.action)}`);
    const record = latest.get(entry.name);
    console.log(`      ${record ? describeRecord(record) : "never fired — no record yet"}`);
  }
}

function describeRecord(record: TriggerRunRecord): string {
  const cost = record.cost.recorded ? `cost: $${record.cost.usd.toFixed(4)}` : `cost: n/a (${record.cost.reason})`;
  return `last: ${record.at} — ${record.outcome} — ${record.detail} [${cost}]`;
}

function describeFire(fire: TriggerFire): string {
  return fire.kind === "event" ? `event:${fire.event}` : `schedule:"${fire.cron}"`;
}

function describeAction(action: TriggerAction): string {
  if (action.kind === "open-flow") return `open-flow(${action.template}${action.skipIfOpen ? ", skipIfOpen" : ""})`;
  if (action.kind === "flow-next") {
    if (action.dispatch === undefined) return `flow-next(${action.flow}, report-only)`;
    const d = action.dispatch;
    return (
      `flow-next(${action.flow}, dispatch: ${d.provider}/${d.model}, mode ${d.permissionMode}, ` +
      `ceiling $${d.ceilingUsd}, max ${d.maxSeconds}s, ${d.maxAttempts} attempts` +
      (d.network ? `, NETWORK ON — ${NETWORK_ON_WARNING}` : ", network off") +
      ")"
    );
  }
  return action.kind;
}

// ---------------------------------------------------------------------------
// resolve (flow 290 T13, AC14)
// ---------------------------------------------------------------------------

/**
 * Close a spend reservation whose run will never close it itself (the process
 * was killed). The operator states what the run actually spent — read it from
 * the provider's console — and that figure replaces the reservation in both
 * ceilings. There is no default: guessing would be the fail-open this exists
 * to prevent.
 */
async function resolveSubcommand(args: string[]): Promise<void> {
  const runId = args[1];
  const spentAt = args.indexOf("--spent");
  const spentRaw = spentAt >= 0 ? args[spentAt + 1] : undefined;
  if (runId === undefined || runId.startsWith("--") || spentRaw === undefined) {
    console.error("Usage: keryx trigger resolve <runId> --spent <usd>");
    process.exitCode = 1;
    return;
  }
  const spent = Number(spentRaw);
  if (!Number.isFinite(spent) || spent < 0) {
    console.error(`keryx trigger resolve: --spent must be a non-negative number of USD, got "${spentRaw}"`);
    process.exitCode = 1;
    return;
  }
  const cwd = process.cwd();
  const read = await readTriggerRuns(cwd);
  if (read.state !== "present") {
    console.error(`keryx trigger resolve: no readable run record (${read.state === "unreadable" ? read.reason : "none yet"})`);
    process.exitCode = 1;
    return;
  }
  const open = openReservations(read.records).find((r) => r.runId === runId);
  if (open === undefined) {
    console.error(`keryx trigger resolve: run ${runId} has no open spend reservation`);
    process.exitCode = 1;
    return;
  }
  const reservedRecord = read.records.find((r) => r.outcome === "reserved" && r.reservation?.runId === runId)!;
  const append = await appendTriggerRunRecord(cwd, {
    at: new Date().toISOString(),
    trigger: reservedRecord.trigger,
    firedBy: reservedRecord.firedBy,
    action: reservedRecord.action,
    outcome: "reservation-resolved",
    detail: `operator closed run ${runId}'s $${open.usd.toFixed(4)} reservation, stating it spent $${spent}`,
    cost: { recorded: true, usd: spent },
    resolves: runId,
    // Flow 297 (AC2): the reservation carried the flow/task it was opened
    // for (additive on `reserveTriggerSpend`) — carry it onto the record that
    // closes it too, so an operator-resolved run stays attributed.
    ...(reservedRecord.dispatch !== undefined ? { dispatch: reservedRecord.dispatch } : {}),
  });
  if (append.status === "failed") {
    console.error(`keryx trigger resolve: ${append.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(`keryx trigger resolve: run ${runId}'s reservation ($${open.usd.toFixed(4)}) closed at $${spent}.`);
}

// ---------------------------------------------------------------------------
// schedule (T10, AC6)
// ---------------------------------------------------------------------------

async function scheduleSubcommand(args: string[]): Promise<void> {
  const name = args[1];
  if (args[1] === "--help" || args[1] === "-h") {
    console.log("Usage: keryx trigger schedule <name>");
    return;
  }
  if (!name) {
    console.error("Usage: keryx trigger schedule <name>");
    process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  const resolution = resolveScheduleEntry(cwd, name);

  switch (resolution.kind) {
    case "config-absent": {
      console.error(`keryx trigger schedule: no trigger config declared (${triggersConfigPath(cwd)} not found).`);
      process.exitCode = 1;
      return;
    }
    case "unknown-name": {
      console.error(
        `keryx trigger schedule: unknown trigger "${name}". ` +
          (resolution.known.length > 0 ? `Known: ${resolution.known.join(", ")}` : "This project declares no valid triggers."),
      );
      process.exitCode = 1;
      return;
    }
    case "not-a-schedule": {
      console.error(
        `keryx trigger schedule: "${name}" is ${describeFire(resolution.entry.fire)}, not a schedule entry — ` +
          "there is nothing to print. Event-fired entries are installed as git hooks with `keryx trigger install`.",
      );
      process.exitCode = 1;
      return;
    }
    case "ready": {
      const lines = renderScheduleLines({
        projectRoot: cwd,
        name,
        cron: resolution.entry.fire.cron,
        invocation: resolveKeryxInvocation(),
      });
      console.log(`keryx trigger schedule ${name}: keryx runs no daemon for this — install ONE of the two below with your own scheduler.\n`);
      console.log(`# --- cron (crontab -e) --------------------------------------------------`);
      console.log(lines.cronLine);
      // Machine-parseable line, for anything (including this task's own AC6
      // test) that wants exactly what a scheduler would run, without
      // re-parsing the human-formatted crontab line above for its cron
      // fields vs. its command.
      console.log(`# cron-command-only: ${lines.cronCommand}`);
      console.log(`\n# --- systemd (an alternative to cron) -------------------------------------`);
      console.log(lines.systemdService);
      console.log(lines.systemdTimer);
      console.log(`# Assumed PATH baked into both: ${lines.assumedPath}`);
      console.log(`# Output is appended to: ${lines.logPath}`);
      return;
    }
  }
}

/**
 * The single source of truth for `keryx trigger`'s own help — also called
 * directly by `src/cli.ts` for the top-level `keryx trigger --help` (AC5,
 * flow 294): the static `USAGE_BODY` slice `groupUsage` used to intercept
 * with named only `run <name>`, silently omitting
 * `list`/`status`/`schedule`/`install`/`uninstall`/`resolve` and every word
 * of the action/dispatch semantics below — a second copy of this same
 * subcommand list that had already drifted from it.
 */
export function printTriggerHelp(): void {
  printHelp();
}

function printHelp(): void {
  console.log(`keryx trigger — fire, install and inspect this project's declared triggers

Usage:
  keryx trigger run <name>        Perform exactly one pass of <name>'s action
  keryx trigger install           Install a git hook block for every event-fired entry
  keryx trigger uninstall         Remove those hook blocks (other managed blocks are untouched)
  keryx trigger list              List declared entries: enabled state, fire, action, hook status
  keryx trigger status [<name>]   Show the last recorded outcome for one or every entry
  keryx trigger schedule <name>   Print the cron line / systemd timer unit for a schedule entry
  keryx trigger resolve <runId> --spent <usd>
                                  Close a killed dispatch's spend reservation with what it really spent

Triggers are declared by hand in .metaproject/triggers.json (keryx never
writes it) and loaded by name. \`run\`:
  - exits 0 and says "nothing to do" when there is no trigger config, or the
    named trigger is disabled;
  - exits non-zero when the name is unknown, the matching entry is malformed,
    or the action itself fails;
  - refuses cleanly (exit 0, recorded) when another keryx run holds this
    project's maintenance lock — the same lock a manual \`keryx sync --apply\`
    or \`keryx gdgraph build\` takes (those WAIT for it, bounded; a triggered
    run refuses at once) — or when a spend ceiling (project-wide, or the
    trigger's own dispatch.ceilingUsd) is already reached.

Actions:
  reconcile   -> \`keryx sync --apply\`
  rebuild     -> \`keryx gdgraph build\`
  open-flow   opens a flow from action.template (skipIfOpen: no second one while
              an equivalent flow is open)
  flow-next   without a "dispatch" block: REPORT-ONLY — records action.flow's
              next task. With a "dispatch" block: DISPATCHES a keryx agent to
              work that task, unattended:
                dispatch: { provider, model, permissionMode ("ask" default |
                "trust"; "auto" is rejected), rates: { inputUsdPerMTok,
                outputUsdPerMTok } (both > 0), ceilingUsd, maxSeconds (1800),
                maxAttempts (3), network (false), baseUrl? (loopback only) }
              network: true gives the agent's shell commands the host's FULL
              network — the internet and every host loopback service. The model
              call is made outside the sandbox and never needs it.
              "trust" runs commands only inside the hardened Linux sandbox
              (bwrap: network off, home hidden, allow-listed env) and refuses
              to start without it; "ask" is read-only.
              The agent works in a throwaway git worktree on branch
              trigger/<flow>-<task> (committed, never pushed). The dispatcher
              records "task attempt started" before the model, then exactly one
              closing fact: "task done" only when the turn ended normally, the
              branch has a commit and \`keryx health gate\` passes there;
              otherwise "attempt failed|blocked" with the reason. It refuses
              (exit 0, "dispatch-refused") when the flow is not in progress or
              not frozen, nothing is ready, the task has an open attempt or hit
              maxAttempts, or another dispatch is on the same flow.
              Unattended means: every call that would ask is DENIED and
              recorded; the saved shell allowlist and the project's stored
              permission mode are ignored; no web, MCP, subagent or ask_user
              tools; a text floor (defence in depth, not the boundary) refuses
              git push/merge/tag/update-ref, publishing, mutating gh api,
              keryx flow state changes, nested trigger runs, and writes to
              flow.json, acceptance-criteria.md, triggers.json or the record.
              Cost: spend is RESERVED before the first model call; tokens
              always, USD from the declared rates; the run stops at its
              reservation. A killed run's reservation stays counted until
              \`keryx trigger resolve <runId> --spent <usd>\`.

\`install\` writes hooks for event-fired entries only; a schedule entry's line
comes from \`trigger schedule\`, and keryx never runs a daemon of its own.
`);
}
