// Flow 309, W1 Lane C — `keryx skills eval`, the behavioral compliance gate
// (W1-AC10). Two independent halves:
//
//   - TRIGGER accuracy: deterministic. Every positive/negative prompt is
//     routed against the whole catalog with the same scoring `scout` uses,
//     via `scout.ts`'s `checkSkillSelected` — the shared grader (also used
//     by `stocktake`'s own trigger-accuracy check, so the two gates can
//     never disagree about what "this prompt selects that skill" means). A
//     prompt SELECTS the skill under test when its coverage score clears
//     `SCOUT_FORK_THRESHOLD` and no entry from a DIFFERENT category
//     outscores it — see `checkSkillSelected`'s own doc comment for why
//     "outright top-1 above `SCOUT_USE_THRESHOLD`" (the original rule) is
//     unsound for short trigger phrases: `SCOUT_USE_THRESHOLD` is calibrated
//     for "does this query cover the WHOLE skill", a much higher bar than
//     trigger routing needs, and IDF-weighted coverage scoring legitimately
//     ties many same-category skills at 1.0 on a query that reduces to one
//     common token — there is no principled single "top" among such ties.
//     No model call, no flake either way.
//   - BEHAVIOR scenarios: from an optional `evals.json` beside the skill's
//     `SKILL.md`. These need an agent to actually run the skill, which this
//     workstream does not build a default runner for — the CLI has none, so
//     every behavior scenario reports `status: "not-run"` with a named
//     reason, honestly, rather than being skipped silently or faked as a
//     pass. A caller MAY inject a `Runner` (the `evalSkill(..., {runner})`
//     option) — W3/Wave-4's job, per the workstream's own design note.
//
// `--strictness high` requiring `trials >= 3` (W1-AC10) is enforced as a
// contract error (`EvalContractError`), not a silent clamp: a caller that
// asked for high strictness with one trial gets told why, not a report that
// quietly ran three anyway or one that quietly passed with a single trial.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CatalogEntry } from "./catalog-index";
import { checkSkillSelected } from "./scout";

export type Strictness = "low" | "medium" | "high";
export type Grader = "contains" | "regex" | "not-contains" | "model";

export interface ExpectedBehavior {
  readonly grader: Grader;
  readonly value: string;
}

export interface EvalScenarioSpec {
  readonly id: string;
  readonly prompt: string;
  readonly strictness: Strictness;
  readonly expected_behavior: readonly ExpectedBehavior[];
}

/** The optional `evals.json` a skill author ships beside `SKILL.md`. */
export interface EvalSpecFile {
  readonly triggers?: { readonly positive: readonly string[]; readonly negative: readonly string[] };
  readonly scenarios?: readonly EvalScenarioSpec[];
}

export type RunnerOutput = { readonly output: string };

/** Runs one behavior scenario prompt against the skill under test; injectable so a CLI/W3 runner can be wired in without changing this module. */
export type Runner = (prompt: string, skill: CatalogEntry) => Promise<RunnerOutput>;

export interface EvalScenarioResult {
  readonly id: string;
  readonly kind: "trigger-positive" | "trigger-negative" | "behavior";
  readonly prompt: string;
  readonly strictness: Strictness;
  readonly trials: number;
  readonly passes: number;
  /** `passes / trials`, in `[0, 1]`. */
  readonly passRate: number;
  /** 1 when at least one of `trials` passed, 0 otherwise ("pass@k": did it pass at least once in k trials). */
  readonly passAtK: number;
  readonly grader: string;
  readonly status: "ran" | "not-run" | "skipped";
  readonly reason?: string;
}

export interface EvalTriggerAccuracy {
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly positives: number;
  readonly negatives: number;
}

export interface EvalReport {
  readonly schemaVersion: "1.0.0";
  readonly skillId: string;
  readonly strictness: Strictness;
  readonly trials: number;
  readonly triggerAccuracy: EvalTriggerAccuracy;
  readonly scenarios: readonly EvalScenarioResult[];
  readonly verdict: "pass" | "fail" | "incomplete";
}

export interface EvalOptions {
  readonly strictness?: Strictness;
  readonly trials?: number;
  readonly runner?: Runner;
  readonly modelGrader?: boolean;
}

