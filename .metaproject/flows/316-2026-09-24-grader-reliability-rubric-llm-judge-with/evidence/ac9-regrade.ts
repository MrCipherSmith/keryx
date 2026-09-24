// Flow 316 AC9: re-grade the REAL recorded DeepSeek outputs (honest gate run,
// f316/gate/) of the three suppression scenarios that scored 0 in flow 314,
// under the PRE-migration expectations (git show 8c7e50da:<evals.json>).
// Reports, per trial: which old expectations fail, whether the output mentions the
// forbidden token, and the judge verdict from the new run.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gradeDeterministic } from "../../../../src/gdskills/governance/eval";

const ROOT = process.cwd();
// GATE: the directory holding the raw `skills eval --json` outputs of the honest run
// (one <pack>_<skill>.json per skill); pass it as the first argument.
const GATE = process.argv[2] ?? "./gate";
const CASES = [
  { pack: "ts-js-node", skill: "nodejs-build-fix", id: "no-ts-ignore-suppression" },
  { pack: "react", skill: "react-build-fix", id: "no-disable-hooks-lint" },
  { pack: "python", skill: "python-build-fix", id: "mypy-error-no-blanket-suppress" },
];
for (const c of CASES) {
  const old = JSON.parse(execSync(`git -C ${ROOT} show 8c7e50da:src/gdskills/bundled/stacks/${c.pack}/skills/${c.skill}/evals.json`, { encoding: "utf8" }));
  const oldScenario = old.scenarios.find((s: any) => s.id === c.id);
  const report = JSON.parse(readFileSync(`${GATE}/${c.pack}_${c.skill}.json`, "utf8"));
  const scenario = report.scenarios.find((s: any) => s.id === c.id);
  console.log(`\n## ${c.pack}/${c.skill}#${c.id}  new judge result ${scenario.passes}/${scenario.trials}`);
  console.log(`old expectations: ${JSON.stringify(oldScenario.expected_behavior)}`);
  let oldPasses = 0;
  scenario.trialRecords.forEach((t: any, i: number) => {
    const results = oldScenario.expected_behavior.map((e: any) => ({ e: `${e.grader}:${e.value.slice(0, 40)}`, ok: gradeDeterministic(t.output, e) === true }));
    const oldPass = results.every((r: any) => r.ok);
    if (oldPass) oldPasses++;
    const failing = results.filter((r: any) => !r.ok).map((r: any) => r.e);
    const negTokens = oldScenario.expected_behavior.filter((e: any) => e.grader === "not-contains").map((e: any) => e.value);
    const mentions = negTokens.filter((tok: string) => t.output.includes(tok));
    // context of each mention, to show whether it is a warning or a recommendation
    const ctx = mentions.map((tok: string) => {
      const k = t.output.indexOf(tok);
      return `"...${t.output.slice(Math.max(0, k - 70), k + tok.length + 50).replace(/\s+/g, " ")}..."`;
    });
    console.log(`trial ${i + 1}: old=${oldPass ? "PASS" : "FAIL"} failing=[${failing.join(" | ")}] judge=${t.judge?.verdict} mentions=${JSON.stringify(mentions)}`);
    for (const x of ctx) console.log(`    ${x}`);
  });
  console.log(`old grader on these outputs: ${oldPasses}/${scenario.trials}`);
}
