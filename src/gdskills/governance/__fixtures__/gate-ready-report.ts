// Flow 316, T5 (moved to `__fixtures__/` in fix1, R1-10) — a shared fixture
// builder for tests that need a gate-CLEARING pack-level `EvalReport` on
// disk. Several test suites (`stack-packs.test.ts`, `src/agents/verify.test.ts`,
// `src/agents/generate.test.ts`, `src/commands/agents-catalog-commands.test.ts`)
// each hand-built their own "minimal passing report" fixture before the
// hardened gate existed; now that the gate also requires an allowlisted
// runner/judge, per-trial `trialRecords`, a `promptSha256` per record, and a
// live trigger re-score, that shape is nontrivial enough to duplicate five
// times. This is the one place it is built.
//
// R1-10 (flow 316 review round 1): this module fabricates outputs and
// judge/trigger verdicts that satisfy `checkStablePackGate` — exactly the
// shape a forger would want. It must never ship as production code. It lives
// under `__fixtures__/` (a directory already excluded from what `package.json`
// publishes, matching the convention `src/gdskills/install.test.ts` and
// others already use for test-only data under a sibling `__fixtures__/`), is
// imported ONLY by `.test.ts` files, and is never referenced from `eval.ts`
// or any other shipped module.

import { createHash } from "node:crypto";
import type { CatalogEntry } from "../catalog-index";
import { loadSkillCatalog } from "../catalog-index";
import {
  computeCatalogTriggerDigest,
  computeSkillEvalDigest,
  currentSkillCatalogEntry,
  gradeDeterministic,
  PACK_MIN_TRIALS,
  scoreTriggerScenarios,
  type EvalReport,
  type EvalScenarioResult,
  type EvalScenarioSpec,
  type EvalSpecFile,
  type TrialRecord,
} from "../eval";
import { JUDGE_PROMPT_VERSION, type JudgeVerdict } from "../judge";

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
  /**
   * Defaults to the skill's own CURRENT entry (read live from `skillDir`'s
   * `SKILL.md`, mirroring what the hardened gate itself does when no
   * `catalog` override is given — see `eval.ts`'s `StablePackGateOptions`
   * doc comment) layered over the real bundled catalog. Pass an explicit
   * catalog to control trigger scoring fully (e.g. to simulate catalog
   * drift) — the gate call this report is checked against must then be
   * given the SAME explicit catalog, or the two will legitimately disagree
   * about what the current trigger results are.
   */
  readonly catalog?: readonly CatalogEntry[];
}

/**
 * Builds a pack-level `EvalReport` that clears every check
 * `checkSkillReportForPackGate` enforces: an allowlisted runner AND (when
 * `evalSpec` carries a judge scenario) an allowlisted judge at the current
 * `JUDGE_PROMPT_VERSION`, a `skillDigest` matching `skillDir`'s actual files,
 * behavior-scenario ids/trigger prompts matching `evalSpec` exactly,
 * `trialRecords` (with `promptSha256`) for every behavior scenario that
 * regrade clean, and trigger scenarios HONESTLY scored via
 * `scoreTriggerScenarios` against the same catalog the gate's own live
 * re-score (flow 316 fix1, R1-3) will use — a fabricated always-pass trigger
 * result would no longer clear the gate, since the gate never trusts a
 * recorded trigger result without re-deriving it.
 */
export function buildGateReadyReport(options: GateReadyReportOptions): EvalReport {
  const trials = options.trials ?? PACK_MIN_TRIALS;
  const skillId = `${options.packId}/${options.skillName}`;
  const skillDigest = computeSkillEvalDigest(options.skillDir);
  const catalog: readonly CatalogEntry[] =
    options.catalog ??
    [currentSkillCatalogEntry(skillId, options.skillDir), ...loadSkillCatalog(process.cwd(), { scope: "bundled" }).filter((entry) => entry.id !== skillId)];
  const catalogDigest = computeCatalogTriggerDigest(catalog);
  const skillEntry = catalog.find((entry) => entry.id === skillId);
  if (skillEntry === undefined) {
    throw new Error(`buildGateReadyReport: skill "${skillId}" is not present in its own gate-ready catalog`);
  }
  const hasAnyJudgeScenario = (options.evalSpec.scenarios ?? []).some((scenario) =>
    scenario.expected_behavior.some((expected) => expected.grader === "judge"),
  );

  const triggerScore = scoreTriggerScenarios(skillEntry, catalog, options.evalSpec, "high");

  const behaviorScenarios: EvalScenarioResult[] = (options.evalSpec.scenarios ?? []).map((scenario) => {
    const { output, judge } = fixtureAnswerFor(scenario);
    const deterministicExpectations = scenario.expected_behavior.filter((expected) => expected.grader !== "judge");
    const deterministic = deterministicExpectations.map((expected) => gradeDeterministic(output, expected) === true);
    const passed = deterministic.every((value) => value) && (judge === undefined || judge.verdict === "pass");
    const record: TrialRecord = {
      output,
      outputSha256: sha256Hex(output),
      promptSha256: sha256Hex(scenario.prompt),
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

  const behaviorPassOk = behaviorScenarios.length > 0 && behaviorScenarios.every((scenario) => scenario.passRate === 1);
  const triggersOk =
    triggerScore.triggerAccuracy.positives > 0 &&
    triggerScore.triggerAccuracy.negatives > 0 &&
    triggerScore.triggerAccuracy.truePositive === triggerScore.triggerAccuracy.positives &&
    triggerScore.triggerAccuracy.falsePositive === 0;

  return {
    schemaVersion: "1.0.0",
    skillId,
    strictness: "high",
    trials,
    triggerAccuracy: triggerScore.triggerAccuracy,
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
    scenarios: [...triggerScore.scenarios, ...behaviorScenarios],
    verdict: triggersOk && behaviorPassOk ? "pass" : "fail",
  };
}
