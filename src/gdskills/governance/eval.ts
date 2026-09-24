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
// That `trials >= 3` rule is about BEHAVIOR scenarios (genuinely repeatable,
// runner-based); trigger scenarios are one deterministic scoring call and
// always report `trials: 1, deterministic: true` (F11, flow 309 review
// round 1) — `validateEvalReport` enforces the high-strictness trial floor
// per behavior scenario, not against trigger scenarios.
//
// EVIDENCE (F5, flow 309 review round 1; scoring fixed R2-5, flow 309 review
// round 2): when a skill ships no `evals.json`, its trigger
// positives/negatives are SYNTHESIZED from its own triggers/description and
// from nearby catalog entries — useful as a smoke check, but not proof a
// human verified. A report is `evidence: "synthesized"` unless BOTH the
// positive and negative trigger sets came from an authored `evals.json`
// (with at least one prompt each — an authored-but-empty list falls back to
// synthesized rather than silently checking nothing, R2-4); a
// synthesized-only report can never carry verdict `"pass"` (only `"fail"` or
// `"incomplete"` — enforced by `validateEvalReport`).
//
// R2-5 (flow 309 review round 2): synthesized positives are scored with
// `checkSkillSelectedLeaveOneOut` (`scout.ts`) — `field: "full"` (the same
// scoring the real router uses, triggers included) but with the ONE trigger
// phrase a given positive was built from removed from the skill's OWN
// indexed text first, plus a `DESCRIPTION_SUPPORT_THRESHOLD` gate requiring
// the skill's description to independently support the prompt. The earlier
// fix (`field: "description-only"`, dropping `triggers` from the haystack
// entirely) stopped a synthesized prompt from trivially matching because it
// sits verbatim in what it's scored against, but at the cost of making
// `triggers` invisible to trigger scoring altogether, for authored prompts
// too — see `scout.ts`'s section comment above `checkSkillSelectedLeaveOneOut`
// for the full rationale and why leave-one-out alone still needs the
// description-support gate to reject a skill that borrows an entire trigger
// list. Authored prompts and synthesized NEGATIVES are scored with
// `field: "full"` directly (no exclusion needed — they are not built from
// the skill-under-test's own text). `stocktake.ts`'s own-trigger-routes-back
// check shares this exact grader for the same reason.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CatalogEntry } from "./catalog-index";
import { checkSkillSelected, checkSkillSelectedLeaveOneOut, nearestSkills } from "./scout";

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

/**
 * Grades one `"model"`-graded expectation against a runner's `output`.
 * Injectable (F10, flow 309 review round 1) — this workstream ships no
 * model-grading implementation of its own, so a caller MAY supply one (a
 * real LLM-judge call); when none is supplied, `evalSkill` reports every
 * scenario carrying a `"model"` expectation as `status: "skipped"`, never as
 * a silent pass.
 */
export type ModelGrader = (output: string, expected: ExpectedBehavior, skill: CatalogEntry) => Promise<boolean> | boolean;

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
  /** `true` for trigger scenarios (F11): one deterministic scoring call, never N repeated trials — see `triggerScenario`'s doc comment. Omitted (not `false`) for behavior scenarios, which are genuinely trial-repeatable. */
  readonly deterministic?: boolean;
}

export interface EvalTriggerAccuracy {
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly positives: number;
  readonly negatives: number;
}

/**
 * Where the trigger scenarios' positive/negative prompts came from (F5,
 * flow 309 review round 1). `"authored"`: every prompt came from the
 * skill's own `evals.json` (a human wrote it) — a `pass` verdict is real
 * evidence. `"synthesized"`: at least one side (positives or negatives) was
 * generated from the skill's own triggers/description/catalog neighbours,
 * with no human authorship — see `validateEvalReport`'s rule below: such a
 * report can never carry verdict `"pass"`, only `"fail"` or `"incomplete"`,
 * because a synthesized-only run is, at best, advisory.
 */
