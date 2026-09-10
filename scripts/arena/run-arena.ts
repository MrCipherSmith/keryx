// The entry point.
//
// `--dry-run` is the reason this file is worth reading. It builds every tree,
// provisions every context arm, runs every assertion, prints every arm's inventory
// and its resolved environment — and calls no model. The plan's verification step is
// "isolation is proven, not declared", and a dry run is where that proof happens,
// before the first dollar. A control arm that turns out to resolve `keryx`, or a
// context arm whose graph did not build, fails here rather than in hour three of a
// sweep.
//
// The pilot's runner has a positional flag scanner, no `--help`, and a timeout
// hardcoded mid-file. All three are fixed, not because tidiness matters but because
// the one thing a long expensive run must support is being re-entered by someone who
// did not write it.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createBaseTreeCache } from "./arena-checkout";
import { arenaInventory } from "./arena-context";
import { buildArenaEnv } from "./arena-env";
import { ARENA_HARNESSES, harnessById, type ArenaHarnessSpec } from "./arena-harnesses";
import { extractOxlintFindings } from "./arena-gates";
import { createLeakageCheck } from "./arena-leakage";
import { createArenaProvisioner } from "./arena-provision";
import { buildArenaPrompt } from "./arena-prompts";
import { decideResearch, pairByTask } from "./arena-scoring";
import { runArenaSweep, comparableRows, loadArenaFailures, loadArenaResults } from "./arena-sweep";
import { loadFrozenT1, loadTaskFile, type ArenaTask } from "./arena-tasks";
import { firstArmFor, runArenaArm, type Arm } from "./arena-run";
import { thresholdsFor } from "./arena-watchdog";

const USAGE = `
run-arena — measure keryx's context layer on an external repository

Usage:
  bun scripts/arena/run-arena.ts --repo <path> --out <dir> [options]

Required:
  --repo <path>        a local clone of the target repository
  --out <dir>          where results.jsonl, failures.jsonl and verdict.json go

Options:
  --harness <a,b,c>    legs to run (default: ${ARENA_HARNESSES.map((h) => h.id).join(",")})
  --task <id>          run only this task id (repeatable via commas)
  --tasks-file <path>  frozen T1 artifact (default: arena/tasks/t1-tasks.json)
  --t2-file <path>     the implement task (default: arena/tasks/t2-4490.md)
  --node-modules <dir> a tree whose node_modules is cloned into each arm (T2 needs it)
  --lint-baseline <f>  oxlint output from the untouched tree; new findings fail the gate
  --dry-run            build and assert everything, call no model, spend nothing
  --help               this text

A dry run is the verification step, not a convenience: it proves each arm is the arm
it claims to be before any money is spent.
`.trimStart();

