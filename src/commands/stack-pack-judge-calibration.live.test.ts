// Flow 316 — the LIVE counterpart to
// `src/gdskills/stack-pack-eval-integrity.test.ts`'s anti-gaming (AG) block:
// the same invariant, but graded by a real DeepSeek call through
// `buildEvalJudge` instead of a recorded verdict replayed offline.
//
// WHY THIS FILE LIVES HERE, NOT UNDER `src/gdskills`
//
// `buildEvalJudge` (`./model-eval-judge.ts`) wraps `runModelTurn`
// (`src/harness/provider/single-turn.ts`, client zone) to make a real
// network call. `src/gdskills` is a core-zone module
// (`src/lib/import-zones.ts`'s `ZONE_TABLE`), and core never imports
// client/adapter — no exception, per that table's own header comment. This
// test needs a live judge, so it lives in `src/commands` (adapter zone,
// already free to import both core and client) rather than importing an
// adapter module from a core-zone test file.
//
// OPT-IN, NEVER BY ACCIDENT
//
// This suite makes real network calls against DeepSeek and costs real
// tokens/money — it runs ONLY when `KERYX_LIVE_JUDGE=1` is set in the
// environment. Every test is registered `skipIf` that flag is absent, so a
// normal `bun test` run (CI included) never touches the network here.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { defaultBundledRoot } from "../gdskills/bundled-eval";
import { antiGamingAnswers, gradeScenarioAnswer, type JudgeExpectation } from "../gdskills/governance/judge";
import type { EvalScenarioSpec } from "../gdskills/governance/eval";
import { buildEvalJudge } from "./model-eval-judge";

const LIVE = process.env.KERYX_LIVE_JUDGE === "1";
const STACKS_ROOT = path.join(defaultBundledRoot(), "stacks");

// A live grading round-trip is slow (a real completion, plus this module's
// own one-retry-on-unparseable-verdict policy) — generous relative to the
// default bun:test timeout, but still bounded so a genuinely hung request
// fails the run instead of hanging it.
const LIVE_TEST_TIMEOUT_MS = 60_000;

function judgeExpectationOf(scenario: EvalScenarioSpec): JudgeExpectation | undefined {
  return scenario.expected_behavior.find((expected): expected is JudgeExpectation => expected.grader === "judge");
}

interface PackSkillScenarios {
  readonly pack: string;
  readonly skill: string;
  readonly scenarios: readonly EvalScenarioSpec[];
}

function collectJudgeScenarios(): PackSkillScenarios[] {
  const out: PackSkillScenarios[] = [];
  if (!existsSync(STACKS_ROOT)) return out;
  for (const pack of readdirSync(STACKS_ROOT).sort()) {
    const skillsDir = path.join(STACKS_ROOT, pack, "skills");
    if (!existsSync(skillsDir)) continue;
    for (const skill of readdirSync(skillsDir).sort()) {
      const evalsPath = path.join(skillsDir, skill, "evals.json");
      if (!existsSync(evalsPath)) continue;
      let parsed: { readonly scenarios?: readonly EvalScenarioSpec[] };
      try {
        parsed = JSON.parse(readFileSync(evalsPath, "utf8")) as { scenarios?: readonly EvalScenarioSpec[] };
      } catch {
        parsed = {};
      }
      const judgeScenarios = (parsed.scenarios ?? []).filter((scenario) => judgeExpectationOf(scenario) !== undefined);
      if (judgeScenarios.length > 0) out.push({ pack, skill, scenarios: judgeScenarios });
    }
  }
  return out;
}

describe("stack-pack judge anti-gaming, LIVE against DeepSeek (KERYX_LIVE_JUDGE=1 only)", () => {
  const packSkillScenarios = LIVE ? collectJudgeScenarios() : [];
  const judge = LIVE ? buildEvalJudge("deepseek:deepseek-chat") : undefined;

  const describeFn = LIVE ? describe : describe.skip;

  describeFn("every stack-pack judge scenario, graded live", () => {
    for (const { pack, skill, scenarios } of packSkillScenarios) {
      for (const scenario of scenarios) {
        const label = `${pack}/${skill}#${scenario.id}`;
        // `antiGamingAnswers` returns all eight kinds — `empty`, `echo`,
        // `vague`, `known-wrong`, `subtle-wrong`, `injection`, `stuffed`,
        // `known-right` — unconditionally, iterated here exactly as
        // `stack-pack-eval-integrity.test.ts`'s offline AG block does. A
        // scenario whose `evals.json` has not yet been migrated to carry
        // `calibration.vague`/`calibration.subtle_wrong` (content authoring
        // is a separate, parallel task) yields the empty-string fallback for
        // those two kinds — grading that live would only re-prove the
        // `empty` kind's own short-circuit (no network call at all, since
        // `gradeScenarioAnswer` never reaches the judge for an empty
        // answer) under a misleading kind label, and burn no real request
        // either way, so it is skipped here the same way `judge-check`
        // itself skips it (`skills-governance.ts`'s own `judgeCheckCommand`).
        for (const answer of antiGamingAnswers(scenario)) {
          const isAuthoredCalibrationKind = answer.kind === "vague" || answer.kind === "subtle-wrong";
          if (isAuthoredCalibrationKind && answer.answer.trim().length === 0) continue;
          test(
            `AG(live) ${label} [${answer.kind}]: live verdict matches expect="${answer.expect}"`,
            async () => {
              const grade = await gradeScenarioAnswer(answer.answer, scenario, judge!);
              expect(grade.passed).toBe(answer.expect === "pass");
            },
            LIVE_TEST_TIMEOUT_MS,
          );
        }
      }
    }
  });

  if (!LIVE) {
    test("skipped: set KERYX_LIVE_JUDGE=1 to run the live DeepSeek anti-gaming check", () => {
      expect(LIVE).toBe(false);
    });
  }
});