export type EvalEvidence = "authored" | "synthesized";

export interface EvalReport {
  readonly schemaVersion: "1.0.0";
  readonly skillId: string;
  readonly strictness: Strictness;
  readonly trials: number;
  readonly triggerAccuracy: EvalTriggerAccuracy;
  readonly evidence: EvalEvidence;
  readonly scenarios: readonly EvalScenarioResult[];
  readonly verdict: "pass" | "fail" | "incomplete";
}

export interface EvalOptions {
  readonly strictness?: Strictness;
  readonly trials?: number;
  readonly runner?: Runner;
  /** Whether model-graded expectations were REQUESTED (e.g. CLI `--model-grader`) — informational only; whether they can actually be graded depends on `modelGraderFn`. */
  readonly modelGrader?: boolean;
  /** The injectable grading capability itself (F10) — when absent, `"model"`-graded expectations are reported `status: "skipped"`, never counted as passed. */
  readonly modelGraderFn?: ModelGrader;
}

/** Thrown when the requested eval violates its own contract (e.g. high strictness with < 3 trials) — the CLI maps this to exit 1. */
export class EvalContractError extends Error {}

/**
 * R3-1 (flow 309 review round 3): thrown when a skill's own `evals.json` is
 * malformed — bad JSON, a wrong-shaped field, an unknown `grader`, an empty
 * `expected_behavior` list, or an invalid `regex` value. Before this fix,
 * `readEvalSpec` cast the parsed JSON straight to `EvalSpecFile` with no
 * validation at all: a scenario with a typo'd grader (`"regexp"` for
 * `"regex"`) or an empty `expected_behavior` array graded every trial as a
 * pass (`gradeDeterministic` returns `undefined` for an unknown grader, and
 * the trial loop only ever flipped `trialPassed` on `=== false` — so
 * `undefined` and "nothing to check" both silently counted as passing),
 * reporting a fabricated 100% pass that `validateEvalReport`/
 * `checkStablePackGate` had no way to catch (a genuinely `"ran"` scenario
 * with `passRate: 1`). Always names the offending file so the CLI/API
 * caller knows which `evals.json` to fix, never a raw `TypeError`/
 * `SyntaxError` (R3-6).
 */
export class EvalSpecError extends Error {}

const VALID_GRADERS: readonly Grader[] = ["contains", "regex", "not-contains", "model"];

