// Flow 316, T5 — a shared fixture builder for tests that need a
// gate-CLEARING pack-level `EvalReport` on disk. Several test suites
// (`stack-packs.test.ts`, `src/agents/verify.test.ts`,
// `src/agents/generate.test.ts`, `src/commands/agents-catalog-commands.test.ts`)
// each hand-built their own "minimal passing report" fixture before the
// hardened gate existed; now that the gate also requires an allowlisted
// runner/judge, per-trial `trialRecords`, and a `catalogDigest`, that shape
// is nontrivial enough to duplicate five times. This is the one place it is
// built.

import { createHash } from "node:crypto";
import type { CatalogEntry } from "./catalog-index";
import { loadSkillCatalog } from "./catalog-index";
import {
  computeCatalogTriggerDigest,
  computeSkillEvalDigest,
  gradeDeterministic,
  PACK_MIN_TRIALS,
  type EvalReport,
  type EvalScenarioResult,
  type EvalScenarioSpec,
  type EvalSpecFile,
  type TrialRecord,
} from "./eval";
import { JUDGE_PROMPT_VERSION, type JudgeVerdict } from "./judge";

/** The (runner, model) and (judge, judgeModel) pair `STACK_PACK_GATE_POLICY` allowlists — kept here too (not imported) so a fixture never accidentally tracks a policy change silently; a policy edit that leaves this fixture's pair off the allowlist is caught by the gate itself, loudly, the same way a real report's drift would be. */
const GATE_ALLOWLISTED_PROVIDER = "deepseek";
const GATE_ALLOWLISTED_MODEL = "deepseek-chat";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Builds an `output` string that satisfies every deterministic (non-judge) expectation on `scenario`, and a judge verdict when the scenario carries a judge expectation. Only `"contains"` and `"judge"` are exercised by the current fixture callers; `"not-contains"`/`"regex"` are satisfied trivially (an empty addition) since none of them are used against real fixtures today. */
function fixtureAnswerFor(scenario: EvalScenarioSpec): { readonly output: string; readonly judge?: JudgeVerdict } {
  const containsValues = scenario.expected_behavior
    .filter((expected) => expected.grader === "contains")
    .map((expected) => (expected as { readonly value: string }).value);
  const hasJudge = scenario.expected_behavior.some((expected) => expected.grader === "judge");
  const base = containsValues.length > 0 ? containsValues.join(" ") : "fixture output";
  const output = hasJudge && scenario.calibration !== undefined ? scenario.calibration.known_right : base;
  return hasJudge ? { output, judge: { verdict: "pass", reason: "fixture: known_right calibration" } } : { output };
}

export interface GateReadyReportOptions {
  readonly packId: string;
  readonly skillName: string;
  /** Absolute path to the skill's directory — must already hold the SAME `SKILL.md`/`evals.json` this report's `evalSpec` describes, so `computeSkillEvalDigest` agrees with what the gate recomputes. */
  readonly skillDir: string;
  readonly evalSpec: EvalSpecFile;
  readonly trials?: number;
  readonly recordedAt?: string;
  /** Defaults to the real bundled catalog — pass a fixture catalog to control `catalogDigest` independently of the shipped tree. */
  readonly catalog?: readonly CatalogEntry[];
}

/**
 * Builds a pack-level `EvalReport` that clears every check
 * `checkSkillReportForPackGate` enforces: an allowlisted runner AND (when
 * `evalSpec` carries a judge scenario) an allowlisted judge at the current
 * `JUDGE_PROMPT_VERSION`, a `skillDigest` matching `skillDir`'s actual files,
 * behavior-scenario ids/trigger prompts matching `evalSpec` exactly,
 * `trialRecords` for every behavior scenario that regrade clean, and a
 * `catalogDigest` matching the catalog passed in (the real bundled catalog
 * by default).
 */
export function buildGateReadyReport(options: GateReadyReportOptions): EvalReport {
  const trials = options.trials ?? PACK_MIN_TRIALS;
  const skillId = `${options.packId}/${options.skillName}`;
  const skillDigest = computeSkillEvalDigest(options.skillDir);
  const positives = options.evalSpec.triggers?.positive ?? [];
  const negatives = options.evalSpec.triggers?.negative ?? [];
  const catalog = options.catalog ?? loadSkillCatalog(process.cwd(), { scope: "bundled" });
  const catalogDigest = computeCatalogTriggerDigest(catalog);
  const hasAnyJudgeScenario = (options.evalSpec.scenarios ?? []).some((scenario) =>
    scenario.expected_behavior.some((expected) => expected.grader === "judge"),
  );

  const behaviorScenarios: EvalScenarioResult[] = (options.evalSpec.scenarios ?? []).map((scenario) => {
    const { output, judge } = fixtureAnswerFor(scenario);
    const deterministicExpectations = scenario.expected_behavior.filter((expected) => expected.grader !== "judge");
    const deterministic = deterministicExpectations.map((expected) => gradeDeterministic(output, expected) === true);
    const passed = deterministic.every((value) => value) && (judge === undefined || judge.verdict === "pass");
    const record: TrialRecord = {
      output,
      outputSha256: sha256Hex(output),
      deterministic,
      ...(judge !== undefined ? { judge } : {}),
      passed,
    };
    const trialRecords: TrialRecord[] = Array.from({ length: trials }, () => record);
    return {
      id: scenario.id,
      kind: "behavior",
      prompt: scenario.prompt,
      strictness: "high",
      trials,
      passes: passed ? trials : 0,
      passRate: passed ? 1 : 0,
      passAtK: passed ? 1 : 0,
      grader: scenario.expected_behavior.map((expected) => expected.grader).join("+") || "none",
      status: "ran",
      trialRecords,
    };
  });

  const triggerScenarios: EvalScenarioResult[] = [
    ...positives.map(
      (prompt, index): EvalScenarioResult => ({
        id: `trigger-positive-${index + 1}`,
        kind: "trigger-positive",
        prompt,
        strictness: "high",
        trials: 1,
        passes: 1,
        passRate: 1,
        passAtK: 1,
        grader: "trigger-rank-fork-family",
        status: "ran",
        deterministic: true,
      }),
    ),
    ...negatives.map(
      (prompt, index): EvalScenarioResult => ({
        id: `trigger-negative-${index + 1}`,
        kind: "trigger-negative",
        prompt,
        strictness: "high",
        trials: 1,
        passes: 1,
        passRate: 1,
        passAtK: 1,
        grader: "trigger-rank-fork-family",
        status: "ran",
        deterministic: true,
      }),
    ),
  ];

  const behaviorPassOk = behaviorScenarios.length > 0 && behaviorScenarios.every((scenario) => scenario.passRate === 1);

  return {
    schemaVersion: "1.0.0",
    skillId,
    strictness: "high",
    trials,
    triggerAccuracy: { truePositive: positives.length, falsePositive: 0, positives: positives.length, negatives: negatives.length },
    evidence: "authored",
    scope: "bundled",
    skillDigest,
    catalogDigest,
    runner: GATE_ALLOWLISTED_PROVIDER,
    model: GATE_ALLOWLISTED_MODEL,
    ...(hasAnyJudgeScenario
      ? { judge: GATE_ALLOWLISTED_PROVIDER, judgeModel: GATE_ALLOWLISTED_MODEL, judgePromptVersion: JUDGE_PROMPT_VERSION }
      : {}),
    recordedAt: options.recordedAt ?? new Date().toISOString(),
    scenarios: [...triggerScenarios, ...behaviorScenarios],
    verdict: positives.length > 0 && negatives.length > 0 && behaviorPassOk ? "pass" : "fail",
  };
}