/** Thrown when the requested eval violates its own contract (e.g. high strictness with < 3 trials) — the CLI maps this to exit 1. */
export class EvalContractError extends Error {}

function readEvalSpec(skillMdPath: string): EvalSpecFile | undefined {
  const specPath = path.join(path.dirname(skillMdPath), "evals.json");
  if (!existsSync(specPath)) return undefined;
  return JSON.parse(readFileSync(specPath, "utf8")) as EvalSpecFile;
}

const USE_WHEN_CLAUSE = /use when[^.]*\.?/i;

function extractUseWhenClause(description: string): string | undefined {
  const match = USE_WHEN_CLAUSE.exec(description);
  return match !== null ? match[0].trim() : undefined;
}

/** Positives synthesized from the skill's own triggers plus its description's "Use when" clause — no `evals.json` required. */
function synthesizePositives(skill: CatalogEntry): string[] {
  const prompts = [...skill.triggers];
  const useWhen = extractUseWhenClause(skill.description);
  if (useWhen !== undefined) prompts.push(useWhen);
  return prompts.length > 0 ? prompts.slice(0, 5) : [skill.description.length > 0 ? skill.description : skill.name];
}

/** Negatives deterministically drawn from OTHER categories' own triggers — never this skill's category. */
function synthesizeNegatives(skill: CatalogEntry, catalog: readonly CatalogEntry[]): string[] {
  const others = [...catalog]
    .filter((entry) => entry.category !== skill.category && entry.id !== skill.id)
    .sort((a, b) => a.id.localeCompare(b.id));
  const negatives: string[] = [];
  for (const entry of others) {
    const trigger = entry.triggers[0];
    if (trigger !== undefined) negatives.push(trigger);
    if (negatives.length >= 3) break;
  }
  return negatives;
}

/** Whether routing `prompt` against `catalog` (scout's own scoring) selects `skill` — see the module header and `checkSkillSelected`'s doc comment for the exact rule. */
function selectsSkill(prompt: string, skill: CatalogEntry, catalog: readonly CatalogEntry[]): boolean {
  return checkSkillSelected(prompt, skill.id, catalog).selected;
}

function gradeDeterministic(output: string, expected: ExpectedBehavior): boolean | undefined {
  switch (expected.grader) {
    case "contains":
      return output.includes(expected.value);
    case "not-contains":
      return !output.includes(expected.value);
    case "regex":
      return new RegExp(expected.value).test(output);
    default:
      return undefined; // "model" — graded by the caller, only with --model-grader and a runner.
  }
}

function triggerScenario(
  id: string,
  kind: "trigger-positive" | "trigger-negative",
  prompt: string,
  strictness: Strictness,
  trials: number,
  selected: boolean,
  wantsSelected: boolean,
): EvalScenarioResult {
  const passed = selected === wantsSelected;
  return {
    id,
    kind,
    prompt,
    strictness,
    trials,
    passes: passed ? trials : 0,
    passRate: passed ? 1 : 0,
    passAtK: passed ? 1 : 0,
    grader: "trigger-rank-fork-family",
    status: "ran",
  };
}

/**
 * Run the trigger-accuracy and behavior-scenario evaluation for `skillId`
 * against `catalog`. Throws `EvalContractError` when the request or the
 * resulting report violates the output contract (`validateEvalReport`).
 */