function isValidRegexPattern(value: string): boolean {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * R3-1: a strict shape check over a parsed `evals.json`, run once on load —
 * `evalSkill`/`checkStablePackGate` must never reach a scenario whose
 * `expected_behavior` cannot actually be graded. Throws `EvalSpecError`
 * (naming `specPath`) for the first violation found; returns normally for a
 * well-formed (possibly `triggers`/`scenarios`-absent) spec.
 */
function validateEvalSpec(value: unknown, specPath: string): asserts value is EvalSpecFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EvalSpecError(`${specPath}: evals.json must be a JSON object`);
  }
  const spec = value as Record<string, unknown>;

  if (spec.triggers !== undefined) {
    if (typeof spec.triggers !== "object" || spec.triggers === null || Array.isArray(spec.triggers)) {
      throw new EvalSpecError(`${specPath}: "triggers" must be an object`);
    }
    const triggers = spec.triggers as Record<string, unknown>;
    for (const side of ["positive", "negative"] as const) {
      if (triggers[side] === undefined) continue;
      const list = triggers[side];
      if (!Array.isArray(list) || !list.every((prompt) => typeof prompt === "string")) {
        throw new EvalSpecError(`${specPath}: "triggers.${side}" must be an array of strings`);
      }
    }
  }

  if (spec.scenarios === undefined) return;
  if (!Array.isArray(spec.scenarios)) {
    throw new EvalSpecError(`${specPath}: "scenarios" must be an array`);
  }
  spec.scenarios.forEach((scenarioValue, index) => {
    if (typeof scenarioValue !== "object" || scenarioValue === null || Array.isArray(scenarioValue)) {
      throw new EvalSpecError(`${specPath}: scenarios[${index}] must be an object`);
    }
    const scenario = scenarioValue as Record<string, unknown>;
    const label = typeof scenario.id === "string" && scenario.id.length > 0 ? scenario.id : `scenarios[${index}]`;
    if (typeof scenario.id !== "string" || scenario.id.length === 0) {
      throw new EvalSpecError(`${specPath}: ${label} must have a non-empty "id"`);
    }
    if (typeof scenario.prompt !== "string" || scenario.prompt.length === 0) {
      throw new EvalSpecError(`${specPath}: scenario "${label}" must have a non-empty "prompt" string`);
    }
    if (!Array.isArray(scenario.expected_behavior) || scenario.expected_behavior.length === 0) {
      throw new EvalSpecError(`${specPath}: scenario "${label}" must have at least one "expected_behavior" entry`);
    }
    scenario.expected_behavior.forEach((expectedValue, expectedIndex) => {
      if (typeof expectedValue !== "object" || expectedValue === null || Array.isArray(expectedValue)) {
        throw new EvalSpecError(`${specPath}: scenario "${label}" expected_behavior[${expectedIndex}] must be an object`);
      }
      const expected = expectedValue as Record<string, unknown>;
      if (typeof expected.grader !== "string" || !VALID_GRADERS.includes(expected.grader as Grader)) {
        throw new EvalSpecError(
          `${specPath}: scenario "${label}" expected_behavior[${expectedIndex}] has an unknown grader ${JSON.stringify(expected.grader)} (must be one of ${VALID_GRADERS.join(", ")})`,
        );
      }
      if (typeof expected.value !== "string" || expected.value.length === 0) {
        throw new EvalSpecError(`${specPath}: scenario "${label}" expected_behavior[${expectedIndex}] must have a non-empty "value" string`);
      }
      if (expected.grader === "regex" && !isValidRegexPattern(expected.value)) {
        throw new EvalSpecError(`${specPath}: scenario "${label}" expected_behavior[${expectedIndex}] has an invalid regex value ${JSON.stringify(expected.value)}`);
      }
    });
  });
}

function readEvalSpec(skillMdPath: string): EvalSpecFile | undefined {
  const specPath = path.join(path.dirname(skillMdPath), "evals.json");
  if (!existsSync(specPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(specPath, "utf8"));
  } catch (error) {
    throw new EvalSpecError(`${specPath}: could not parse evals.json (${error instanceof Error ? error.message : String(error)})`);
  }
  validateEvalSpec(parsed, specPath);
  return parsed;
}

const USE_WHEN_CLAUSE = /use when[^.]*\.?/i;

function extractUseWhenClause(description: string): string | undefined {
  const match = USE_WHEN_CLAUSE.exec(description);
  return match !== null ? match[0].trim() : undefined;
}

/** A synthesized (not human-authored) trigger prompt. */
interface SynthesizedPositive {
  readonly prompt: string;
  /** The exact `skill.triggers` entry this prompt was built from, verbatim — leave-one-out (R2-5) excludes ONLY this phrase from the skill's own indexed text when scoring it. `undefined` for a prompt not built from a discrete trigger (the "Use when" clause, or the description/name fallback). */
  readonly sourceTrigger?: string;
}

/** Positives synthesized from the skill's own triggers plus its description's "Use when" clause — no `evals.json` required. */
function synthesizePositives(skill: CatalogEntry): SynthesizedPositive[] {
  const prompts: SynthesizedPositive[] = skill.triggers.map((trigger) => ({ prompt: trigger, sourceTrigger: trigger }));
  const useWhen = extractUseWhenClause(skill.description);
  if (useWhen !== undefined) prompts.push({ prompt: useWhen });
  if (prompts.length > 0) return prompts.slice(0, 5);
  return [{ prompt: skill.description.length > 0 ? skill.description : skill.name }];
}

