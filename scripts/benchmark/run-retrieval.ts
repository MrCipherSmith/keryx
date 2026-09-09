#!/usr/bin/env bun
// Entry point for the context-retrieval measurement.
//
//   bun scripts/benchmark/run-retrieval.ts --repo <path> --tasks 50 --out <dir> \
//     [--harness claude,grok,keryx]
//
// Resumable: point it at the same --out and it picks up where it stopped —
// per harness, so a finished claude leg does not make an untouched grok leg
// look complete.
// See docs/requirements/keryx-context-measurement/pre-registration.md.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createKeryxProvisioner } from "./retrieval-provision";
import { harnessById, modelFor } from "./retrieval-harnesses";
import { runSweep } from "./retrieval-sweep";
import { extractRetrievalTasks } from "./retrieval-tasks";
import { decideByHarness, type ArmResult } from "./retrieval-scoring";

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
const harnesses = flag("harness", "claude")
  .split(",")
  .map((id) => id.trim())
  .filter((id) => id.length > 0)
  .map(harnessById);

await mkdir(outDir, { recursive: true });
const resultsPath = path.join(outDir, "results.jsonl");
const worktreesDir = path.join(outDir, "worktrees");
await mkdir(worktreesDir, { recursive: true });

const { tasks, dropped } = extractRetrievalTasks({ repoRoot, limit: 2000, before });
const chosen = tasks.slice(0, limit);

console.log(`repo:    ${repoRoot}`);
console.log(`tasks:   ${chosen.length} of ${tasks.length} available`);
console.log(`dropped: ${JSON.stringify(dropped)}`);
// Stated before the sweep runs, so no split can be described after the fact.
for (const harness of harnesses) {
  const hard = chosen.filter((task) => modelFor(harness, task) === harness.hardModel).length;
  console.log(
    `harness: ${harness.id} — ${hard} ${harness.hardModel}, ${chosen.length - hard} ${harness.easyModel} ` +
      `(${harness.note})`,
  );
}
console.log(`out:     ${outDir}\n`);

const provisioner = createKeryxProvisioner();
// Sequentially, one harness at a time, into ONE results file. Two agent CLIs
// running at once would contend for the same checkout machinery, and a flaky
// harness shows up as variance in the numbers rather than as an error.
const allResults: ArmResult[] = [];
const failures: { harness: string; taskId: string; reason: string }[] = [];
for (const harness of harnesses) {
  console.log(`\n=== ${harness.id} ===`);
  const report = await runSweep({
    repoRoot,
    worktreesDir,
    resultsPath,
    tasks: chosen,
    agent: harness.createAgent({ timeoutMs: 12 * 60 * 1000 }),
    modelFor: (task) => modelFor(harness, task),
    provisioner,
    onProgress: (message) => console.log(message),
  });
  allResults.length = 0;
  allResults.push(...report.results);
  for (const failure of report.failed) failures.push({ harness: harness.id, ...failure });
  console.log(`\nverdict (${harness.id}): ${JSON.stringify(report.verdict, null, 2)}`);
}

// One verdict per harness, never pooled. `decide` refuses a mixed set outright,
// so this cannot silently become an average.
const verdicts = decideByHarness(allResults);
await writeFile(
  path.join(outDir, "verdict.json"),
  `${JSON.stringify({ repoRoot, before, dropped, verdicts, failures }, null, 2)}\n`,
  "utf8",
);

if (failures.length > 0) {
  console.log(`\n${failures.length} arm(s) failed:`);
  for (const failure of failures) console.log(`  ${failure.harness} ${failure.taskId}: ${failure.reason}`);
}
if (provisioner.leftovers.length > 0) {
  console.log(`\nregistry entries not released: ${provisioner.leftovers.join(", ")}`);
}
