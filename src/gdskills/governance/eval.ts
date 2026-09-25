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

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadSkillCatalog, type CatalogEntry, type CatalogScope } from "./catalog-index";
import { isAllowlistedJudge, isAllowlistedRunner } from "./gate-policy";
import { parseSkillFrontmatter } from "../skill-frontmatter";
import {
  gradeScenarioAnswer,
  JUDGE_PROMPT_VERSION,
  type DeterministicExpectation,
  type Judge,
  type JudgeExpectation,
  type JudgeVerdict,
  type ScenarioCalibration,
} from "./judge";
import { checkSkillSelected, checkSkillSelectedLeaveOneOut, nearestSkills } from "./scout";

export type Strictness = "low" | "medium" | "high";
/** Kept for backward compatibility — the deterministic graders only. `"judge"` is its own expectation kind (see `JudgeExpectation`), not a `Grader` value, since it carries no `value` field. */
export type Grader = "contains" | "regex" | "not-contains" | "model";

/** The deterministic shape, re-exported under its original name — unchanged (`grader`/`value`), so every existing `evals.json` and every existing caller stays byte-for-byte compatible. */
export type ExpectedBehavior = DeterministicExpectation | JudgeExpectation;

export type { DeterministicExpectation, Judge, JudgeExpectation, JudgeVerdict, ScenarioCalibration } from "./judge";
export { JUDGE_PROMPT_VERSION } from "./judge";

export interface EvalScenarioSpec {
  readonly id: string;
  readonly prompt: string;
  readonly strictness: Strictness;
  readonly expected_behavior: readonly ExpectedBehavior[];
  /** Required when `expected_behavior` carries a `judge` expectation (flow 316) — the hand-written correct/wrong answers `antiGamingAnswers` and the integrity guard's calibration checks key off. */
  readonly calibration?: ScenarioCalibration;
  /** Optional literal tokens naming an anti-pattern this skill forbids — surfaced to the judge via `calibration.known_wrong` and checked against the skill's own `SKILL.md` by the integrity guard (I6/I7), not consumed by this module directly. */
  readonly anti_patterns?: readonly string[];
}

/** The optional `evals.json` a skill author ships beside `SKILL.md`. */
export interface EvalSpecFile {
  readonly triggers?: { readonly positive: readonly string[]; readonly negative: readonly string[] };
  readonly scenarios?: readonly EvalScenarioSpec[];
}

export type RunnerOutput = { readonly output: string };

/**
 * Flow 317 (FU2): every `--runner` call appends this note to the skill's own
 * `SKILL.md` system prompt, uniformly across every skill/scenario. The
 * single-turn runner (`buildEvalRunner`, `src/commands/model-eval-runner.ts`)
 * has no tools wired in at all — `go/go-testing#table-driven-subtests`
 * (flow 316 journal T13) was failing 3/5 trials not because the answer was
 * wrong, but because the model emitted a tool/shell call ("let me inspect
 * the function first") that the judge then graded as non-text output. This
 * is a runner/skill interaction limitation, not a rubric defect, so the fix
 * is a runner-level instruction, applied to every skill alike, never a
 * per-scenario prompt or rubric change.
 */
export const RUNNER_SYSTEM_NOTE =
  "Answer in plain text only. You have no tools, shell, or file access in this exercise -- do not attempt a tool call, function call, or shell command; reply with your complete answer directly, inline, as your entire response.";

/**
 * Bumped whenever `RUNNER_SYSTEM_NOTE` (or how it is appended to the skill's
 * system prompt) changes — mirrors `JUDGE_PROMPT_VERSION`'s contract. A
 * recorded report's `runnerPromptVersion` is only trustworthy against the
 * exact note text that produced its trials; the stable-pack gate requires
 * it to equal the CURRENT version for every report carrying a `--runner`
 * generated behavior scenario (`checkSkillReportForPackGate`).
 */
export const RUNNER_PROMPT_VERSION = "2026-09-25.1";

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

/**
 * One trial's full, re-gradable evidence (flow 316): the raw model output,
 * its hash (so `regradeRecordedReport` can catch a tampered `output`
 * without re-running anything), the per-expectation deterministic results,
 * the judge verdict (when the scenario carries one), and the `passed`
 * conclusion — every one of these is independently recomputable from
 * `output` alone except the judge verdict itself, which is trusted as
 * recorded (there is no offline way to know what a live judge would have
 * said).
 */
export interface TrialRecord {
  readonly output: string;
  readonly outputSha256: string;
  /**
   * Flow 316 fix1 (R1-2/R1-9 forgery class): `sha256` of the SCENARIO PROMPT
   * this trial actually answered — `regradeRecordedReport` requires this to
   * equal `sha256` of the current scenario's own prompt, which is what stops
   * a set of real, honestly-graded trial records from one scenario being
   * copied onto another scenario's report entry (the answer would then be
   * answering a different question than the one it is credited against).
   */
  readonly promptSha256: string;
  /** One boolean per non-judge expectation, in `expected_behavior` order. */
  readonly deterministic: readonly boolean[];
  readonly judge?: JudgeVerdict;
  readonly passed: boolean;
}

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
  /** Flow 316: one entry per trial for every RAN behavior scenario — the full record `regradeRecordedReport` and the stable-pack gate check for tampering. Absent for trigger scenarios (one deterministic call, not a trial series) and for a scenario that never ran. */
  readonly trialRecords?: readonly TrialRecord[];
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
  /**
   * Flow 314 review round 1 (R1-11, R1-15): the catalog scope the trigger
   * scenarios were scored against — `evalSkill` stamps this from
   * `options.scope` when the caller supplies one. The stable-pack gate
   * requires `"bundled"` (the catalog users actually install); an `"all"`
   * report may have passed only because a repo-local skill outside the
   * shipped bundle tipped a trigger score.
   */
  readonly scope?: CatalogScope;
  /**
   * R1-3/R1-15: `computeSkillEvalDigest(skillDir)` at the time `evalSkill`
   * ran — sha256 of the skill's `SKILL.md` bytes plus its `evals.json`
   * bytes (empty when absent). The stable-pack gate recomputes this from the
   * CURRENT skill directory and refuses a report whose digest disagrees, so
   * an eval.json edited after the skill (or left stale after a skill edit)
   * cannot clear the gate.
   */
  readonly skillDigest?: string;
  /** R1-15: the model-backed provider this report's behavior scenarios actually ran against (e.g. `"ollama"`) — the CLI stamps this when `--runner` was used. Absent for a report with no runner (behavior scenarios `not-run`). */
  readonly runner?: string;
  /** R1-15: the model id (e.g. `"llama3.1:latest"`) — stamped by the CLI alongside `runner`. */
  readonly model?: string;
  /** Flow 317 (FU2): `RUNNER_PROMPT_VERSION` at the time this report's `--runner` behavior scenarios actually ran — stamped by the CLI (`skills-governance.ts`'s `evalCommand`) alongside `runner`/`model`, mirroring how `evalSkill` itself stamps `judgePromptVersion`. Absent for a report with no runner. */
  readonly runnerPromptVersion?: string;
  /** R1-15: ISO timestamp of when the CLI recorded this report. */
  readonly recordedAt?: string;
  /** Flow 316: the judge provider this report's judge-graded behavior scenarios actually ran against (e.g. `"deepseek"`) — stamped by the CLI alongside `judgeModel`, mirroring `runner`/`model`. Absent when no scenario carried a judge expectation. */
  readonly judge?: string;
  /** Flow 316: the judge model id (e.g. `"deepseek-chat"`). */
  readonly judgeModel?: string;
  /** Flow 316: `JUDGE_PROMPT_VERSION` at the time this report's judge scenarios ran — stamped by `evalSkill` itself whenever a judge was actually invoked, so a later prompt-text edit makes an old report's judge verdicts detectably stale. */
  readonly judgePromptVersion?: string;
  /** Flow 316: `computeCatalogTriggerDigest` of the catalog `evalSkill` scored the trigger scenarios against — always stamped, from the catalog passed in. The stable-pack gate re-scores the triggers live when this disagrees with the current bundled catalog's digest. */
  readonly catalogDigest?: string;
}

