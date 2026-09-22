// Flow 286 T7: `keryx trigger run <name>` — the single entry point every
// hook, cron line and CI job calls to fire one project trigger.
//
// This file is ADAPTER zone (`src/lib/import-zones.ts`: `commands` ->
// `adapter`). The decision logic (which entry `<name>` resolves to, whether a
// run may proceed under the project's trigger lock) lives in
// `../trigger/run.ts`, CORE zone — core may never import this directory
// (`src/lib/import-policy.ts`, enforced at zero), so the two are split this
// way on purpose, not by accident: this file is the only place allowed to
// import BOTH `../trigger/run` (core) and `./sync` / `./gdgraph` (adapter),
// and it is the one that actually dispatches to them.
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
import { triggersConfigPath } from "../trigger/config";

export async function triggerCommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printHelp();
    return;
  }

  if (sub !== "run") {
    console.error(`Unknown trigger command: ${sub}. Only "run" is implemented in this build.`);
    printHelp();
    process.exitCode = 1;
    return;
  }

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
  const { action } = resolution.entry;

  if (action.kind === "open-flow" || action.kind === "flow-next") {
    console.log(
      `keryx trigger run ${name}: action "${action.kind}" is not implemented in this build — refusing cleanly ` +
        "(flow 286 T11).",
    );
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
    return;
  }

  if (outcome.result.failed) {
    console.error(`keryx trigger run ${name}: action "${action.kind}" failed (see output above).`);
    process.exitCode = 1;
    return;
  }

  console.log(`keryx trigger run ${name}: ok — "${action.kind}" completed.`);
}

function printHelp(): void {
  console.log(`keryx trigger — fire one declared project trigger (git hook, cron line, CI job)

Usage:
  keryx trigger run <name>   Perform exactly one pass of <name>'s action

Triggers are declared by hand in .metaproject/triggers.json (keryx never
writes it) and loaded by name. A run:
  - exits 0 and says "nothing to do" when there is no trigger config, or the
    named trigger is disabled;
  - exits non-zero when the name is unknown, the matching entry is malformed,
    or the action itself fails;
  - refuses cleanly (exit 0) when another \`trigger run\` already holds this
    project's trigger lock, or when the action is "open-flow"/"flow-next"
    (not implemented in this build).

Only the "reconcile" (-> \`keryx sync --apply\`) and "rebuild" (->
\`keryx gdgraph build\`) actions run today.
`);
}
