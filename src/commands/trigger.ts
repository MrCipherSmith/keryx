// Flow 286 T7-T10: `keryx trigger` — the single entry point every hook, cron
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
// `open-flow` and `flow-next` are flow 286 T11's scope. Declaring one of them
// loads and validates fine (`../trigger/config.ts`, T6); RUNNING one here
// refuses cleanly rather than half-implementing flow-opening / do-not-
// duplicate / budget-refusal semantics that belong to that task.

import { gdgraphCommand } from "./gdgraph";
import { syncCommand } from "./sync";
import { resolveTriggerForRun, withTriggerRunLock, type TriggerResolution } from "../trigger/run";
import { loadTriggersConfig, triggersConfigPath, type TriggerAction, type TriggerEntry, type TriggerFire } from "../trigger/config";
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

  if (action.kind === "open-flow" || action.kind === "flow-next") {
    console.log(
      `keryx trigger run ${name}: action "${action.kind}" is not implemented in this build — refusing cleanly ` +
        "(flow 286 T11).",
    );
    await recordRun(projectRoot, entry, {
      outcome: "no-op",
      detail: `action "${action.kind}" is not implemented in this build — it never ran.`,
      cost: { recorded: false, reason: `action "${action.kind}" is not implemented in this build — it never ran` },
    });
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
  // layers. `NO_MODEL_COST` is honest for both outcomes below; T11's
  // `open-flow`/`flow-next` is what will eventually record a real
  // `{ recorded: true, usd }` here (AC8).
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
    project's trigger lock, or when the action is "open-flow"/"flow-next"
    (not implemented in this build).

Only the "reconcile" (-> \`keryx sync --apply\`) and "rebuild" (->
\`keryx gdgraph build\`) actions run today. \`install\` writes hooks for
event-fired entries only; a schedule entry's line comes from \`trigger
schedule\`, and keryx never runs a daemon of its own for it.
`);
}