export interface EvalOptions {
  readonly strictness?: Strictness;
  readonly trials?: number;
  readonly runner?: Runner;
  /** Whether model-graded expectations were REQUESTED (e.g. CLI `--model-grader`) — informational only; whether they can actually be graded depends on `modelGraderFn`. */
  readonly modelGrader?: boolean;
  /** The injectable grading capability itself (F10) — when absent, `"model"`-graded expectations are reported `status: "skipped"`, never counted as passed. */
  readonly modelGraderFn?: ModelGrader;
  /** R1-11: the catalog scope `catalog` was loaded with — stamped onto the report's `scope` field verbatim (this function does not re-derive it from `catalog` itself, since a caller may hand-build a catalog array with no scope of its own). */
  readonly scope?: CatalogScope;
  /** Flow 316: the injectable judge capability — when absent, a scenario carrying a `judge` expectation is reported `status: "skipped"`, never counted as passed (mirrors `modelGraderFn`'s contract for the older `"model"` grader). */
  readonly judge?: Judge;
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
const VALID_EXPECTATION_GRADERS: readonly string[] = [...VALID_GRADERS, "judge"];

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
    let judgeExpectationCount = 0;
    scenario.expected_behavior.forEach((expectedValue, expectedIndex) => {
      if (typeof expectedValue !== "object" || expectedValue === null || Array.isArray(expectedValue)) {
        throw new EvalSpecError(`${specPath}: scenario "${label}" expected_behavior[${expectedIndex}] must be an object`);
      }
      const expected = expectedValue as Record<string, unknown>;
      if (typeof expected.grader !== "string" || !VALID_EXPECTATION_GRADERS.includes(expected.grader)) {
        throw new EvalSpecError(
          `${specPath}: scenario "${label}" expected_behavior[${expectedIndex}] has an unknown grader ${JSON.stringify(expected.grader)} (must be one of ${VALID_EXPECTATION_GRADERS.join(", ")})`,
        );
      }
      if (expected.grader === "judge") {
        judgeExpectationCount += 1;
        if (judgeExpectationCount > 1) {
          throw new EvalSpecError(`${specPath}: scenario "${label}" must not carry more than one "judge" expectation`);
        }
        if (typeof expected.rubric !== "string" || expected.rubric.length === 0) {
          throw new EvalSpecError(`${specPath}: scenario "${label}" expected_behavior[${expectedIndex}] (judge) must have a non-empty "rubric" string`);
        }
        if (!Array.isArray(expected.pass_criteria) || expected.pass_criteria.length === 0 || !expected.pass_criteria.every((c) => typeof c === "string" && c.length > 0)) {
          throw new EvalSpecError(`${specPath}: scenario "${label}" expected_behavior[${expectedIndex}] (judge) must have a non-empty "pass_criteria" array of non-empty strings`);
        }
        if (expected.fail_criteria !== undefined) {
          if (!Array.isArray(expected.fail_criteria) || !expected.fail_criteria.every((c) => typeof c === "string" && c.length > 0)) {
            throw new EvalSpecError(`${specPath}: scenario "${label}" expected_behavior[${expectedIndex}] (judge) "fail_criteria" must be an array of non-empty strings`);
          }
        }
        if (expected.value !== undefined) {
          throw new EvalSpecError(`${specPath}: scenario "${label}" expected_behavior[${expectedIndex}] (judge) must not carry a "value"`);
        }
        return;
      }
      if (typeof expected.value !== "string" || expected.value.length === 0) {
        throw new EvalSpecError(`${specPath}: scenario "${label}" expected_behavior[${expectedIndex}] must have a non-empty "value" string`);
      }
      if (expected.grader === "regex" && !isValidRegexPattern(expected.value)) {
        throw new EvalSpecError(`${specPath}: scenario "${label}" expected_behavior[${expectedIndex}] has an invalid regex value ${JSON.stringify(expected.value)}`);
      }
    });