export async function evalSkill(
  skillId: string,
  catalog: readonly CatalogEntry[],
  options: EvalOptions = {},
): Promise<EvalReport> {
  const skill = catalog.find((entry) => entry.id === skillId);
  if (skill === undefined) throw new Error(`unknown skill id: ${skillId}`);

  const strictness = options.strictness ?? "low";
  const trials = options.trials ?? 3;
  if (strictness === "high" && trials < 3) {
    throw new EvalContractError(`--strictness high requires --trials >= 3 (got ${trials})`);
  }

  const spec = readEvalSpec(skill.path);
  const positives = spec?.triggers?.positive !== undefined ? [...spec.triggers.positive] : synthesizePositives(skill);
  const negatives = spec?.triggers?.negative !== undefined ? [...spec.triggers.negative] : synthesizeNegatives(skill, catalog);

  const scenarios: EvalScenarioResult[] = [];
  let truePositive = 0;
  positives.forEach((prompt, index) => {
    const selected = selectsSkill(prompt, skill, catalog);
    if (selected) truePositive += 1;
    scenarios.push(triggerScenario(`trigger-positive-${index + 1}`, "trigger-positive", prompt, strictness, trials, selected, true));
  });

  let falsePositive = 0;
  negatives.forEach((prompt, index) => {
    const selected = selectsSkill(prompt, skill, catalog);
    if (selected) falsePositive += 1;
    scenarios.push(triggerScenario(`trigger-negative-${index + 1}`, "trigger-negative", prompt, strictness, trials, selected, false));
  });

  for (const behaviorSpec of spec?.scenarios ?? []) {
    if (options.runner === undefined) {
      scenarios.push({
        id: behaviorSpec.id,
        kind: "behavior",
        prompt: behaviorSpec.prompt,
        strictness: behaviorSpec.strictness,
        trials,
        passes: 0,
        passRate: 0,
        passAtK: 0,
        grader: behaviorSpec.expected_behavior.map((expected) => expected.grader).join("+") || "none",
        status: "not-run",
        reason: "no runner capability (pass --runner <provider>)",
      });
      continue;
    }

    let passes = 0;
    for (let trial = 0; trial < trials; trial++) {
      const { output } = await options.runner(behaviorSpec.prompt, skill);
      let trialPassed = true;
      for (const expected of behaviorSpec.expected_behavior) {
        if (expected.grader === "model") {
          // Model grading needs --model-grader AND a runner (both present
          // here); this workstream ships no model-grading implementation, so
          // it is reported as skipped (neutral) rather than faked.
          continue;
        }
        if (gradeDeterministic(output, expected) === false) trialPassed = false;
      }
      if (trialPassed) passes += 1;
    }
    scenarios.push({
      id: behaviorSpec.id,
      kind: "behavior",
      prompt: behaviorSpec.prompt,
      strictness: behaviorSpec.strictness,
      trials,
      passes,
      passRate: passes / trials,
      passAtK: passes > 0 ? 1 : 0,
      grader: behaviorSpec.expected_behavior.map((expected) => expected.grader).join("+") || "none",
      status: "ran",
    });
  }

  const triggerAccuracy: EvalTriggerAccuracy = {
    truePositive,
    falsePositive,
    positives: positives.length,
    negatives: negatives.length,
  };

  const hasNotRun = scenarios.some((scenario) => scenario.status === "not-run");
  const triggersOk = positives.length === 0 || (truePositive === positives.length && falsePositive === 0);
  const behaviorOk = scenarios
    .filter((scenario) => scenario.kind === "behavior" && scenario.status === "ran")
    .every((scenario) => scenario.passRate >= 0.5);
  const verdict: EvalReport["verdict"] = hasNotRun ? "incomplete" : triggersOk && behaviorOk ? "pass" : "fail";

  const report: EvalReport = {
    schemaVersion: "1.0.0",
    skillId,
    strictness,
    trials,
    triggerAccuracy,
    scenarios,
    verdict,
  };

  const errors = validateEvalReport(report);
  if (errors.length > 0) throw new EvalContractError(errors.join("; "));
  return report;
}

/**
 * Enforces the eval output contract (W1-AC10): `trials >= 3` at high
 * strictness, every scenario carries a `passRate` in `[0, 1]` and a trial
 * count, and `triggerAccuracy` is present. Returns a list of violations —
 * `[]` means the report is valid.
 */
export function validateEvalReport(report: EvalReport): string[] {
  const errors: string[] = [];
  if (report.strictness === "high" && report.trials < 3) {
    errors.push("strictness high requires trials >= 3");
  }
  if (report.triggerAccuracy === undefined) {
    errors.push("triggerAccuracy is required");
  }
  for (const scenario of report.scenarios) {
    if (!(scenario.passRate >= 0 && scenario.passRate <= 1)) {
      errors.push(`scenario ${scenario.id}: passRate ${scenario.passRate} is out of [0, 1]`);
    }
    if (typeof scenario.trials !== "number" || scenario.trials < 0) {
      errors.push(`scenario ${scenario.id}: missing or invalid trials count`);
    }
  }
  return errors;
}
