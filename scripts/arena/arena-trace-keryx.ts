// Walk a keryx-shell events transcript and print the agent's path through the task:
// each tool call (name + compact input), result size, clipping, which gold paths it
// surfaced, and the turn's end. Usage: bun trace-keryx.ts <events.jsonl> <gold,gold,...>
import { readFileSync } from "node:fs";

const [file, goldArg = ""] = process.argv.slice(2);
if (file === undefined) throw new Error("usage: trace-keryx.ts <events.jsonl> <gold,...>");
const gold = goldArg.split(",").filter(Boolean);
const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);

const types: Record<string, number> = {};
const toolCount: Record<string, number> = {};
const seenGold = new Map<string, number>();
let step = 0;
let usage = 0;
const short = (s: string, n = 150) => s.replace(/\s+/g, " ").slice(0, n);

for (const line of lines) {
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  const t = String(e.type ?? "?");
  types[t] = (types[t] ?? 0) + 1;
  if (t === "turn_start") {
    const tools = Array.isArray(e.tools) ? (e.tools as string[]) : [];
    console.log(`turn_start: ${tools.length} tools: ${tools.join(",")}`);
  }
  if (t === "usage") usage += 1;
  if (t === "tool_call") {
    step += 1;
    const name = String(e.name ?? e.tool ?? "?");
    toolCount[name] = (toolCount[name] ?? 0) + 1;
    console.log(`#${String(step).padStart(3)} [r${usage}] ${name} ${short(String(e.input ?? ""))}`);
  }
  if (t === "tool_result") {
    const out = String(e.output ?? "");
    const hits = gold.filter((g) => out.includes(g));
    for (const g of hits) if (!seenGold.has(g)) seenGold.set(g, step);
    const clipped = /truncated|chars\]$/.test(out) ? " CLIPPED" : "";
    const err = e.isError === true ? " ERROR" : "";
    console.log(`      -> ${out.length}B${clipped}${err}${hits.length ? " GOLD:" + hits.map((h) => h.split("/").pop()).join(",") : ""} | ${short(out, 110)}`);
  }
  if (t === "assistant") {
    const txt = String(e.text ?? e.content ?? "");
    if (txt.trim()) console.log(`   say: ${short(txt, 200)}`);
  }
  if (t === "turn_end") {
    console.log(`turn_end: toolCalls=${String(e.toolCalls)} reason=${String(e.reason ?? e.stopReason ?? e.terminal ?? "-")} error=${String(e.errorMessage ?? "-")}`);
    console.log(`final text: ${short(String(e.text ?? ""), 600)}`);
  }
}
console.log("\nevent types:", JSON.stringify(types));
console.log("provider calls (rounds):", usage);
console.log("tools used:", JSON.stringify(Object.entries(toolCount).sort((a, b) => b[1] - a[1])));
console.log("gold first seen at step:", JSON.stringify(Object.fromEntries(seenGold)));
console.log("gold never seen:", JSON.stringify(gold.filter((g) => !seenGold.has(g))));