    if (judgeExpectationCount > 0) {
      if (typeof scenario.calibration !== "object" || scenario.calibration === null || Array.isArray(scenario.calibration)) {
        throw new EvalSpecError(`${specPath}: scenario "${label}" carries a "judge" expectation and must have a "calibration" object`);
      }
      const calibration = scenario.calibration as Record<string, unknown>;
      if (typeof calibration.known_right !== "string" || calibration.known_right.length === 0) {
        throw new EvalSpecError(`${specPath}: scenario "${label}" calibration.known_right must be a non-empty string`);
      }
      if (typeof calibration.known_wrong !== "string" || calibration.known_wrong.length === 0) {
        throw new EvalSpecError(`${specPath}: scenario "${label}" calibration.known_wrong must be a non-empty string`);
      }
      // Flow 316 fix1 (shared contract item 1): `vague` (a plausible,
      // direction-pointing answer with no concrete fix) and `subtle_wrong`
      // (a realistic answer that still commits the anti-pattern) are
      // REQUIRED alongside `known_right`/`known_wrong` — the judge was shown
      // (review round 1, R1-4) to pass vague one-liners the deterministic
      // calibration set never exercised. Required, not optional: a scenario
      // that ships no `vague`/`subtle_wrong` answer proves nothing about
      // whether its rubric actually rejects them.
      if (typeof calibration.vague !== "string" || calibration.vague.length === 0) {
        throw new EvalSpecError(`${specPath}: scenario "${label}" calibration.vague must be a non-empty string`);
      }
      if (typeof calibration.subtle_wrong !== "string" || calibration.subtle_wrong.length === 0) {
        throw new EvalSpecError(`${specPath}: scenario "${label}" calibration.subtle_wrong must be a non-empty string`);
      }
      const calibrationAnswers = [calibration.known_right, calibration.known_wrong, calibration.vague, calibration.subtle_wrong] as string[];
      if (new Set(calibrationAnswers).size !== calibrationAnswers.length) {
        throw new EvalSpecError(
          `${specPath}: scenario "${label}" calibration answers (known_right, known_wrong, vague, subtle_wrong) must be pairwise different`,
        );
      }
    }
    if (scenario.anti_patterns !== undefined) {
      if (!Array.isArray(scenario.anti_patterns) || !scenario.anti_patterns.every((token) => typeof token === "string" && token.length > 0)) {
        throw new EvalSpecError(`${specPath}: scenario "${label}" "anti_patterns" must be an array of non-empty strings`);
      }
    }
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

/**
 * Flow 316: a thin exported wrapper over `readEvalSpec` for callers outside
 * this module that need a skill's parsed, validated `evals.json` without
 * duplicating this module's path derivation (`evals.json` next to
 * `SKILL.md`) or `validateEvalSpec`'s shape checks — `keryx skills
 * judge-check` (`src/commands/skills-governance.ts`) reads a stack skill's
 * evals.json this way rather than re-implementing spec parsing.
 */
export function readSkillEvalSpec(skillMdPath: string): EvalSpecFile | undefined {
  return readEvalSpec(skillMdPath);
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

/** Exported so the pack-level gate fixtures (`__fixtures__/gate-ready-report.ts`) and `regradeRecordedReport` share the exact same deterministic semantics `evalSkill`'s own trial loop applies. */
export function gradeDeterministic(output: string, expected: ExpectedBehavior): boolean | undefined {
  switch (expected.grader) {
    case "contains":
      return output.includes(expected.value);
    case "not-contains":
      return !output.includes(expected.value);
    case "regex":
      return new RegExp(expected.value).test(output);
    default:
      return undefined; // "model"/"judge" — graded by the caller (a ModelGrader or a Judge), never here.
  }
}

/**
 * Flow 314 review round 1 fix (I1-I5 integrity rules,
 * `src/gdskills/stack-pack-eval-integrity.test.ts`): grades one `output`
 * against a scenario's full `expected_behavior` list, using the EXACT SAME
 * deterministic semantics `evalSkill`'s own trial loop applies —
 * `gradeDeterministic` per expectation, AND across every expectation (a
 * scenario fails when ANY expectation fails). A `"model"`-graded expectation
 * with no grader supplied counts as a failure here (there is no runner/CLI
 * context to skip it against) — this helper is for the deterministic
 * empty/echo/self-match integrity probes only, never a substitute for
 * `evalSkill`'s real trial loop.
 */
export function gradeExpectations(output: string, expected: readonly ExpectedBehavior[]): boolean {
  if (expected.length === 0) return false;
  return expected.every((one) => gradeDeterministic(output, one) === true);
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

export interface TriggerScoreResult {
  readonly scenarios: readonly EvalScenarioResult[];
  readonly triggerAccuracy: EvalTriggerAccuracy;
  readonly evidence: EvalEvidence;
}

/**
 * Scores every trigger-positive/negative prompt for `skill` against
 * `catalog` — the exact logic `evalSkill` runs for its own trigger-accuracy
 * half, extracted (flow 316) so the stable-pack gate's live re-score on
 * catalog drift (`checkSkillReportForPackGate`, `checkStablePackGate`) calls
 * this SAME function and can never disagree with `evalSkill` about what
 * "this prompt selects this skill" means.
 */
export function scoreTriggerScenarios(
  skill: CatalogEntry,
  catalog: readonly CatalogEntry[],
  spec: EvalSpecFile | undefined,
  strictness: Strictness,
): TriggerScoreResult {
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

  return {
    scenarios,
    triggerAccuracy: { truePositive, falsePositive, positives: positives.length, negatives: negatives.length },
    evidence,
  };
}

/**
 * `sha256` over every catalog entry's `id` + its own content `sha256`,
 * sorted by id — identifies exactly which catalog (and which skill content)
 * the trigger scenarios were scored against, so the stable-pack gate can
 * tell whether the bundled catalog has drifted since a report was recorded
 * without needing to re-score anything when it has not.
 */
export function computeCatalogTriggerDigest(catalog: readonly CatalogEntry[]): string {
  const sorted = [...catalog].sort((a, b) => a.id.localeCompare(b.id));
  const hash = createHash("sha256");
  for (const entry of sorted) {
    hash.update(entry.id).update("\0").update(entry.sha256).update("\n");
  }
  return hash.digest("hex");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Runs one behavior scenario's trial loop and returns both the aggregate
 * `EvalScenarioResult` and the per-trial `TrialRecord`s that back it. Shared
 * by the "judge" and legacy "model"/deterministic-only code paths in
 * `evalSkill` below so both produce the same re-gradable evidence shape.
 */
async function runBehaviorTrials(
  behaviorSpec: EvalScenarioSpec,
  skill: CatalogEntry,
  runner: Runner,
  trials: number,
  gradeOneTrial: (output: string) => Promise<{ readonly deterministic: readonly boolean[]; readonly judge?: JudgeVerdict; readonly passed: boolean }>,
): Promise<EvalScenarioResult> {
  const trialRecords: TrialRecord[] = [];
  const promptSha256 = sha256Hex(behaviorSpec.prompt);
  let passes = 0;
  for (let trial = 0; trial < trials; trial++) {
    const { output } = await runner(behaviorSpec.prompt, skill);
    const graded = await gradeOneTrial(output);
    if (graded.passed) passes += 1;
    trialRecords.push({
      output,
      outputSha256: sha256Hex(output),
      promptSha256,
      deterministic: graded.deterministic,
      ...(graded.judge !== undefined ? { judge: graded.judge } : {}),
      passed: graded.passed,
    });
  }
  return {
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
    trialRecords,
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
  const triggerScore = scoreTriggerScenarios(skill, catalog, spec, strictness);
  const { evidence } = triggerScore;
  const scenarios: EvalScenarioResult[] = [...triggerScore.scenarios];
  const { truePositive, falsePositive, positives, negatives } = triggerScore.triggerAccuracy;

  let judgeUsed = false;

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

    const hasJudgeExpectation = behaviorSpec.expected_behavior.some((expected) => expected.grader === "judge");

    // Flow 316: a scenario carrying a `judge` expectation is graded through
    // `gradeScenarioAnswer` — the ONE grading function shared with the
    // anti-gaming harness and `judge-check`. Without a live judge capability
    // the WHOLE scenario is `status: "skipped"`, mirroring the pre-existing
    // "model" rule below rather than silently treating "not checked" as
    // "checked and fine".
    if (hasJudgeExpectation) {
      if (options.judge === undefined) {
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
          reason: "judge-graded expectation with no judge capability (pass --judge <provider>[:<model>])",
        });
        continue;
      }
      judgeUsed = true;
      const judgeFn = options.judge;
      const runnerFn = options.runner;
      const result = await runBehaviorTrials(behaviorSpec, skill, runnerFn, trials, (output) => gradeScenarioAnswer(output, behaviorSpec, judgeFn));
      scenarios.push(result);
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

    const runnerFn = options.runner;
    const modelGraderFn = options.modelGraderFn;
    const result = await runBehaviorTrials(behaviorSpec, skill, runnerFn, trials, async (output) => {
      const deterministic: boolean[] = [];
      let trialPassed = true;
      for (const expected of behaviorSpec.expected_behavior) {
        if (expected.grader === "model") {
          // `modelGraderFn` is guaranteed defined here (checked above).
          const graded = await (modelGraderFn as ModelGrader)(output, expected, skill);
          deterministic.push(graded === true);
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
        const graded = gradeDeterministic(output, expected) === true;
        deterministic.push(graded);
        if (!graded) trialPassed = false;
      }
      return { deterministic, passed: trialPassed };
    });
    scenarios.push(result);
  }

  const triggerAccuracy: EvalTriggerAccuracy = { truePositive, falsePositive, positives, negatives };

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
  const triggersOk = positives > 0 && negatives > 0 && truePositive === positives && falsePositive === 0;
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

  // R1-3/R1-15: stamp the digest of the skill's CURRENT SKILL.md + evals.json
  // so a later edit (or a hand-edited/stale report) is detectable by the
  // stable-pack gate. Best-effort — a skill entry built from a fixture with
  // no real file on disk (several tests in this file construct one) must not
  // make `evalSkill` itself throw; `skillDigest` is simply omitted then.
  let skillDigest: string | undefined;
  try {
    skillDigest = computeSkillEvalDigest(path.dirname(skill.path));
  } catch {
    skillDigest = undefined;
  }

  // Flow 316: always stamped, from the catalog `evalSkill` was actually
  // called with — the gate compares this against a freshly-loaded bundled
  // catalog's own digest to detect drift.
  const catalogDigest = computeCatalogTriggerDigest(catalog);

  const report: EvalReport = {
    schemaVersion: "1.0.0",
    skillId,
    strictness,
    trials,
    triggerAccuracy,
    evidence,
    scenarios,
    verdict,
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
    ...(skillDigest !== undefined ? { skillDigest } : {}),
    catalogDigest,
    ...(judgeUsed ? { judgePromptVersion: JUDGE_PROMPT_VERSION } : {}),
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
 * Flow 314, W4 Wave 4: the pack-level behavior-eval floor
 * (docs/requirements/keryx-agent-platform-expansion/metrics-and-validation.md
 * "Behavior-eval pass@k": "pass@3 ≥ 80% before graduating from `candidate`").
 * Applied per RAN behavior scenario in a pack-level eval document — see
 * `checkStablePackGate`'s pack-level branch below.
 */
export const PACK_BEHAVIOR_PASS_FLOOR = 0.8;

/**
 * Flow 314 review round 1 (R1-3): the minimum `trials` a pack-level report
 * must carry — named so the gate's requirement reads as one number, not a
 * magic `5` repeated at every call site.
 */
export const PACK_MIN_TRIALS = 5;

/**
 * Flow 314 review round 1 (R1-3, R1-15): `sha256(SKILL.md bytes + "\n\u0000\n"
 * + evals.json bytes)`, `evals.json` bytes empty when the file is absent.
 * Both `evalSkill` (stamping a FRESH report's `skillDigest`) and the
 * stable-pack gate (recomputing the CURRENT digest to compare against a
 * report's stamped one) call this same function, so they can never disagree
 * about what "the skill's content" means. Throws when `SKILL.md` itself is
 * missing/unreadable — callers that need a non-throwing answer (the gate)
 * check `existsSync` on `SKILL.md` first and report their own named reason.
 */
export function computeSkillEvalDigest(skillDir: string): string {
  const skillMdBytes = readFileSync(path.join(skillDir, "SKILL.md"));
  const evalsJsonPath = path.join(skillDir, "evals.json");
  const evalsJsonBytes = existsSync(evalsJsonPath) ? readFileSync(evalsJsonPath) : Buffer.alloc(0);
  return createHash("sha256").update(skillMdBytes).update("\n\u0000\n").update(evalsJsonBytes).digest("hex");
}

/**
 * Flow 316 fix1 (R1-1/R1-3): builds the CURRENT `CatalogEntry` for the skill
 * under gate directly from its own `SKILL.md` on disk — the exact file
 * `computeSkillEvalDigest`/`readEvalSpec` already read for this same skill —
 * mirroring `catalog-index.ts`'s own `readCatalogEntry` (kept as a small,
 * local duplicate rather than an import, so this module never needs that one
 * exported for a single caller).
 *
 * Why this exists: the stable-pack gate's trigger re-score (below) must run
 * against the skill's CURRENT content, not a possibly-stale snapshot from
 * whatever `loadSkillCatalog` scan happened to be passed in. For a REAL
 * bundled stack pack this is a no-op — `checkStablePackGate` is only ever
 * called on a directory `loadSkillCatalog(..., {scope: "bundled"})` itself
 * walks, so the scan already contains an identical entry — but it is NOT a
 * no-op for a fixture pack under a temp directory (every gate unit test),
 * which is never part of that scan at all. Reading the skill's own current
 * file directly makes the re-score correct in both cases, without asking
 * every gate caller to hand-build and inject a matching catalog entry.
 */
export function currentSkillCatalogEntry(skillId: string, skillDir: string): CatalogEntry {
  const skillMdPath = path.join(skillDir, "SKILL.md");
  const body = readFileSync(skillMdPath, "utf8");
  const frontmatter = parseSkillFrontmatter(body);
  const slash = skillId.indexOf("/");
  const category = slash >= 0 ? skillId.slice(0, slash) : skillId;
  const name = slash >= 0 ? skillId.slice(slash + 1) : skillId;
  return {
    id: skillId,
    category,
    name,
    description: frontmatter.description ?? "",
    triggers: frontmatter.triggers ?? [],
    body,
    bodyLines: body.split("\n").length,
    ...(frontmatter.metadataOrigin !== undefined ? { origin: frontmatter.metadataOrigin } : {}),
    sha256: sha256Hex(body),
    path: skillMdPath,
  };
}

/**
 * Flow 316: re-derives every RAN behavior scenario's grading from its own
 * recorded `trialRecords`, against `spec` (the skill's CURRENT `evals.json`
 * — the caller re-reads it, never trusts the report's own copy of a
 * scenario's expectations), and returns every disagreement found. `[]` means
 * the report is internally consistent — its `output`s really do hash to
 * `outputSha256`, its `deterministic` results really do recompute the same
 * way from those outputs, and its `passed`/`passes` really do follow from
 * `deterministic` and (for a judge scenario) the recorded judge verdict.
 * This is what lets the stable-pack gate refuse a report whose evidence was
 * tampered with after recording, without re-running the model or the judge.
 */
export function regradeRecordedReport(report: EvalReport, spec: EvalSpecFile | undefined): string[] {
  const errors: string[] = [];
  const specScenarios = new Map((spec?.scenarios ?? []).map((scenario) => [scenario.id, scenario] as const));

  for (const scenario of report.scenarios) {
    if (scenario.kind !== "behavior" || scenario.status !== "ran") continue;

    const records = scenario.trialRecords;
    if (records === undefined || records.length === 0) {
      errors.push(`scenario ${scenario.id}: missing trialRecords`);
      continue;
    }

    const specScenario = specScenarios.get(scenario.id);
    if (specScenario === undefined) {
      errors.push(`scenario ${scenario.id}: no matching scenario in the current evals.json to regrade against`);
      continue;
    }

    const deterministicExpectations = specScenario.expected_behavior.filter(
      (expected): expected is DeterministicExpectation => expected.grader !== "judge",
    );
    const hasJudgeExpectation = specScenario.expected_behavior.some((expected) => expected.grader === "judge");

    // R1-1 (flow 316 fix1, review round 1): a report used to be trusted to
    // declare its own `trials` count — nothing checked that `trialRecords`
    // actually carried that many entries, which let a run's failing records
    // be quietly dropped (real passing outputs and real judge verdicts
    // cherry-picked from an otherwise-failing run) while `trials` stayed at
    // its original, honest value.
    if (records.length !== scenario.trials) {
      errors.push(`scenario ${scenario.id}: trialRecords carries ${records.length} record(s) but the scenario declares trials: ${scenario.trials}`);
    }

    const currentPromptSha256 = sha256Hex(specScenario.prompt);

    let passes = 0;
    records.forEach((record, index) => {
      const label = `scenario ${scenario.id} trial ${index + 1}`;
      if (sha256Hex(record.output) !== record.outputSha256) {
        errors.push(`${label}: output does not match its recorded outputSha256 (output was tampered with)`);
      }
      // R1-9 (flow 316 fix1): a record's `promptSha256` must match the
      // CURRENT scenario's own prompt — this is what stops a set of real,
      // honestly-graded trial records answering one scenario's prompt from
      // being transplanted onto a different scenario's report entry.
      if (record.promptSha256 !== currentPromptSha256) {
        errors.push(`${label}: promptSha256 does not match the current scenario's prompt (record may be transplanted from another scenario)`);
      }
      const recomputedDeterministic = deterministicExpectations.map((expected) => gradeDeterministic(record.output, expected) === true);
      const deterministicMatches =
        recomputedDeterministic.length === record.deterministic.length &&
        recomputedDeterministic.every((value, i) => value === record.deterministic[i]);
      if (!deterministicMatches) {
        errors.push(`${label}: recomputed deterministic results disagree with the recorded ones`);
      }
      if (hasJudgeExpectation && record.judge === undefined) {
        errors.push(`${label}: a judge scenario is missing a recorded judge verdict`);
      }
      // R1-8 (flow 316 fix1): a judge verdict carrying `error` (a parse
      // failure `buildEvalJudge` manufactured after retrying once, never a
      // genuinely reasoned reply) must never also read `verdict: "pass"` —
      // `buildEvalJudge` itself never produces that combination, so seeing
      // it here means the record was hand-edited.
      if (record.judge?.error !== undefined && record.judge.verdict === "pass") {
        errors.push(`${label}: judge verdict "pass" carries an "error" (a manufactured verdict, never a genuine one, cannot pass)`);
      }
      const deterministicOk = record.deterministic.every((value) => value === true);
      const expectedPassed = hasJudgeExpectation ? deterministicOk && record.judge?.verdict === "pass" : deterministicOk;
      if (record.passed !== expectedPassed) {
        errors.push(`${label}: recorded "passed" disagrees with its own deterministic/judge results`);
      }
      if (record.passed) passes += 1;
    });
    if (passes !== scenario.passes) {
      errors.push(`scenario ${scenario.id}: recorded passes (${scenario.passes}) disagrees with its trialRecords (${passes})`);
    }
    // R1-1: `passRate`/`passAtK` used to be trusted as self-declared — a
    // report with honest, unedited `trialRecords` but a hand-edited
    // `passRate: 1` cleared the gate. Both are now recomputed from
    // `trials`/`passes` the same way `runBehaviorTrials` derives them.
    if (scenario.trials > 0) {
      const computedPassRate = passes / scenario.trials;
      if (Math.abs(scenario.passRate - computedPassRate) > 1e-9) {
        errors.push(`scenario ${scenario.id}: recorded passRate (${scenario.passRate}) disagrees with passes/trials (${computedPassRate})`);
      }
    }
    const computedPassAtK = passes > 0 ? 1 : 0;
    if (scenario.passAtK !== computedPassAtK) {
      errors.push(`scenario ${scenario.id}: recorded passAtK (${scenario.passAtK}) disagrees with (passes > 0 ? 1 : 0) = ${computedPassAtK}`);
    }
  }

  return errors;
}

/** The pack-level document form of `<pack>/governance/eval.json` — one `EvalReport` per skill the pack ships, keyed by `report.skillId` (flow 314, W4 Wave 4). Distinguished from the single-report form by its `reports` array field. */
export interface PackEvalDocument {
  readonly schemaVersion: "1.0.0";
  readonly reports: readonly EvalReport[];
}

function isPackEvalDocument(value: unknown): value is PackEvalDocument {
  return typeof value === "object" && value !== null && Array.isArray((value as { reports?: unknown }).reports);
}

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort();
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = sortedStrings(a);
  const sb = sortedStrings(b);
  return sa.length === sb.length && sa.every((value, index) => value === sb[index]);
}

/**
 * Evaluates ONE skill's report from a pack-level document against the
 * stable-pack gate's requirements (flow 314, W4 Wave 4 dispatch, hardened
 * flow 314 review round 1 — R1-3/R1-11/R1-15): the report must validate
 * against its own contract (`validateEvalReport`), carry verdict `"pass"`,
 * evidence `"authored"`, strictness `"high"` with `trials >= PACK_MIN_TRIALS`,
 * `scope: "bundled"`, a non-empty `runner`/`model`, a `skillDigest` matching
 * the skill's CURRENT `SKILL.md`+`evals.json` on disk, behavior-scenario ids
 * and trigger prompts matching the current `evals.json` exactly, at least one
 * RAN behavior scenario, and every RAN behavior scenario clearing
 * `PACK_BEHAVIOR_PASS_FLOOR`. Returns a reason string naming the skill on any
 * gap, or `undefined` when the skill's report clears every requirement. Never
 * throws — a malformed/missing `SKILL.md`/`evals.json` on the skill side is
 * reported as a named failure reason, same as a malformed report.
 */
export interface StablePackGateOptions {
  /** Overrides the catalog the trigger re-score runs against — tests inject a fixture catalog here instead of relying on the real bundled tree. Defaults to `loadSkillCatalog(process.cwd(), { scope: "bundled" })`. When given explicitly, it is trusted AS-IS (including whatever entry, or lack of one, it carries for the skill under gate) — a caller that wants full control over the skill's own indexed trigger text (to simulate catalog drift, say) gets it verbatim. When omitted, the skill's own current entry is instead read live from its `SKILL.md` on disk (`currentSkillCatalogEntry`) and layered over this catalog, so a caller need not hand-build one just to make the gate's live re-score find the skill it is gating. */
  readonly catalog?: readonly CatalogEntry[];
}

/** R1-15 (flow 316 fix1): the catalog `checkPackEvalDocument` resolved ONCE for the whole pack (`options.catalog ?? loadSkillCatalog(bundled)`), threaded down instead of every skill in the pack re-loading it — plus whether it was an explicit override (see `StablePackGateOptions.catalog`'s doc comment for why that changes how the skill's own entry is resolved). */
interface ResolvedGateCatalog {
  readonly catalog: readonly CatalogEntry[];
  readonly explicit: boolean;
}

function checkSkillReportForPackGate(
  packDir: string,
  packId: string,
  name: string,
  report: EvalReport | undefined,
  resolvedCatalog: ResolvedGateCatalog,
): string | undefined {
  const skillId = `${packId}/${name}`;
  if (report === undefined) {
    return `no eval report for skill "${skillId}"`;
  }
  if (report.skillId !== skillId) {
    return `report for "${skillId}" carries a mismatched skillId "${report.skillId}"`;
  }
  let errors: string[];
  try {
    errors = validateEvalReport(report);
  } catch (error) {
    return `skill "${skillId}": eval report could not be validated: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (errors.length > 0) {
    return `skill "${skillId}": eval report fails its own contract: ${errors.join("; ")}`;
  }
  if (report.verdict !== "pass") {
    return `skill "${skillId}": eval report verdict is "${report.verdict}", not "pass"`;
  }
  if (report.evidence !== "authored") {
    return `skill "${skillId}": eval report evidence is "${report.evidence}", not "authored"`;
  }
  if (report.strictness !== "high") {
    return `skill "${skillId}": eval report strictness is "${report.strictness}", not "high"`;
  }
  if (report.trials < PACK_MIN_TRIALS) {
    return `skill "${skillId}": eval report trials ${report.trials} is below the pack minimum ${PACK_MIN_TRIALS}`;
  }
  if (report.scope !== "bundled") {
    return `skill "${skillId}": eval report scope is ${JSON.stringify(report.scope)}, not "bundled"`;
  }
  if (typeof report.runner !== "string" || report.runner.length === 0) {
    return `skill "${skillId}": eval report is missing a non-empty "runner"`;
  }
  if (typeof report.model !== "string" || report.model.length === 0) {
    return `skill "${skillId}": eval report is missing a non-empty "model"`;
  }
  // Flow 316: the runner that scored the deterministic checks must be
  // pinned — a forged/unapproved (runner, model) pair never clears the
  // gate, regardless of how clean the rest of the report looks.
  if (!isAllowlistedRunner(report.runner, report.model)) {
    return `skill "${skillId}": eval report runner/model "${report.runner}"/"${report.model}" is not an allowlisted gate runner`;
  }

  const skillDir = path.join(packDir, "skills", name);
  const skillMdPath = path.join(skillDir, "SKILL.md");
  if (!existsSync(skillMdPath)) {
    return `skill "${skillId}": SKILL.md is missing at ${skillMdPath}`;
  }

  let currentDigest: string;
  try {
    currentDigest = computeSkillEvalDigest(skillDir);
  } catch (error) {
    return `skill "${skillId}": could not compute the current eval digest: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (report.skillDigest !== currentDigest) {
    return `skill "${skillId}": eval report skillDigest is stale — SKILL.md or evals.json has changed since it was recorded`;
  }

  let spec: EvalSpecFile | undefined;
  try {
    spec = readEvalSpec(skillMdPath);
  } catch (error) {
    return `skill "${skillId}": evals.json could not be read: ${error instanceof Error ? error.message : String(error)}`;
  }

  const currentBehaviorIds = (spec?.scenarios ?? []).map((scenario) => scenario.id);
  const reportBehaviorIds = report.scenarios.filter((scenario) => scenario.kind === "behavior").map((scenario) => scenario.id);
  if (!sameStringSet(currentBehaviorIds, reportBehaviorIds)) {
    return `skill "${skillId}": eval report behavior-scenario ids do not match the skill's current evals.json`;
  }

  const currentPositives = spec?.triggers?.positive ?? [];
  const reportPositives = report.scenarios.filter((scenario) => scenario.kind === "trigger-positive").map((scenario) => scenario.prompt);
  if (!sameStringSet(currentPositives, reportPositives)) {
    return `skill "${skillId}": eval report trigger-positive prompts do not match the skill's current evals.json`;
  }

  const currentNegatives = spec?.triggers?.negative ?? [];
  const reportNegatives = report.scenarios.filter((scenario) => scenario.kind === "trigger-negative").map((scenario) => scenario.prompt);
  if (!sameStringSet(currentNegatives, reportNegatives)) {
    return `skill "${skillId}": eval report trigger-negative prompts do not match the skill's current evals.json`;
  }

  const ranBehaviorScenarios = report.scenarios.filter(
    (scenario) => scenario.kind === "behavior" && scenario.status === "ran",
  );
  if (ranBehaviorScenarios.length === 0) {
    return `skill "${skillId}": eval report has zero ran behavior scenarios`;
  }

  // Flow 317 (FU2): every RAN behavior scenario came from a `--runner`
  // completion (there is no other way for a behavior scenario to reach
  // `status: "ran"`), so the report must also have run under the CURRENT
  // runner system note — an old recording from before the "answer in text,
  // no tools" note was added proves nothing about whether today's runner
  // note actually stops a tool/shell-call answer. Mirrors the
  // `judgePromptVersion` check below for judge scenarios.
  if (report.runnerPromptVersion !== RUNNER_PROMPT_VERSION) {
    return `skill "${skillId}": eval report runnerPromptVersion "${report.runnerPromptVersion}" is not the current runner prompt version "${RUNNER_PROMPT_VERSION}"`;
  }
  // R1-1 (flow 316 fix1): the pack minimum applies to every RAN behavior
  // scenario individually, not just the report's own top-level `trials`
  // field — a report could previously declare a healthy top-level `trials`
  // while one scenario's own `trials` sat below the pack minimum.
  const belowMinTrials = ranBehaviorScenarios.find((scenario) => scenario.trials < PACK_MIN_TRIALS);
  if (belowMinTrials !== undefined) {
    return `skill "${skillId}": behavior scenario "${belowMinTrials.id}" trials ${belowMinTrials.trials} is below the pack minimum ${PACK_MIN_TRIALS}`;
  }

  // Flow 316: when the CURRENT evals.json carries any judge scenario, the
  // judge that scored it must also be pinned, and the report must have run
  // against the CURRENT judge prompt text (an old recording under a
  // superseded prompt version proves nothing about the current one).
  const specHasJudgeScenario = (spec?.scenarios ?? []).some((scenario) => scenario.expected_behavior.some((expected) => expected.grader === "judge"));
  if (specHasJudgeScenario) {
    if (!isAllowlistedJudge(report.judge, report.judgeModel)) {
      return `skill "${skillId}": eval report judge/judgeModel "${report.judge}"/"${report.judgeModel}" is not an allowlisted gate judge`;
    }
    if (report.judgePromptVersion !== JUDGE_PROMPT_VERSION) {
      return `skill "${skillId}": eval report judgePromptVersion "${report.judgePromptVersion}" is not the current judge prompt version "${JUDGE_PROMPT_VERSION}"`;
    }
  }

  // Flow 316: every ran behavior scenario must carry re-gradable evidence,
  // and that evidence must actually be internally consistent — a report
  // whose `output`, `deterministic`, `judge`, or `passed` was tampered with
  // after recording is refused here, not trusted at face value.
  const missingTrialRecords = ranBehaviorScenarios.find((scenario) => scenario.trialRecords === undefined || scenario.trialRecords.length === 0);
  if (missingTrialRecords !== undefined) {
    return `skill "${skillId}": behavior scenario "${missingTrialRecords.id}" is missing trialRecords`;
  }
  const regradeErrors = regradeRecordedReport(report, spec);
  if (regradeErrors.length > 0) {
    return `skill "${skillId}": recorded report failed regrade: ${regradeErrors.join("; ")}`;
  }

  // R1-1: the pack floor is enforced from the trial RECORDS directly (what
  // `regradeRecordedReport` just proved consistent with `passes`/`trials`),
  // not from the report's own self-declared `passRate` — belt-and-suspenders
  // alongside the `regradeRecordedReport` check above, which already
  // requires `passRate` to equal `passes / trials` recomputed from the same
  // records.
  const belowFloor = ranBehaviorScenarios.find((scenario) => {
    const records = scenario.trialRecords ?? [];
    const recordPassRate = records.length > 0 ? records.filter((record) => record.passed).length / records.length : 0;
    return recordPassRate < PACK_BEHAVIOR_PASS_FLOOR;
  });
  if (belowFloor !== undefined) {
    return `skill "${skillId}": behavior scenario "${belowFloor.id}" passRate ${belowFloor.passRate} is below the pack floor ${PACK_BEHAVIOR_PASS_FLOOR}`;
  }

  // R1-3 (flow 316 fix1): trigger scoring is deterministic, offline and
  // cheap — `scoreTriggerScenarios` is the exact function `evalSkill` itself
  // used to score it. There is no reason to trust a report's own recorded
  // trigger results at all: they are ALWAYS re-scored live against the
  // current bundled catalog (or `options.catalog`, for a test's full
  // control), never conditionally on whether `catalogDigest` happens to
  // still match — a self-computable digest is trivial for a forger to keep
  // current while editing everything else. `catalogDigest` is kept on the
  // report as informational context only, to word the failure reason.
  if (typeof report.catalogDigest !== "string" || report.catalogDigest.length === 0) {
    return `skill "${skillId}": eval report is missing a "catalogDigest"`;
  }
  const { catalog: baseCatalog, explicit: explicitCatalog } = resolvedCatalog;
  const rescoreCatalog: readonly CatalogEntry[] = explicitCatalog
    ? baseCatalog
    : [currentSkillCatalogEntry(skillId, skillDir), ...baseCatalog.filter((entry) => entry.id !== skillId)];
  const skillEntry = rescoreCatalog.find((entry) => entry.id === skillId);
  if (skillEntry === undefined) {
    return `skill "${skillId}": the skill could not be found in the current catalog to re-score its trigger scenarios`;
  }
  const currentCatalogDigest = computeCatalogTriggerDigest(rescoreCatalog);
  const rescored = scoreTriggerScenarios(skillEntry, rescoreCatalog, spec, report.strictness);
  const recordedTriggerScenarios = report.scenarios.filter((scenario) => scenario.kind === "trigger-positive" || scenario.kind === "trigger-negative");
  const changedScenario = rescored.scenarios.find((freshScenario) => {
    const recorded = recordedTriggerScenarios.find((scenario) => scenario.id === freshScenario.id);
    return recorded === undefined || recorded.passRate !== freshScenario.passRate;
  });
  const triggerAccuracyChanged =
    rescored.triggerAccuracy.truePositive !== report.triggerAccuracy.truePositive ||
    rescored.triggerAccuracy.falsePositive !== report.triggerAccuracy.falsePositive ||
    rescored.triggerAccuracy.positives !== report.triggerAccuracy.positives ||
    rescored.triggerAccuracy.negatives !== report.triggerAccuracy.negatives;
  if (changedScenario !== undefined || triggerAccuracyChanged) {
    const digestNote = report.catalogDigest === currentCatalogDigest ? "" : " (catalogDigest is stale)";
    const detail = changedScenario !== undefined ? `"${changedScenario.id}" now scores differently` : "triggerAccuracy disagrees with a live re-score of the current catalog";
    return `skill "${skillId}": trigger results changed since recording${digestNote} — ${detail}`;
  }

  return undefined;
}

/**
 * The pack-level branch of `checkStablePackGate` (flow 314, W4 Wave 4;
 * hardened flow 314 review round 1 — R1-3/R1-4/R1-5): reads
 * `<packDir>/pack.json`, requires `id` to be a non-empty string equal to
 * `basename(packDir)` (R1-3), requires `skills` to be an object whose every
 * bucket is a `string[]` — never iterated blindly, so a non-array bucket
 * (e.g. a stray number) is a named `"fail"`, never a thrown `TypeError`
 * (R1-5) — and requires the resulting skill-name union to be non-empty
 * (R1-4). Then, for EVERY skill name across all buckets, requires a report in
 * `doc.reports` whose `skillId` is `"<pack.id>/<name>"` and clears
 * `checkSkillReportForPackGate`. Any gap fails the whole gate, naming the
 * offending skill.
 */
function checkPackEvalDocument(packDir: string, doc: PackEvalDocument, options: StablePackGateOptions): StablePackGateResult {
  const packJsonPath = path.join(packDir, "pack.json");
  let pack: { readonly id?: unknown; readonly skills?: unknown };
  try {
    pack = JSON.parse(readFileSync(packJsonPath, "utf8")) as typeof pack;
  } catch (error) {
    return { status: "fail", reason: `pack.json could not be read/parsed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof pack.id !== "string" || pack.id.length === 0) {
    return { status: "fail", reason: `pack.json "id" must be a non-empty string` };
  }
  const expectedId = path.basename(packDir);
  if (pack.id !== expectedId) {
    return { status: "fail", reason: `pack.json id "${pack.id}" does not match its directory name "${expectedId}"` };
  }
  if (typeof pack.skills !== "object" || pack.skills === null || Array.isArray(pack.skills)) {
    return { status: "fail", reason: `pack.json "skills" must be an object` };
  }

  const skillNames = new Set<string>();
  for (const [bucket, names] of Object.entries(pack.skills as Record<string, unknown>)) {
    if (!Array.isArray(names) || !names.every((name) => typeof name === "string")) {
      return { status: "fail", reason: `pack.json skills."${bucket}" must be an array of strings` };
    }
    for (const name of names) skillNames.add(name);
  }
  if (skillNames.size === 0) {
    return { status: "fail", reason: `pack.json "skills" lists no skills` };
  }

  // R1-15 (flow 316 fix1): the bundled catalog is loaded ONCE per pack, not
  // once per skill — `loadSkillCatalog(..., {scope: "bundled"})` walks the
  // WHOLE bundled tree, so a pack listing several skills used to re-walk it
  // once per skill for no reason (the result is cwd-independent, so it can
  // never differ between skills in the same gate call).
  const resolvedCatalog: ResolvedGateCatalog =
    options.catalog !== undefined
      ? { catalog: options.catalog, explicit: true }
      : { catalog: loadSkillCatalog(process.cwd(), { scope: "bundled" }), explicit: false };

  const reportsBySkillId = new Map(doc.reports.map((report) => [report.skillId, report] as const));
  for (const name of [...skillNames].sort()) {
    const reason = checkSkillReportForPackGate(packDir, pack.id, name, reportsBySkillId.get(`${pack.id}/${name}`), resolvedCatalog);
    if (reason !== undefined) {
      return { status: "fail", reason };
    }
  }
  return { status: "pass" };
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
export function checkStablePackGate(packDir: string, stability: string, options: StablePackGateOptions = {}): StablePackGateResult {
  if (stability !== "stable") {
    return { status: "not-applicable", reason: `pack stability is "${stability}", not "stable"` };
  }
  const evalPath = path.join(packDir, "governance", "eval.json");
  if (!existsSync(evalPath)) {
    return { status: "fail", reason: "governance/eval.json is missing" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(evalPath, "utf8"));
  } catch (error) {
    return { status: "fail", reason: `governance/eval.json could not be parsed: ${error instanceof Error ? error.message : String(error)}` };
  }
  // Flow 314, W4 Wave 4: a PACK-LEVEL eval.json (`{ schemaVersion, reports:
  // EvalReport[] }`) is distinguished from the original single-report form by
  // its `reports` array field — every skill pack.json lists must carry a
  // passing, authored report with >=1 ran behavior scenario, each clearing
  // `PACK_BEHAVIOR_PASS_FLOOR`.
  //
  // R1-4 (flow 314 review round 1): the original single-report form used to
  // keep working here too — a stable STACK PACK could ship one report for
  // ANY one skill, with trigger scenarios only and no behavior scenario at
  // all, and it counted as gate-cleared. `checkStablePackGate` is only ever
  // called with a stack-pack directory (both callers, `agents/verify.ts` and
  // `agents-catalog.ts`, resolve one from `stacks/*`) — a stack pack MUST
  // ship the pack-level form, so the legacy shape is now a named failure
  // rather than a second, weaker code path.
  if (!isPackEvalDocument(parsed)) {
    return { status: "fail", reason: "stack packs must ship a pack-level eval document" };
  }
  try {
    return checkPackEvalDocument(packDir, parsed, options);
  } catch (error) {
    // R1-5 (flow 314 review round 1): `checkPackEvalDocument` and everything
    // it calls now validate shapes before iterating them (no bare `for...of`
    // over an unchecked `pack.skills` bucket, no unchecked property access),
    // but this call stays wrapped regardless — the gate's own doc comment
    // says it "must never let an unexpected exception propagate", and that
    // must hold even against a future edit to this function that reintroduces
    // an unchecked path.
    return { status: "fail", reason: `governance/eval.json could not be validated: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// ---------------------------------------------------------------------------
// Live re-judge sampler (flow 317, FU3)
// ---------------------------------------------------------------------------
//
// THREAT MODEL: `checkStablePackGate`/`regradeRecordedReport` prove a
// recorded report is INTERNALLY CONSISTENT — the same `output` really does
// recompute to the same `deterministic` results and the same `passed`
// conclusion. They cannot prove the recorded JUDGE VERDICT itself was ever a
// genuine live grading and not, say, a hand-edited `judge-recordings.json`
// (`judge-recordings.ts`'s own doc comment already discloses this: "a
// recording is a hand-writable file"), and even a genuinely live-graded
// verdict can drift over time if the judge PROVIDER's own model weights
// change under a pinned name (flow 316 review round 1 observed the live
// judge disagreeing with itself across otherwise-identical calls on
// borderline answers). Neither gap is closeable offline. `reverifyPackSample`
// is the closest available check: it re-runs a RANDOM SAMPLE of a pack's own
// recorded trial outputs through the CURRENT live judge and reports where the
// live verdict disagrees with what was recorded — evidence a human (or a
// scheduled job) can act on, not a gate `checkStablePackGate` itself enforces
// (a single flaky disagreement must not fail CI; see the threshold note
// below).

/** One sampled trial whose live re-judge verdict disagrees with what the pack's `governance/eval.json` recorded. */
export interface ReverifyDisagreement {
  readonly skillId: string;
  readonly scenarioId: string;
  /** 0-based index into that scenario's `trialRecords`. */
  readonly trialIndex: number;
  readonly recordedVerdict: JudgeVerdict["verdict"];
  readonly liveVerdict: JudgeVerdict["verdict"];
  readonly liveReason: string;
}

/**
 * A judge is non-deterministic on identical input (flow 316 review round 1;
 * `judge-check`'s own `--samples` default exists for the same reason) — one
 * sampled disagreement out of a handful is expected noise, not evidence the
 * judge has drifted. `--reverify` exits non-zero only when the disagreement
 * RATE clears this floor, documented here rather than left as a bare
 * literal at the call site. 20% is deliberately generous: `judge-check`'s
 * own anti-gaming proof requires the canned known-right/known-wrong/vague/
 * subtle-wrong answers to agree on EVERY sample, because those are
 * calibration fixtures chosen to be unambiguous; a `--reverify` sample is
 * real recorded trial output, which legitimately includes borderline
 * answers a careful judge may reasonably split on run to run (R2-1, flow
 * 316 review round 2, is exactly such a case). A rate above this floor is
 * no longer "a couple of borderline calls" — it says the judge is not
 * reproducing its own past verdicts often enough to trust unattended.
 */
export const REVERIFY_DISAGREEMENT_THRESHOLD = 0.2;

export interface ReverifyPackResult {
  readonly packId: string;
  /** How many trial records the pack's `governance/eval.json` actually carries a judge verdict for — the population `sampleSize` is drawn from. */
  readonly totalEligible: number;
  /** `min(options.sampleSize ?? default, totalEligible)` — the sample actually re-judged. */
  readonly sampleSize: number;
  readonly disagreements: readonly ReverifyDisagreement[];
  /** `disagreements.length / sampleSize`, `0` when `sampleSize` is `0` (nothing to disagree about). */
  readonly disagreementRate: number;
  /** `disagreementRate > REVERIFY_DISAGREEMENT_THRESHOLD` — what the CLI maps to a non-zero exit code. */
  readonly thresholdExceeded: boolean;
}

export interface ReverifyPackOptions {
  /** How many eligible trials to re-judge. Defaults to 10 — enough to make a single flaky call a small fraction of the sample, without the live-judge spend of re-checking everything. */
  readonly sampleSize?: number;
  /** Injectable RNG for deterministic sampling in tests — defaults to `Math.random`. Uniform in `[0, 1)`, same contract `Math.random` itself has. */
  readonly random?: () => number;
}

interface EligibleTrial {
  readonly skillId: string;
  readonly scenarioId: string;
  readonly trialIndex: number;
  readonly output: string;
  readonly recordedVerdict: JudgeVerdict["verdict"];
  readonly specScenario: EvalScenarioSpec;
}

/** Fisher-Yates partial shuffle: returns the first `count` elements of `items` in random order, using `random()` for each swap — `count >= items.length` returns every element, shuffled. */
function sampleWithoutReplacement<T>(items: readonly T[], count: number, random: () => number): T[] {
  const pool = [...items];
  const n = Math.min(count, pool.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    const temp = pool[i] as T;
    pool[i] = pool[j] as T;
    pool[j] = temp;
  }
  return pool.slice(0, n);
}

/**
 * Re-judges a random sample of `packDir`'s recorded trial outputs (from
 * `governance/eval.json`, the pack-level document) live against `judge`, and
 * reports where the live verdict disagrees with what was recorded. Read-only
 * — never writes `governance/eval.json` or any other file; a caller that
 * wants to ACT on a disagreement (re-record, investigate, escalate) does so
 * separately.
 *
 * Every RAN behavior scenario with a judge-graded expectation is eligible,
 * matched against the skill's CURRENT `evals.json` (never the report's own
 * copy of the scenario, which a stale report could have drifted from) by
 * scenario id — a trial whose scenario id no longer exists in the current
 * spec is skipped (named as such would require touching every skill's
 * report shape for a case `checkStablePackGate` already refuses outright;
 * `--reverify` is a diagnostic, not the gate itself, so it degrades instead
 * of throwing).
 */
export async function reverifyPackSample(packDir: string, judge: Judge, options: ReverifyPackOptions = {}): Promise<ReverifyPackResult> {
  const packId = path.basename(packDir);
  const evalPath = path.join(packDir, "governance", "eval.json");
  const parsed = JSON.parse(readFileSync(evalPath, "utf8")) as unknown;
  if (!isPackEvalDocument(parsed)) {
    throw new Error(`${evalPath}: not a pack-level eval document (missing "reports" array)`);
  }

  const specCache = new Map<string, EvalSpecFile | undefined>();
  const eligible: EligibleTrial[] = [];
  for (const report of parsed.reports) {
    const slash = report.skillId.indexOf("/");
    const skillName = slash >= 0 ? report.skillId.slice(slash + 1) : report.skillId;
    const skillMdPath = path.join(packDir, "skills", skillName, "SKILL.md");
    if (!specCache.has(report.skillId)) {
      specCache.set(report.skillId, existsSync(skillMdPath) ? readEvalSpec(skillMdPath) : undefined);
    }
    const spec = specCache.get(report.skillId);
    const specScenarios = new Map((spec?.scenarios ?? []).map((scenario) => [scenario.id, scenario] as const));

    for (const scenario of report.scenarios) {
      if (scenario.kind !== "behavior" || scenario.status !== "ran" || scenario.trialRecords === undefined) continue;
      const specScenario = specScenarios.get(scenario.id);
      if (specScenario === undefined) continue; // no longer in the current evals.json — nothing to re-judge against.
      scenario.trialRecords.forEach((record, trialIndex) => {
        if (record.judge === undefined) return; // no judge expectation on this scenario — nothing to re-judge.
        eligible.push({
          skillId: report.skillId,
          scenarioId: scenario.id,
          trialIndex,
          output: record.output,
          recordedVerdict: record.judge.verdict,
          specScenario,
        });
      });
    }
  }

  const random = options.random ?? Math.random;
  const sampled = sampleWithoutReplacement(eligible, options.sampleSize ?? 10, random);

  const disagreements: ReverifyDisagreement[] = [];
  for (const trial of sampled) {
    const grade = await gradeScenarioAnswer(trial.output, trial.specScenario, judge);
    const liveVerdict = grade.judge?.verdict ?? "fail";
    if (liveVerdict !== trial.recordedVerdict) {
      disagreements.push({
        skillId: trial.skillId,
        scenarioId: trial.scenarioId,
        trialIndex: trial.trialIndex,
        recordedVerdict: trial.recordedVerdict,
        liveVerdict,
        liveReason: grade.judge?.reason ?? "",
      });
    }
  }

  const sampleSize = sampled.length;
  const disagreementRate = sampleSize > 0 ? disagreements.length / sampleSize : 0;
  return {
    packId,
    totalEligible: eligible.length,
    sampleSize,
    disagreements,
    disagreementRate,
    thresholdExceeded: disagreementRate > REVERIFY_DISAGREEMENT_THRESHOLD,
  };
}
