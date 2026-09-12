// The batch2 breakdown: one row per (harness, task), context arm against control,
// de-duplicated by (harness, task, arm) — a resumed run re-ran one arm (K-017).
import { readFileSync } from "node:fs";

const OUT = process.argv[2] ?? "/tmp/arena-batch2";
type Row = { taskId: string; harness: string; arm: string; score?: any; toolCalls: number; contextTokens: number; costUsd: number | null; wallClockMs: number };

const seen = new Set<string>();
const rows: Row[] = [];
for (const line of readFileSync(`${OUT}/results.jsonl`, "utf8").trim().split("\n")) {
  const r = JSON.parse(line) as Row;
  const key = `${r.harness}|${r.taskId}|${r.arm}`;
  if (seen.has(key)) continue; // K-017: keep the first row for an arm
  seen.add(key);
  rows.push(r);
}
let failures: any[] = [];
try {
  failures = readFileSync(`${OUT}/failures.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
} catch {}

const recall = (r?: Row): number | undefined => r?.score?.retrieval?.recall;
const gold = (r?: Row): number => (r?.score?.retrieval?.matched?.length ?? 0) + (r?.score?.retrieval?.missed?.length ?? 0);
const found = (r?: Row): number => r?.score?.retrieval?.matched?.length ?? 0;

for (const harness of [...new Set(rows.map((r) => r.harness))]) {
  const tasks = [...new Set(rows.filter((r) => r.harness === harness).map((r) => r.taskId))];
  console.log(`\n=== ${harness} ===`);
  let onFound = 0, offFound = 0, onGold = 0, offGold = 0, onTok = 0, offTok = 0, onCost = 0, offCost = 0, onCalls = 0, offCalls = 0, pairs = 0;
  for (const task of tasks) {
    const on = rows.find((r) => r.harness === harness && r.taskId === task && r.arm === "context-on");
    const off = rows.find((r) => r.harness === harness && r.taskId === task && r.arm === "context-off");
    const cell = (r?: Row) => (r === undefined ? "—" : `${found(r)}/${gold(r)} ${Math.round(r.contextTokens / 1000)}k ${r.toolCalls}c ${Math.round(r.wallClockMs / 1000)}s`);
    console.log(`${task.padEnd(14)} on: ${cell(on).padEnd(26)} off: ${cell(off)}`);
    if (on && off) {
      pairs++;
      onFound += found(on); offFound += found(off); onGold += gold(on); offGold += gold(off);
      onTok += on.contextTokens; offTok += off.contextTokens;
      onCost += on.costUsd ?? 0; offCost += off.costUsd ?? 0;
      onCalls += on.toolCalls; offCalls += off.toolCalls;
    }
  }
  console.log(`paired tasks: ${pairs}`);
  console.log(`recall   with context ${onFound}/${onGold} (${(onFound / Math.max(onGold, 1)).toFixed(2)})   without ${offFound}/${offGold} (${(offFound / Math.max(offGold, 1)).toFixed(2)})`);
  console.log(`tokens   with context ${(onTok / 1e6).toFixed(2)}M   without ${(offTok / 1e6).toFixed(2)}M   ratio ${(onTok / Math.max(offTok, 1)).toFixed(2)}`);
  console.log(`calls    with context ${onCalls}   without ${offCalls}`);
  if (onCost || offCost) console.log(`cost     with context $${onCost.toFixed(2)}   without $${offCost.toFixed(2)}`);
}

console.log(`\nrefused/failed arms: ${failures.length}`);
for (const f of failures) console.log(`  ${f.taskId} ${f.harness} ${f.arm}: ${String(f.reason ?? f.error ?? "").slice(0, 90)}`);
