#!/usr/bin/env bun
// Flow 114 / AC6 + AC7 — cold-start measurement for open item O-5 (PRD R5,
// "measure cold-start of the TUI vs the current instant readline shell").
//
// WHAT IS MEASURED — three cold processes, wall-clock from spawn to exit:
//
//   runtime-floor      an empty script. The Bun runtime's own start cost, so the
//                      other two numbers can be read as "on top of what".
//   readline           the real CLI: `keryx shell --provider fake --no-tui` with
//                      stdin already at EOF. It parses argv, builds the shell,
//                      prints its header and exits — the "instant readline
//                      shell" R5 compares against, end to end.
//   readline+tui-load  the very same command, preloaded with everything the TUI
//                      path loads before it would draw: the TUI shell module
//                      graph, the optional TUI dependency, and the prebuilt
//                      native library actually dlopen'd through its FFI loader.
//
// The difference between the last two is the cost the TUI adds to start-up.
//
// WHAT IS NOT MEASURED — a rendered first frame. `createCliRenderer` requires a
// controlling terminal; a CI step (and this script) has none, which is the same
// constraint that leaves "a global install launches the TUI" unprovable without
// a pty harness. So this is the dominant term of TUI start-up, not its total.
// The report prints that caveat with the numbers, every time, on purpose.
//
// Usage:  bun ./scripts/measure-cold-start.ts [--runs N] [--json <path>]

import { cpus, totalmem } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CLI = join(REPO_ROOT, "src", "cli.ts");

const DEFAULT_RUNS = 11;
/** Discarded: the first spawns pay for filesystem cache the later ones reuse. */
const WARMUP_RUNS = 2;

interface Options {
  runs: number;
  json: string | undefined;
}

function parseOptions(argv: string[]): Options {
  let runs = DEFAULT_RUNS;
  let json: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--runs") {
      const value = Number.parseInt(argv[index + 1] ?? "", 10);
      if (!Number.isFinite(value) || value < 3) {
        throw new Error("--runs needs an integer >= 3 (a median wants more than a sample)");
      }
      runs = value;
      index += 1;
    } else if (arg === "--json") {
      json = argv[index + 1];
      if (json === undefined) {
        throw new Error("--json needs a path");
      }
      index += 1;
    } else if (arg !== undefined) {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { runs, json };
}

/** The preloaded module for the `readline+tui-load` scenario. */
const TUI_PRELOAD_SOURCE = `
// Everything the TUI path pulls in before it would call the renderer: the shell
// module graph, the optional dependency, and the native library dlopen'd for
// real. The dependency is named only here, in generated source, and reached only
// through a dynamic import — the rule \`src/capability/no-optional-imports\`
// enforces over \`src/\`.
await import(${JSON.stringify(join(REPO_ROOT, "src", "tui", "tui-shell.ts"))});
await import(${JSON.stringify(join(REPO_ROOT, "src", "tui", "chat-shell.ts"))});
const core = await import("@opentui/core");
core.resolveRenderLib();
`;

interface Scenario {
  name: string;
  what: string;
  argv: string[];
}

interface Sample {
  name: string;
  runsMs: number[];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? Number.NaN;
  }
  return ((sorted[middle - 1] ?? Number.NaN) + (sorted[middle] ?? Number.NaN)) / 2;
}

function ms(value: number): string {
  return `${value.toFixed(1)} ms`;
}

const options = parseOptions(process.argv.slice(2));
const workspace = mkdtempSync(join(tmpdir(), "keryx-coldstart-"));