interface Args {
  readonly repo: string;
  readonly out: string;
  readonly harnesses: readonly ArenaHarnessSpec[];
  readonly taskIds: readonly string[];
  readonly tasksFile: string;
  readonly t2File: string;
  readonly nodeModules?: string;
  readonly lintBaseline: readonly string[];
  readonly dryRun: boolean;
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function parseArgs(argv: readonly string[]): Args {
  const repoRoot = flag(argv, "repo");
  const out = flag(argv, "out");
  if (repoRoot === undefined || out === undefined) throw new Error(`${USAGE}\nmissing --repo or --out`);

  const here = import.meta.dir;
  const harnessArg = flag(argv, "harness");
  const baselineFile = flag(argv, "lint-baseline");

  return {
    repo: path.resolve(repoRoot),
    out: path.resolve(out),
    harnesses:
      harnessArg === undefined
        ? ARENA_HARNESSES
        : harnessArg.split(",").map((id) => harnessById(id.trim())),
    taskIds: (flag(argv, "task") ?? "").split(",").map((id) => id.trim()).filter(Boolean),
    tasksFile: flag(argv, "tasks-file") ?? path.join(here, "..", "..", "arena", "tasks", "t1-tasks.json"),
    t2File: flag(argv, "t2-file") ?? path.join(here, "..", "..", "arena", "tasks", "t2-4490.md"),
    ...(flag(argv, "node-modules") === undefined ? {} : { nodeModules: path.resolve(flag(argv, "node-modules") as string) }),
    lintBaseline:
      baselineFile !== undefined && existsSync(baselineFile)
        ? extractOxlintFindings(readFileSync(baselineFile, "utf8"))
        : [],
    dryRun: argv.includes("--dry-run"),
  };
}

function loadTasks(args: Args): ArenaTask[] {
  const tasks: ArenaTask[] = [...loadFrozenT1(args.tasksFile)];
  if (existsSync(args.t2File)) tasks.push(loadTaskFile(args.t2File));
  if (args.taskIds.length === 0) return tasks;
  const wanted = new Set(args.taskIds);
  const selected = tasks.filter((task) => wanted.has(task.id));
  if (selected.length === 0) {
    throw new Error(`no task matched ${[...wanted].join(", ")} — known: ${tasks.map((t) => t.id).join(", ")}`);
  }
  return selected;
}

/**
 * Print what each arm would hold, and refuse anything that is not what it claims.
 *
 * Every assertion the real run makes happens here too, in the same order. The only
 * thing that does not happen is the model call — so a dry run that passes and a
 * sweep that fails on arm construction is a contradiction this cannot produce.
 */
async function dryRun(args: Args, tasks: readonly ArenaTask[]): Promise<void> {
  const cache = createBaseTreeCache({
    repoRoot: args.repo,
    cacheDir: path.join(args.out, "cache"),
    ...(args.nodeModules === undefined ? {} : { nodeModulesTemplate: args.nodeModules }),
    onFallbackCopy: (from) => console.log(`  note: clonefile unavailable, real copy of ${from}`),
  });

  const provisioner = createArenaProvisioner({
    commitFor: () => "",
    onStep: (outcome) => {
      if (!outcome.ok) console.log(`  step ${outcome.command} exited ${String(outcome.exitCode)}`);
    },
  });
  const checkLeakage = createLeakageCheck();

  console.log(`repo: ${args.repo}`);
  console.log(`tasks: ${tasks.length} (${tasks.filter((t) => t.type === "research").length} research, ${tasks.filter((t) => t.type === "implement").length} implement)`);
  console.log(`legs: ${args.harnesses.map((h) => `${h.id}@${h.model}`).join(", ")}`);
  console.log(`lint baseline: ${args.lintBaseline.length} findings`);
  console.log("");

  for (const harness of args.harnesses) {
    console.log(`=== ${harness.id} @ ${harness.model} ===`);
    console.log(`  ${harness.note}`);
    for (const arm of ["context-on", "context-off"] as Arm[]) {
      const env = buildArenaEnv({
        parent: process.env,
        home: path.join(args.out, "home-probe"),
        arm,
        harness: harness.id,
      });
      const resolvesKeryx = (env.PATH ?? "")
        .split(path.delimiter)
        .some((entry) => entry.length > 0 && existsSync(path.join(entry, "keryx")));
      console.log(`  ${arm}: env keys ${Object.keys(env).sort().join(",")}`);
      console.log(`  ${arm}: resolves keryx = ${resolvesKeryx}`);
    }
    console.log("");
  }

  const sample = tasks[0];
  if (sample === undefined) throw new Error("no tasks to probe");
  const probeHarness = args.harnesses[0];
  if (probeHarness === undefined) throw new Error("no harness to probe");

  console.log(`=== arm construction, probed on ${sample.id} ===`);
  console.log(`  base: ${sample.base}`);
  console.log(`  first arm: ${firstArmFor(probeHarness.id, sample.id)}`);
  console.log(`  prompt (${buildArenaPrompt(sample).length} chars):`);
  for (const line of buildArenaPrompt(sample).split("\n")) console.log(`    | ${line}`);

  for (const arm of ["context-on", "context-off"] as Arm[]) {
    const treePath = path.join(args.out, "dry", `${sample.id}-${probeHarness.id}-${arm}`);
    await cache.materialize(sample.base, treePath);
    if (arm === "context-on") {
      await provisioner.provision(treePath);
      if (sample.answerNeedles.length > 0) checkLeakage(treePath, sample.answerNeedles);
    } else {
      const { arenaStripContext } = await import("./arena-context");
      arenaStripContext(treePath);
    }
    const inventory = arenaInventory(treePath);
    console.log(`  ${arm}: ${JSON.stringify(inventory)}`);
    await provisioner.release(treePath);
  }

  const budgets = tasks.map((task) => `${task.id}=${Math.round(thresholdsFor(task.type).ceilingMs / 60_000)}m`);
  console.log("");
  console.log(`watchdog ceilings: ${budgets.join(" ")}`);
  console.log("");
  console.log("dry run complete — nothing was spent. Drop --dry-run to sweep.");
}

async function sweep(args: Args, tasks: readonly ArenaTask[]): Promise<void> {
  const resultsPath = path.join(args.out, "results.jsonl");
  const failuresPath = path.join(args.out, "failures.jsonl");
  const cache = createBaseTreeCache({
    repoRoot: args.repo,
    cacheDir: path.join(args.out, "cache"),
    ...(args.nodeModules === undefined ? {} : { nodeModulesTemplate: args.nodeModules }),
  });
  const checkLeakage = createLeakageCheck();

  for (const harness of args.harnesses) {
    console.log(`=== ${harness.id} @ ${harness.model} — ${harness.note} ===`);
    const report = await runArenaSweep({
      harness: harness.id,
      tasks,
      resultsPath,
      failuresPath,
      onProgress: (message) => console.log(`  ${message}`),
      firstArm: (task) => firstArmFor(harness.id, task.id),
      runArm: async (task, arm) => {
        const full = tasks.find((candidate) => candidate.id === task.id);
        if (full === undefined) throw new Error(`task ${task.id} vanished between planning and running`);
        const ceiling = thresholdsFor(full.type).ceilingMs;
        return runArenaArm(full, arm, {
          repoRoot: args.repo,
          worktreesDir: path.join(args.out, "arms"),
          // The adapter's own timeout sits ABOVE the watchdog ceiling so the
          // watchdog always wins and a kill always carries a reason.
          agent: harness.createAgent({ timeoutMs: ceiling + 60_000 }),
          model: harness.model,
          cache,
          provisioner: createArenaProvisioner({ commitFor: () => full.base }),
          checkLeakage,
          transcriptsDir: path.join(args.out, "transcripts"),
        });
      },
    });
    console.log(`  ran ${report.ran.length}, skipped ${report.skipped.length}, failed ${report.failed.length}`);
  }

  const results = loadArenaResults(resultsPath);
  const failures = loadArenaFailures(failuresPath);
  const comparable = comparableRows(results, failures);

  console.log("");
  console.log("=== verdicts ===");
  for (const harness of args.harnesses) {
    const rows = comparable
      .filter((row) => row.harness === harness.id && row.taskType === "research")
      .map((row) => ({
        taskId: row.taskId,
        arm: row.arm,
        recall: row.score.kind === "research" ? row.score.retrieval.recall : 0,
        tokens: row.contextTokens,
      }));
    const verdict = decideResearch(harness.id, pairByTask(rows));
    console.log(`${harness.id}: ${verdict.reason}`);
  }
  if (failures.length > 0) {
    console.log("");
    console.log(`=== ${failures.length} failed arm(s), never silently dropped ===`);
    for (const failure of failures) console.log(`  ${failure.harness} ${failure.taskId} ${failure.arm}: ${failure.reason}`);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.length === 0) {
    console.log(USAGE);
  } else {
    const args = parseArgs(argv);
    const tasks = loadTasks(args);
    // Kept so a reader can see the home the probe used is not the operator's.
    if (args.dryRun) console.log(`(real home ${homedir()} is never handed to an arm)`);
    await (args.dryRun ? dryRun(args, tasks) : sweep(args, tasks));
  }
}
