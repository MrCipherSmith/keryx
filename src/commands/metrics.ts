import { readFile } from "node:fs/promises";
import path from "node:path";
import { optionValue } from "../lib/args";
import {
  collectGitProvenance,
  compareExecutionRuns,
  createPairedBenchmarkTemplate,
  createExecutionRunRecord,
  readLatestPointer,
  selectLightweightPlan,
  stableJson,
  validatePairedBenchmark,
  validateRunRecord,
  writeRunArtifacts,
  type ExecutionEvent,
  type ExecutionRunRecord,
  type PairedBenchmarkRun,
  type RunMode,
} from "../metrics";

export async function metricsCommand(
  args: string[] = [],
  projectRoot: string = process.cwd(),
): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printMetricsHelp();
    return;
  }

  if (subcommand === "status") {
    const root = metricsRoot(projectRoot);
    console.log("# metrics status");
    console.log("");
    console.log(`root: ${root}`);
    console.log(`enabled: ${await Bun.file(path.join(projectRoot, ".metaproject", "metaproject.json")).exists() ? "yes" : "no"}`);
    const latest = await readLatestPointer(root);
    console.log(`latest: ${latest.status}`);
    return;
  }

  if (subcommand === "validate") {
    const file = args[1];
    if (!file) {
      console.error("Usage: keryx metrics validate <run.json>");
      process.exitCode = 1;
      return;
    }
    const record = JSON.parse(await readFile(path.resolve(projectRoot, file), "utf8")) as ExecutionRunRecord;
    const result = validateRunRecord(record);
    console.log(result.valid ? "valid: yes" : "valid: no");
    for (const error of result.errors) console.log(`- ${error}`);
    process.exitCode = result.valid ? 0 : 1;
    return;
  }

  if (subcommand === "collect") {
    await collect(projectRoot, args.slice(1));
    return;
  }

  if (subcommand === "latest") {
    const latest = await readLatestPointer(metricsRoot(projectRoot), await collectGitProvenance(projectRoot));
    console.log(JSON.stringify(latest, null, 2));
    process.exitCode = latest.status === "fresh" ? 0 : 1;
    return;
  }

  if (subcommand === "show") {
    const runId = args[1];
    if (!runId || !/^run-[A-Za-z0-9._-]+$/.test(runId)) {
      console.error("Usage: keryx metrics show <run-id>");
      process.exitCode = 1;
      return;
    }
    const file = path.join(metricsRoot(projectRoot), "runs", `${runId}.json`);
    if (!(await Bun.file(file).exists())) {
      console.error(`Run not found: ${runId}`);
      process.exitCode = 1;
      return;
    }
    console.log(await readFile(file, "utf8"));
    return;
  }

  if (subcommand === "compare") {
    const runA = args[1];
    const runB = args[2];
    if (!runA || !runB || !/^run-[A-Za-z0-9._-]+$/.test(runA) || !/^run-[A-Za-z0-9._-]+$/.test(runB)) {
      console.error("Usage: keryx metrics compare <run-a> <run-b> [--json]");
      process.exitCode = 1;
      return;
    }
    const a = JSON.parse(await readFile(path.join(metricsRoot(projectRoot), "runs", `${runA}.json`), "utf8")) as ExecutionRunRecord;
    const b = JSON.parse(await readFile(path.join(metricsRoot(projectRoot), "runs", `${runB}.json`), "utf8")) as ExecutionRunRecord;
    const comparison = compareExecutionRuns(a, b);
    console.log(stableJson(comparison));
    return;
  }

  if (subcommand === "rebuild") {
    const source = optionValue(args, "--source");
    if (!source) {
      console.error("Usage: keryx metrics rebuild --source <events.json>");
      process.exitCode = 1;
      return;
    }
    await collect(projectRoot, ["--events", source]);
    return;
  }

  if (subcommand === "plan") {
    if (optionValue(args, "--profile") !== "lightweight") {
      console.log(JSON.stringify({ profile: "full", skipped: [] }, null, 2));
      return;
    }
    const changedFiles = (optionValue(args, "--changed") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
    const reviewers = (optionValue(args, "--reviewers") ?? "review-logic").split(",").map((item) => item.trim()).filter(Boolean);
    console.log(JSON.stringify(selectLightweightPlan({ changedFiles, reviewers }), null, 2));
    return;
  }

  if (subcommand === "benchmark" && args[1] === "init") {
    const taskIds = (optionValue(args, "--tasks") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
    const out = optionValue(args, "--out");
    if (!out) {
      console.error("Usage: keryx metrics benchmark init --tasks <task-a,task-b,task-c> --out <manifest.json>");
      process.exitCode = 1;
      return;
    }
    const template = createPairedBenchmarkTemplate(taskIds);
    await Bun.write(path.resolve(projectRoot, out), stableJson(template));
    console.log(`manifest: ${path.relative(projectRoot, path.resolve(projectRoot, out))}`);
    return;
  }

  if (subcommand === "benchmark" && args[1] === "validate") {
    const file = args[2];
    if (!file) {
      console.error("Usage: keryx metrics benchmark validate <manifest.json>");
      process.exitCode = 1;
      return;
    }
    const raw = JSON.parse(await readFile(path.resolve(projectRoot, file), "utf8")) as PairedBenchmarkRun[] | { runs?: PairedBenchmarkRun[] };
    const input = Array.isArray(raw) ? raw : raw.runs ?? [];
    const result = validatePairedBenchmark(input);
    console.log(stableJson(result));
    process.exitCode = result.valid ? 0 : 1;
    return;
  }

  console.error(`Unknown metrics command: ${subcommand}`);
  printMetricsHelp();
  process.exitCode = 1;
}

async function collect(projectRoot: string, args: string[]): Promise<void> {
  const eventFile = optionValue(args, "--events");
  if (!eventFile) {
    console.error("Usage: keryx metrics collect --events <events.json> [--run-id <id>] [--skill <name>]");
    process.exitCode = 1;
    return;
  }
  const raw = JSON.parse(await readFile(path.resolve(projectRoot, eventFile), "utf8")) as ExecutionEvent[] | { events: ExecutionEvent[] };
  const events = Array.isArray(raw) ? raw : raw.events;
  const startedAt = optionValue(args, "--started-at") ?? events[0]?.timestamp_utc ?? new Date().toISOString();
  const finishedAt = optionValue(args, "--finished-at") ?? events.at(-1)?.timestamp_utc ?? startedAt;
  const runMode = (optionValue(args, "--run-mode") ?? "user-direct") as RunMode;
  const record = createExecutionRunRecord({
    runId: optionValue(args, "--run-id") ?? `run-${Date.now()}`,
    runMode,
    skill: optionValue(args, "--skill") ?? "metrics",
    startedAt,
    finishedAt,
    provenance: await collectGitProvenance(projectRoot),
    events,
    parentRunId: optionValue(args, "--parent-run-id") ?? null,
  });
  const result = await writeRunArtifacts(metricsRoot(projectRoot), record, { cwd: projectRoot });
  console.log(`json: ${path.relative(projectRoot, result.jsonPath)}`);
  console.log(`markdown: ${path.relative(projectRoot, result.markdownPath)}`);
}

function metricsRoot(projectRoot: string): string {
  return path.join(projectRoot, ".metaproject", "data", "metrics");
}

export function printMetricsHelp(): void {
  console.log(`keryx metrics

Usage:
  keryx metrics status
  keryx metrics collect --events <events.json> [--run-id <id>] [--skill <name>]
  keryx metrics validate <run.json>
  keryx metrics latest
  keryx metrics show <run-id>
  keryx metrics compare <run-a> <run-b> [--json]
  keryx metrics rebuild --source <events.json>
  keryx metrics plan --profile lightweight [--changed <file,...>]
  keryx metrics benchmark init --tasks <task-a,task-b,task-c> --out <manifest.json>
  keryx metrics benchmark validate <manifest.json>
`);
}