try {
  const emptyScript = join(workspace, "empty.ts");
  const preload = join(workspace, "tui-preload.ts");
  const home = join(workspace, "home");
  writeFileSync(emptyScript, "export {};\n", "utf8");
  writeFileSync(preload, TUI_PRELOAD_SOURCE, "utf8");

  // `--provider fake` keeps the run free of network and of provider credentials;
  // `--no-tui` is the readline path by construction rather than by accident.
  const shellArgv = [CLI, "shell", "--provider", "fake", "--model", "fake-echo", "--no-tui"];

  const scenarios: Scenario[] = [
    { name: "runtime-floor", what: "bun starts and exits an empty module", argv: [emptyScript] },
    { name: "readline", what: "`keryx shell --no-tui`, stdin at EOF", argv: shellArgv },
    {
      name: "readline+tui-load",
      what: "the same, plus the TUI module graph and the native library dlopen'd",
      argv: ["--preload", preload, ...shellArgv],
    },
  ];

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    NO_COLOR: "1",
  };

  function runOnce(scenario: Scenario): number {
    const started = Bun.nanoseconds();
    const proc = Bun.spawnSync(["bun", ...scenario.argv], {
      cwd: workspace,
      stdin: new Blob([""]),
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const elapsed = (Bun.nanoseconds() - started) / 1e6;
    if (proc.exitCode !== 0) {
      throw new Error(
        `scenario "${scenario.name}" exited ${proc.exitCode}:\n${new TextDecoder().decode(proc.stderr)}`,
      );
    }
    return elapsed;
  }

  const samples: Sample[] = [];
  for (const scenario of scenarios) {
    for (let index = 0; index < WARMUP_RUNS; index += 1) {
      runOnce(scenario);
    }
    const runsMs: number[] = [];
    for (let index = 0; index < options.runs; index += 1) {
      runsMs.push(runOnce(scenario));
    }
    samples.push({ name: scenario.name, runsMs });
  }

  const commit = Bun.spawnSync(["git", "-C", REPO_ROOT, "rev-parse", "--short", "HEAD"]);
  const machine = {
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model ?? "unknown",
    cpuCount: cpus().length,
    totalMemGiB: Number((totalmem() / 1024 ** 3).toFixed(1)),
    bun: Bun.version,
    commit: new TextDecoder().decode(commit.stdout).trim(),
    runner: process.env.RUNNER_NAME ?? process.env.GITHUB_JOB ?? "local",
    measuredAt: new Date().toISOString(),
  };

  const byName = new Map(samples.map((sample) => [sample.name, sample]));
  const medians = new Map(samples.map((sample) => [sample.name, median(sample.runsMs)]));
  const readline = medians.get("readline") ?? Number.NaN;
  const withTui = medians.get("readline+tui-load") ?? Number.NaN;
  const floor = medians.get("runtime-floor") ?? Number.NaN;

  console.log("Cold-start measurement — flow 114 / open item O-5 (PRD R5)");
  console.log("");
  console.log(`  platform   ${machine.platform}-${machine.arch} (${machine.runner})`);
  console.log(`  cpu        ${machine.cpu} x${machine.cpuCount}, ${machine.totalMemGiB} GiB`);
  console.log(`  bun        ${machine.bun}`);
  console.log(`  commit     ${machine.commit}`);
  console.log(`  runs       ${options.runs} measured, ${WARMUP_RUNS} warm-up discarded`);
  console.log("");
  console.log("  scenario             median      min      max   what");
  for (const scenario of scenarios) {
    const runsMs = byName.get(scenario.name)?.runsMs ?? [];
    const pad = scenario.name.padEnd(18);
    console.log(
      `  ${pad}  ${median(runsMs).toFixed(1).padStart(7)}  ` +
        `${Math.min(...runsMs).toFixed(1).padStart(7)}  ` +
        `${Math.max(...runsMs).toFixed(1).padStart(7)}   ${scenario.what}`,
    );
  }
  console.log("");
  console.log(`  readline shell start-up ..................... ${ms(readline)}`);
  console.log(`  of which is the Bun runtime itself .......... ${ms(floor)}`);
  console.log(`  the TUI load adds ........................... ${ms(withTui - readline)}`);
  console.log(
    `  total before the TUI could draw ............. ${ms(withTui)} ` +
      `(${(withTui / readline).toFixed(2)}x readline)`,
  );
  console.log("");
  console.log("  NOT MEASURED: a rendered first frame. `createCliRenderer` needs a");
  console.log("  controlling terminal, which neither this script nor a CI step has, so");
  console.log("  the renderer is never constructed here. These numbers are the dominant");
  console.log("  term of TUI start-up — process start, module graph, and the native");
  console.log("  library load — not its total. Reading them as time-to-first-frame would");
  console.log("  claim more than was measured.");

  if (options.json !== undefined) {
    writeFileSync(
      options.json,
      `${JSON.stringify({ machine, runs: options.runs, samples, medians: Object.fromEntries(medians) }, null, 2)}\n`,
      "utf8",
    );
    console.log("");
    console.log(`  raw per-run numbers written to ${options.json}`);
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
