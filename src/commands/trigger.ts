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
  readTriggerRuns,
  type TriggerRunCost,
  type TriggerRunOutcomeKind,
  type TriggerRunRecord,
} from "../trigger/record";
import { hasGitHooksRoot, installTriggerHooks, isTriggerHookInstalled, uninstallTriggerHooks } from "../trigger/hooks";
import { renderScheduleLines, resolveKeryxInvocation, resolveScheduleEntry } from "../trigger/schedule";
import type { FlowService } from "../flow/types";
import type { NextTaskDecision } from "../flow/machine";

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
async function runTrigger(projectRoot: string, name: string): Promise<void> {
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
      await runReadyTrigger(projectRoot, name, resolution);
      return;
    }
  }
}

async function runReadyTrigger(
  projectRoot: string,
  name: string,
  resolution: Extract<TriggerResolution, { kind: "ready" }>,
): Promise<void> {
  const { entry } = resolution;
  const { action } = entry;

  if (action.kind === "open-flow") {
    await runOpenFlow(projectRoot, name, entry, action);
    return;
  }
  if (action.kind === "flow-next") {
    await runFlowNext(projectRoot, name, entry, action);
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
  // `flow-next` (T11) never reach this branch at all — see `runOpenFlow`/
  // `runFlowNext` above, which record their own outcomes; neither of those
  // calls a model either (this build scopes `flow-next` to REPORTING the next
  // task, not dispatching an agent turn — see `runFlowNext`'s own comment for
  // why), so `NO_MODEL_COST` stays accurate everywhere a cost is recorded
  // today. A real `{ recorded: true, usd }` has no producer yet.
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
  'action "flow-next" does not call a model in this build — it only reports the next task into this record; it never ' +
    "dispatches an agent turn, so there is nothing to record a cost for.",
);

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

  if (action.skipIfOpen) {
    const flows = await service.list({ cwd: projectRoot });
    const equivalent = findEquivalentOpenFlow(flows, action.template);
    if (equivalent) {
      const detail =
        `flow ${equivalent.id} ("${equivalent.title}", status: ${equivalent.status}) is already open for ` +
        `template "${action.template}" and \`skipIfOpen\` is set — not opening a second one.`;
      console.log(`keryx trigger run ${name}: ${detail}`);
      await recordRun(projectRoot, entry, { outcome: "no-op", detail, cost: OPEN_FLOW_NO_MODEL_COST });
      return;
    }
  }

  try {
    const result = await service.init({ cwd: projectRoot, title: action.template });
    const detail = `opened flow ${result.flow.id} ("${action.template}") at ${result.dir}.`;
    console.log(`keryx trigger run ${name}: ok — ${detail}`);
    await recordRun(projectRoot, entry, { outcome: "ok", detail, cost: OPEN_FLOW_NO_MODEL_COST });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`keryx trigger run ${name}: action "open-flow" failed: ${message}`);
    process.exitCode = 1;
    await recordRun(projectRoot, entry, {
      outcome: "failed",
      detail: `action "open-flow" failed: ${message}`,
      cost: OPEN_FLOW_NO_MODEL_COST,
    });
  }
}

// ---------------------------------------------------------------------------
// flow-next (T11, AC8)
// ---------------------------------------------------------------------------
//
// SCOPE DECISION, recorded here and in the flow's journal.md: `flow-next`
// REPORTS `keryx flow next <flow>`'s own decision (ready/blocked/none, plus
// unresolved tasks) into the fired-trigger record; it does not dispatch an
// agent to work the task. "Running" a task honestly means handing it to an
// agent for a real turn, which costs money and needs a human or an
// orchestrator to actually own the dispatch (model choice, tool access,
// review afterward) — none of which a `keryx trigger run` firing unattended
// from a git hook or cron line has any way to supply safely. Reporting is the
// scope this build can do HONESTLY: it turns "an event happened" into "here
// is what a person or an orchestrator should do next", which is exactly the
// gap description.md names ("no record that a triggered run happened"),
// without pretending to a dispatch capability this command does not have. A
// future dispatching `flow-next` is a real, larger feature (choosing a
// runner, a model tier, capturing its own review) — not a difference in how
// this function reads `NextTaskDecision`.
async function runFlowNext(
  projectRoot: string,
  name: string,
  entry: TriggerEntry,
  action: Extract<TriggerAction, { kind: "flow-next" }>,
): Promise<void> {
  const budget = await evaluateTriggerBudget(projectRoot, "flow-next");
  if (!budget.allowed) {
    await refuseOnBudget(projectRoot, name, entry, budget.reason);
    return;
  }

  const service = getFlowService();
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
  outcome: { outcome: TriggerRunOutcomeKind; detail: string; cost: TriggerRunCost },
): Promise<void> {
  const append = await appendTriggerRunRecord(projectRoot, {
    at: new Date().toISOString(),
    trigger: entry.name,
    firedBy: entry.fire,
    action: entry.action,
    outcome: outcome.outcome,
    detail: outcome.detail,
    cost: outcome.cost,
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
  if (action.kind === "flow-next") return `flow-next(${action.flow})`;
  return action.kind;
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

function printHelp(): void {
  console.log(`keryx trigger — fire, install and inspect this project's declared triggers

Usage:
  keryx trigger run <name>        Perform exactly one pass of <name>'s action
  keryx trigger install           Install a git hook block for every event-fired entry
  keryx trigger uninstall         Remove those hook blocks (other managed blocks are untouched)
  keryx trigger list              List declared entries: enabled state, fire, action, hook status
  keryx trigger status [<name>]   Show the last recorded outcome for one or every entry (AC4)
  keryx trigger schedule <name>   Print the cron line / systemd timer unit for a schedule entry

Triggers are declared by hand in .metaproject/triggers.json (keryx never
writes it) and loaded by name. \`run\`:
  - exits 0 and says "nothing to do" when there is no trigger config, or the
    named trigger is disabled;
  - exits non-zero when the name is unknown, the matching entry is malformed,
    or the action itself fails;
  - refuses cleanly (exit 0) when another \`trigger run\` already holds this
    project's trigger lock ("reconcile"/"rebuild" only), or when the
    project's recorded trigger spend is at or over its spend ceiling
    ("open-flow"/"flow-next" only — see \`keryx trigger status\` for the
    recorded cost).

Four actions run today: "reconcile" (-> \`keryx sync --apply\`), "rebuild"
(-> \`keryx gdgraph build\`), "open-flow" (opens a flow from
\`action.template\`, skipping a second one while an equivalent flow is
already open when \`action.skipIfOpen\` is set), and "flow-next" (reports
\`action.flow\`'s next task into the record — it does not dispatch an agent
to work it). \`install\` writes hooks for event-fired entries only; a
schedule entry's line comes from \`trigger schedule\`, and keryx never runs a
daemon of its own for it.
`);
}