/**
 * Negatives drawn from the NEAREST different-category neighbours (F5, flow
 * 309 review round 1) — deterministic (`nearestSkills` ties break by id).
 * Nearest-neighbour, not an arbitrary alphabetical pick from other
 * categories: a hard negative (a confusable, closely related skill) is the
 * one that actually exercises whether this skill's triggers avoid stealing
 * a query that legitimately belongs elsewhere. An easy negative (a random
 * unrelated skill) would pass trivially and prove nothing.
 */
function synthesizeNegatives(skill: CatalogEntry, catalog: readonly CatalogEntry[]): string[] {
  const neighbours = nearestSkills(skill.id, catalog, catalog.length).filter((match) => match.category !== skill.category);
  const negatives: string[] = [];
  for (const match of neighbours.slice(0, 3)) {
    const entry = catalog.find((candidate) => candidate.id === match.skillId);
    const trigger = entry?.triggers[0];
    negatives.push(trigger !== undefined ? trigger : (entry?.description ?? match.skillId));
  }
  return negatives;
}

/**
 * Whether routing `prompt` against `catalog` selects `skill` — `field: "full"`
 * (R2-5, flow 309 review round 2), the same scoring the real router uses.
 * For an AUTHORED prompt (human-written, or a synthesized negative drawn
 * from a DIFFERENT skill's triggers) there is no circularity to guard
 * against, so no exclusion is needed.
 */
function selectsSkillFull(prompt: string, skill: CatalogEntry, catalog: readonly CatalogEntry[]): boolean {
  return checkSkillSelected(prompt, skill.id, catalog, { field: "full" }).selected;
}

/**
 * Whether a SYNTHESIZED positive prompt selects `skill` — leave-one-out over
 * `field: "full"`, excluding `sourceTrigger` (when the prompt was built from
 * one of `skill.triggers` verbatim) from `skill`'s own indexed text before
 * scoring, plus the `DESCRIPTION_SUPPORT_THRESHOLD` gate. See `scout.ts`'s
 * section comment above `checkSkillSelectedLeaveOneOut` for the full R2-5
 * rationale (this replaces the old `field: "description-only"` scoring,
 * which made `triggers` invisible to trigger scoring entirely).
 */
