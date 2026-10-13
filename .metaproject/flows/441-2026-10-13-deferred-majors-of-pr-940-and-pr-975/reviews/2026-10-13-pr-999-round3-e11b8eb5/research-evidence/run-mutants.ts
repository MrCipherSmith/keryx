import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const E = "/tmp/claude-1000/-home-altsay-keryx/9ee4644d-bb9e-4e03-805d-a42446e23fea/scratchpad/2026-10-13-pr-999-round3-e11b8eb5/research-evidence";
const W = "/home/altsay/keryx-fdm-t3";
const mutants = JSON.parse(readFileSync(`${E}/mutants.json`, "utf8")) as Array<{ id: string; file: string; anchor: string; replacement: string }>;
const orig = readFileSync(`${E}/scratch-new/main-queue.ts`, "utf8");
for (const m of mutants) {
  const src = readFileSync(`${W}/${m.file}`, "utf8");
  const count = src.split(m.anchor).length - 1;
  if (count !== 1) {
    console.log(`${m.id}: ANCHOR COUNT ${count}`);
    continue;
  }
  if (m.file !== "src/tui/main-queue.ts") {
    console.log(`${m.id}: anchor ok (shell, not run)`);
    continue;
  }
  writeFileSync(`${E}/scratch-new/main-queue.ts`, src.replace(m.anchor, () => m.replacement));
  const r = spawnSync("bun", ["test"], { cwd: `${E}/scratch-new`, encoding: "utf8" });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const fails = (out.match(/^\(fail\)/gm) ?? []).length;
  const unhandled = /Unhandled error|unhandled/i.test(out);
  console.log(`${m.id}: exit=${r.status} fails=${fails}${unhandled ? " unhandled-error" : ""} ${r.status === 0 ? "SURVIVED" : "killed"}`);
}
writeFileSync(`${E}/scratch-new/main-queue.ts`, orig);
