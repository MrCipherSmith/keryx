#!/usr/bin/env bun
// Entry point for the context-retrieval measurement.
//
//   bun scripts/benchmark/run-retrieval.ts --repo <path> --tasks 50 --out <dir>
//
// Resumable: point it at the same --out and it picks up where it stopped.
// See docs/requirements/keryx-context-measurement/pre-registration.md.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClaudeAgent } from "./retrieval-agent-claude";
import { createKeryxProvisioner } from "./retrieval-provision";
import { runSweep, selectModel } from "./retrieval-sweep";
import { extractRetrievalTasks } from "./retrieval-tasks";

function flag(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || process.argv[index + 1] === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing --${name}`);
  }
  return process.argv[index + 1]!;
}

const repoRoot = flag("repo");
const limit = Number(flag("tasks", "50"));
const outDir = flag("out");
const before = flag("before", "2026-08-20");

await mkdir(outDir, { recursive: true });
const resultsPath = path.join(outDir, "results.jsonl");
const worktreesDir = path.join(outDir, "worktrees");
await mkdir(worktreesDir, { recursive: true });

const { tasks, dropped } = extractRetrievalTasks({ repoRoot, limit: 2000, before });
const chosen = tasks.slice(0, limit);

console.log(`repo:    ${repoRoot}`);
console.log(`tasks:   ${chosen.length} of ${tasks.length} available`);
console.log(`dropped: ${JSON.stringify(dropped)}`);
// Stated before the sweep runs, so the split cannot be described after the fact.
const hard = chosen.filter((t) => selectModel(t) !== selectModel({ ...t, gold: ["x"] })).length;
console.log(`models:  ${hard} on the larger model, ${chosen.length - hard} on the smaller`);
console.log(`out:     ${outDir}\n`);

const provisioner = createKeryxProvisioner();
const report = await runSweep({
  repoRoot,
  worktreesDir,
  resultsPath,
  tasks: chosen,
  agent: createClaudeAgent({ timeoutMs: 12 * 60 * 1000 }),
  provisioner,
  onProgress: (message) => console.log(message),
});

await writeFile(
  path.join(outDir, "verdict.json"),
  `${JSON.stringify({ repoRoot, before, dropped, ...report, results: undefined }, null, 2)}\n`,
  "utf8",
);

console.log(`\nverdict: ${JSON.stringify(report.verdict, null, 2)}`);
if (report.failed.length > 0) {
  console.log(`\n${report.failed.length} task(s) failed:`);
  for (const failure of report.failed) console.log(`  ${failure.taskId}: ${failure.reason}`);
}
if (provisioner.leftovers.length > 0) {
  console.log(`\nregistry entries not released: ${provisioner.leftovers.join(", ")}`);
}