function selectsSkillSynthesized(prompt: string, skill: CatalogEntry, catalog: readonly CatalogEntry[], sourceTrigger?: string): boolean {
  return checkSkillSelectedLeaveOneOut(prompt, skill.id, catalog, sourceTrigger).selected;
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

/**
 * F11 (flow 309 review round 1): a trigger scenario is graded by ONE
 * deterministic lexical-scoring call (`selectsSkill`, above) — there is no
 * second, third, ... trial to run, since the same query against the same
 * catalog always scores identically. Reporting `trials: <requested trial
 * count>` (e.g. 3) fabricated N separate runs that never happened. Trigger
 * scenarios always report `trials: 1, deterministic: true` regardless of
 * the caller's requested `--trials`, which applies to runner-based BEHAVIOR
 * scenarios only (the only kind that actually has repeatable, potentially
 * flaky trials) — `validateEvalReport`'s `trials >= 3` contract at
 * `--strictness high` is enforced per-scenario for behavior scenarios and
 * does not apply to this deterministic kind.
 */
function triggerScenario(
  id: string,
  kind: "trigger-positive" | "trigger-negative",
  prompt: string,
  strictness: Strictness,
  selected: boolean,
  wantsSelected: boolean,
): EvalScenarioResult {
  const passed = selected === wantsSelected;
  return {
    id,
    kind,
    prompt,
    strictness,
    trials: 1,
    passes: passed ? 1 : 0,
    passRate: passed ? 1 : 0,
    passAtK: passed ? 1 : 0,
    grader: "trigger-rank-fork-family",
    status: "ran",
    deterministic: true,
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
  // R2-4 (flow 309 review round 2): an authored `evals.json` with an EMPTY
  // `triggers.positive`/`negative` array used to still count as "authored"
  // (only `!== undefined` was checked) and then vacuously satisfy the
  // trigger-accuracy check below (0 prompts checked, 0 false positives) — a
  // report that checked NOTHING could still claim `evidence: "authored"`
  // and `verdict: "pass"`. Authorship now requires at least one prompt on
  // that side; an empty authored list falls back to synthesized rather than
  // silently checking nothing.
  const positivesAuthored = (spec?.triggers?.positive?.length ?? 0) > 0;
  const negativesAuthored = (spec?.triggers?.negative?.length ?? 0) > 0;
  const positives: SynthesizedPositive[] = positivesAuthored
    ? (spec?.triggers?.positive ?? []).map((prompt) => ({ prompt }))
    : synthesizePositives(skill);
  const negatives = negativesAuthored ? [...(spec?.triggers?.negative ?? [])] : synthesizeNegatives(skill, catalog);
  // F5: a report built ONLY from synthesized (not authored) trigger prompts
  // is advisory, not proof — see `validateEvalReport` for the rule this
  // drives (`"synthesized"` evidence can never carry verdict `"pass"`).
  const evidence: EvalEvidence = positivesAuthored && negativesAuthored ? "authored" : "synthesized";

  const scenarios: EvalScenarioResult[] = [];
  let truePositive = 0;
  positives.forEach((positive, index) => {
    const selected = positivesAuthored
      ? selectsSkillFull(positive.prompt, skill, catalog)
      : selectsSkillSynthesized(positive.prompt, skill, catalog, positive.sourceTrigger);
    if (selected) truePositive += 1;
    scenarios.push(triggerScenario(`trigger-positive-${index + 1}`, "trigger-positive", positive.prompt, strictness, selected, true));
  });

  let falsePositive = 0;
  negatives.forEach((prompt, index) => {
    const selected = selectsSkillFull(prompt, skill, catalog);
    if (selected) falsePositive += 1;
    scenarios.push(triggerScenario(`trigger-negative-${index + 1}`, "trigger-negative", prompt, strictness, selected, false));
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

    // F10: an expectation graded `"model"` needs an actual grading
    // capability (`options.modelGraderFn`) to be a real result. Without one,
    // the WHOLE scenario is reported `status: "skipped"` (never `"ran"` with
    // a fabricated pass) — it used to `continue` past every model
    // expectation inside the trial loop, silently treating "not checked" as
    // "checked and fine", so a scenario whose ENTIRE expectation set was
    // model-graded always reported `trialPassed = true` with nothing ever
    // verified.
    const hasModelExpectation = behaviorSpec.expected_behavior.some((expected) => expected.grader === "model");
    if (hasModelExpectation && options.modelGraderFn === undefined) {
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
        status: "skipped",
        reason: "model-graded expectation with no model grader capability (pass --model-grader with a grader implementation)",
      });
      continue;
    }

    let passes = 0;
    for (let trial = 0; trial < trials; trial++) {
      const { output } = await options.runner(behaviorSpec.prompt, skill);
      let trialPassed = true;
      for (const expected of behaviorSpec.expected_behavior) {
        if (expected.grader === "model") {
          // `options.modelGraderFn` is guaranteed defined here (checked above).
          const graded = await (options.modelGraderFn as ModelGrader)(output, expected, skill);
          if (!graded) trialPassed = false;
          continue;
        }
        // R3-1 (defense in depth): treat anything other than a genuine
        // `true` as a failure — `readEvalSpec`'s validation already refuses
        // an unknown grader before this ever runs, but a scenario reaching
        // this loop by some other path (a caller building an `EvalReport`
        // by hand, a future spec source) must not have `gradeDeterministic`
        // returning `undefined` for a non-"model" grader silently read as
        // "nothing to check, so it passed".
        if (gradeDeterministic(output, expected) !== true) trialPassed = false;
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

  // R2-4: a `"skipped"` scenario (a model-graded expectation with no model
  // grader capability) used to count as "ran" for verdict purposes — nothing
  // was actually checked, yet `behaviorOk` only ever looked at `"ran"`
  // scenarios, so a behavior scenario whose ENTIRE expectation set was
  // model-graded and unchecked left `behaviorOk` vacuously true and the
  // verdict could still be `"pass"`. `hasNotRun` now covers both "not
  // actually evaluated" statuses.
  const hasNotRun = scenarios.some((scenario) => scenario.status === "not-run" || scenario.status === "skipped");
  // R2-4: `positives.length === 0` (and, symmetrically, `negatives.length ===
  // 0`) used to make `triggersOk` vacuously true — a report that checked ZERO
  // trigger prompts could still satisfy "every positive selected, no false
  // positives" by construction. Both sides must actually carry at least one
  // checked prompt.
  const triggersOk = positives.length > 0 && negatives.length > 0 && truePositive === positives.length && falsePositive === 0;
  const behaviorOk = scenarios
    .filter((scenario) => scenario.kind === "behavior" && scenario.status === "ran")
    .every((scenario) => scenario.passRate >= 0.5);
  const wouldPass = triggersOk && behaviorOk;
  // F5: synthesized-only evidence is never allowed to report "pass" — the
  // best it can claim is "incomplete" (advisory: looked fine, but nothing
  // here was authored/verified by a human). A genuine failure still reports
  // "fail" either way — evidence quality softens a pass, never a fail.
  const verdict: EvalReport["verdict"] = hasNotRun
    ? "incomplete"
    : wouldPass
      ? evidence === "synthesized"
        ? "incomplete"
        : "pass"
      : "fail";

  const report: EvalReport = {
    schemaVersion: "1.0.0",
    skillId,
    strictness,
    trials,
    triggerAccuracy,
    evidence,
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
  if (report.evidence !== "authored" && report.evidence !== "synthesized") {
    errors.push("evidence must be 'authored' or 'synthesized'");
  }
  // F5: a synthesized-only report is advisory evidence at best — it must
  // never claim "pass" (see `evalSkill`'s verdict derivation).
  if (report.evidence === "synthesized" && report.verdict === "pass") {
    errors.push("a synthesized-only report must not report verdict 'pass' (use 'incomplete')");
  }

  // R2-6 (flow 309 review round 2): a hand-edited or otherwise malformed
  // `eval.json` missing `triggerAccuracy` or carrying a non-array
  // `scenarios` used to log "triggerAccuracy is required" and then
  // DEREFERENCE `report.triggerAccuracy.positives` two lines later anyway,
  // throwing a TypeError instead of returning the error list —
  // `checkStablePackGate` then threw instead of reporting `"fail"`. Both
  // shapes are checked and, when either is missing, the rest of this
  // function (which assumes both exist) is skipped rather than crashing.
  if (report.triggerAccuracy === undefined) {
    errors.push("triggerAccuracy is required");
  }
  if (!Array.isArray(report.scenarios)) {
    errors.push("scenarios must be an array");
  }
  if (report.triggerAccuracy === undefined || !Array.isArray(report.scenarios)) {
    return errors;
  }

  // F19 (flow 309 review round 1): `triggerAccuracy.positives`/`negatives`
  // claim N prompts were checked; nothing previously required N matching
  // `scenarios` entries to actually be present — a report with
  // `scenarios: []` but `triggerAccuracy: {positives: 1, negatives: 1, ...}`
  // validated clean, which is exactly the "empty scenarios must not pass"
  // shape a vacuous guard test let through. The two must agree.
  const triggerPositiveScenarios = report.scenarios.filter((scenario) => scenario.kind === "trigger-positive");
  const triggerNegativeScenarios = report.scenarios.filter((scenario) => scenario.kind === "trigger-negative");
  const triggerScenarioCount = triggerPositiveScenarios.length + triggerNegativeScenarios.length;
  const claimedTriggerCount = report.triggerAccuracy.positives + report.triggerAccuracy.negatives;
  if (triggerScenarioCount !== claimedTriggerCount) {
    errors.push(
      `triggerAccuracy claims ${claimedTriggerCount} trigger prompt(s) (${report.triggerAccuracy.positives} positive + ${report.triggerAccuracy.negatives} negative) but the report carries ${triggerScenarioCount} trigger scenario(s)`,
    );
  }

  // R2-4 (flow 309 review round 2): `checkStablePackGate`/consumers trusted
  // a self-declared `verdict: "pass"` at face value — a report with
  // `scenarios: []` (nothing ran) or every scenario `"skipped"`/`"not-run"`
  // could still hand-declare `"pass"`. A `"pass"` verdict must be backed by
  // at least one ACTUALLY RAN trigger-positive and one ran trigger-negative
  // scenario, and no scenario left `"skipped"` or `"not-run"`.
  if (report.verdict === "pass") {
    const hasRanTriggerPositive = triggerPositiveScenarios.some((scenario) => scenario.status === "ran");
    const hasRanTriggerNegative = triggerNegativeScenarios.some((scenario) => scenario.status === "ran");
    if (!hasRanTriggerPositive || !hasRanTriggerNegative) {
      errors.push("verdict 'pass' requires at least one ran trigger-positive and one ran trigger-negative scenario");
    }
    if (report.scenarios.some((scenario) => scenario.status === "skipped" || scenario.status === "not-run")) {
      errors.push("verdict 'pass' is not allowed while a scenario is 'skipped' or 'not-run'");
    }

    // R3-2 (flow 309 review round 3): R2-6 only checked evidence/ran-counts
    // — a hand-edited report could still declare `verdict: "pass"` while its
    // OWN scenario data says the run failed (e.g. `triggerAccuracy: {truePositive:
    // 0, falsePositive: 1, ...}`, every scenario `passRate: 0`). Recompute
    // the exact same `triggersOk`/`behaviorOk` expression `evalSkill` itself
    // uses to derive a verdict, directly from the report's own
    // `triggerAccuracy` and `scenarios` — a self-declared "pass" that
    // disagrees with its own data is refused.
    const triggersOk =
      report.triggerAccuracy.positives > 0 &&
      report.triggerAccuracy.negatives > 0 &&
      report.triggerAccuracy.truePositive === report.triggerAccuracy.positives &&
      report.triggerAccuracy.falsePositive === 0;
    if (!triggersOk) {
      errors.push(
        `verdict 'pass' disagrees with its own triggerAccuracy (truePositive ${report.triggerAccuracy.truePositive}/${report.triggerAccuracy.positives}, falsePositive ${report.triggerAccuracy.falsePositive})`,
      );
    }
    const ranTriggerScenariosAllPass = [...triggerPositiveScenarios, ...triggerNegativeScenarios]
      .filter((scenario) => scenario.status === "ran")
      .every((scenario) => scenario.passRate === 1);
    if (!ranTriggerScenariosAllPass) {
      errors.push("verdict 'pass' disagrees with its own scenarios: a ran trigger scenario has passRate < 1");
    }
    const ranBehaviorScenariosOk = report.scenarios
      .filter((scenario) => scenario.kind === "behavior" && scenario.status === "ran")
      .every((scenario) => scenario.passRate >= 0.5);
    if (!ranBehaviorScenariosOk) {
      errors.push("verdict 'pass' disagrees with its own scenarios: a ran behavior scenario has passRate < 0.5");
    }
  }

  for (const scenario of report.scenarios) {
    if (!(scenario.passRate >= 0 && scenario.passRate <= 1)) {
      errors.push(`scenario ${scenario.id}: passRate ${scenario.passRate} is out of [0, 1]`);
    }
    if (typeof scenario.trials !== "number" || scenario.trials < 0) {
      errors.push(`scenario ${scenario.id}: missing or invalid trials count`);
    }
    // F11 (AC10): the `trials >= 3` contract at high strictness applies to
    // runner-based BEHAVIOR scenarios, which are genuinely repeatable — not
    // to trigger scenarios, which are one deterministic scoring call
    // (`scenario.deterministic`) and always correctly report `trials: 1`.
    if (scenario.kind === "behavior" && scenario.status === "ran" && scenario.strictness === "high" && scenario.trials < 3) {
      errors.push(`scenario ${scenario.id}: strictness high requires trials >= 3 (got ${scenario.trials})`);
    }
  }
  return errors;
}

export interface StablePackGateResult {
  readonly status: "pass" | "fail" | "not-applicable";
  readonly reason?: string;
}

/**
 * F19 (flow 309 review round 1): the "a stable stack pack ships a passing
 * governance/eval.json" gate used to live only as inline assertions inside
 * `stack-packs.test.ts`, against the REAL bundled `python` pack — which
 * ships `stability: "experimental"`, so the test's own early-return
 * (`if (pack.stability !== "stable") return`) meant the actual gate logic
 * never ran against anything, ever. A vacuous test that always "passes"
 * because it never executes its own assertions. Extracted here so it can be
 * exercised directly against a FIXTURE pack that genuinely is `"stable"`
 * (one with a passing eval.json, and one with none) — `stack-packs.test.ts`
 * now calls this function for both the real tree and the fixtures.
 */
export function checkStablePackGate(packDir: string, stability: string): StablePackGateResult {
  if (stability !== "stable") {
    return { status: "not-applicable", reason: `pack stability is "${stability}", not "stable"` };
  }
  const evalPath = path.join(packDir, "governance", "eval.json");
  if (!existsSync(evalPath)) {
    return { status: "fail", reason: "governance/eval.json is missing" };
  }
  let report: EvalReport;
  try {
    report = JSON.parse(readFileSync(evalPath, "utf8")) as EvalReport;
  } catch (error) {
    return { status: "fail", reason: `governance/eval.json could not be parsed: ${error instanceof Error ? error.message : String(error)}` };
  }
  // R2-6 (flow 309 review round 2): `validateEvalReport` itself is now
  // defensive against a missing `triggerAccuracy`/`scenarios` (it returns
  // errors instead of throwing), but this call is wrapped regardless — a
  // gate that is supposed to answer "fail" for a broken report must never
  // let an unexpected exception propagate to the caller instead.
  let errors: string[];
  try {
    errors = validateEvalReport(report);
  } catch (error) {
    return { status: "fail", reason: `governance/eval.json could not be validated: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (errors.length > 0) {
    return { status: "fail", reason: `governance/eval.json fails its own contract: ${errors.join("; ")}` };
  }
  if (report.verdict !== "pass") {
    return { status: "fail", reason: `governance/eval.json verdict is "${report.verdict}", not "pass"` };
  }
  // R2-4: the gate must not simply trust a self-declared `verdict`/`evidence`
  // — recompute the two load-bearing facts directly from the report's own
  // data. `validateEvalReport`'s "pass requires a ran trigger-positive and
  // ran trigger-negative, no skipped/not-run" rule already guards the
  // "nothing checked" shape; this adds the two checks this workstream's
  // dispatch calls out explicitly for the stable-pack gate: evidence must be
  // `"authored"` (a stable pack's shipped eval.json is meant to be
  // human-verified, not merely synthesized-and-happened-to-pass — though
  // `validateEvalReport` already forbids synthesized+pass, this is belt and
  // suspenders against a hand-edited report that skips validation some other
  // way in the future), and at least one scenario must have actually `ran`.
  if (report.evidence !== "authored") {
    return { status: "fail", reason: `governance/eval.json evidence is "${report.evidence}", not "authored"` };
  }
  const ranScenarios = report.scenarios.filter((scenario) => scenario.status === "ran").length;
  if (ranScenarios === 0) {
    return { status: "fail", reason: "governance/eval.json has zero ran scenarios" };
  }
  return { status: "pass" };
}
