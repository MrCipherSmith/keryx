// Flow 309, W1 Lane C — `keryx skills scout|eval|stocktake`, the three
// governance gates (W1's "Governance gates: scout, eval, stocktake"
// section). A separate module, dispatched from `src/commands/skills.ts` with
// a small hook, because Lane B (install/doctor/uninstall) edits that same
// file concurrently — see the flow dispatch's shared-file note.

import path from "node:path";
import { loadSkillCatalog, type CatalogScope } from "../gdskills/governance/catalog-index";
import { EvalContractError, evalSkill } from "../gdskills/governance/eval";
import { recordScout, scoutImports, scoutSkill, scoutVetCandidate } from "../gdskills/governance/scout";
import { runStocktake } from "../gdskills/governance/stocktake";

function optionValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function parseScope(args: readonly string[]): CatalogScope {
  return optionValue(args, "--scope") === "all" ? "all" : "bundled";
}

export async function skillsGovernanceCommand(args: readonly string[]): Promise<void> {
  const command = args[0];
  const rest = args.slice(1);
  if (command === "scout") {
    await scoutCommand(rest);
    return;
  }
  if (command === "eval") {
    await evalCommand(rest);
    return;
  }
  if (command === "stocktake") {
    await stocktakeCommand(rest);
    return;
  }
  console.error(`Unknown skills governance command: ${String(command)}`);
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// scout
// ---------------------------------------------------------------------------

async function scoutCommand(args: readonly string[]): Promise<void> {
  const queryWords: string[] = [];
  let record: string | undefined;
  let candidate: string | undefined;
  let includeImports = false;
  const json = args.includes("--json");
  const scope = parseScope(args);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--record") {
      record = args[++i];
      continue;
    }
    if (arg === "--candidate") {
      candidate = args[++i];
      continue;
    }
    if (arg === "--scope") {
      i += 1; // value already consumed by parseScope
      continue;
    }
    if (arg === "--include-imports") {
      includeImports = true;
      continue;
    }
    if (arg === "--json") continue;
    queryWords.push(arg);
  }

  const query = queryWords.join(" ");
  if (query.length === 0) {
    console.error("Usage: keryx skills scout <name-or-description> [--record <pack-dir>] [--include-imports] [--candidate <dir>] [--scope bundled|all] [--json]");
    process.exitCode = 1;
    return;
  }

  const root = process.cwd();
  const catalog = loadSkillCatalog(root, { scope });
  const result = scoutSkill(query, catalog);
  const imports = includeImports ? scoutImports() : undefined;
  const vetting = candidate !== undefined ? await scoutVetCandidate(path.resolve(root, candidate)) : undefined;

  if (record !== undefined) {
    const packDir = path.resolve(root, record);
    recordScout(packDir, {
      query,
      decision: result.decision,
      topMatch: result.matches[0]?.skillId ?? null,
      recordedAt: new Date().toISOString(),
      skillName: path.basename(packDir),
    });
  }

  const output = {
    ...result,
    ...(imports !== undefined ? { imports } : {}),
    ...(vetting !== undefined ? { vetting } : {}),
  };

  if (json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(`Query: ${result.query}`);
  console.log(`Decision: ${result.decision}`);
  console.log(`Thresholds: use >= ${result.thresholds.use}, fork >= ${result.thresholds.fork}`);
  if (result.matches.length === 0) {
    console.log("No matches.");
  } else {
    console.log("Matches:");
    for (const match of result.matches) {
      console.log(`  ${match.skillId}  score=${match.overlapScore.toFixed(2)}  ${match.reason}`);
    }
  }
  if (imports !== undefined) {
    console.log(`Imports searched: ${imports.searched} (${imports.reason})`);
  }
  if (vetting !== undefined) {
    console.log(
      vetting.available
        ? `Candidate vetting: ${vetting.summary?.findings ?? 0} finding(s)`
        : `Candidate vetting unavailable: ${vetting.reason}`,
    );
  }
  if (record !== undefined) {
    console.log(`Recorded to ${path.join(path.resolve(root, record), "governance", "scout.json")}`);
  }
}

// ---------------------------------------------------------------------------
// eval
// ---------------------------------------------------------------------------

function isStrictness(value: string | undefined): value is "low" | "medium" | "high" {
  return value === "low" || value === "medium" || value === "high";
}

async function evalCommand(args: readonly string[]): Promise<void> {
  const skillId = args[0];
  if (skillId === undefined || skillId.startsWith("--")) {
    console.error("Usage: keryx skills eval <skill-id> [--strictness low|medium|high] [--trials N] [--runner <provider>] [--model-grader] [--json]");
    process.exitCode = 1;
    return;
  }

  const strictnessArg = optionValue(args, "--strictness");
  const strictness = isStrictness(strictnessArg) ? strictnessArg : "low";
  const trialsArg = optionValue(args, "--trials");
  const trials = trialsArg !== undefined ? Number(trialsArg) : 3;
  const modelGrader = args.includes("--model-grader");
  const json = args.includes("--json");
  const runnerName = optionValue(args, "--runner");

  if (runnerName !== undefined) {
    console.error(
      `--runner ${runnerName}: no runner capability is wired into this CLI yet (W3/Wave-4); behavior scenarios will report not-run.`,
    );
  }

  const root = process.cwd();
  const catalog = loadSkillCatalog(root, { scope: "all" });

  try {
    const report = await evalSkill(skillId, catalog, { strictness, trials, modelGrader });
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Skill: ${report.skillId}`);
      console.log(`Verdict: ${report.verdict}`);
      console.log(
        `Trigger accuracy: TP=${report.triggerAccuracy.truePositive}/${report.triggerAccuracy.positives}  FP=${report.triggerAccuracy.falsePositive}/${report.triggerAccuracy.negatives}`,
      );
      for (const scenario of report.scenarios) {
        console.log(`  [${scenario.kind}] ${scenario.id}  status=${scenario.status}  passRate=${scenario.passRate.toFixed(2)}`);
      }
    }
    process.exitCode = report.verdict === "fail" ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof EvalContractError ? 1 : 1;
  }
}

// ---------------------------------------------------------------------------
// stocktake
// ---------------------------------------------------------------------------

async function stocktakeCommand(args: readonly string[]): Promise<void> {
  const scope = parseScope(args);
  const quick = args.includes("--quick");
  const json = args.includes("--json");
  const root = process.cwd();

  const report = runStocktake(root, { scope, quick });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const counts: Record<string, number> = {};
  for (const entry of report.entries) {
    counts[entry.verdict] = (counts[entry.verdict] ?? 0) + 1;
  }
  console.log(`Stocktake (${report.scope}${quick ? ", quick" : ""}): ${report.entries.length} skill(s)`);
  for (const [verdict, count] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${verdict}: ${count}`);
  }
  console.log(`Cache: ${report.cache.hits} hit(s), ${report.cache.misses} miss(es)`);
}
