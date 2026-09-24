// Flow 314 review round 1 (dispatch 314-T17-A) — implements the "Eval
// integrity rules" (I1-I5) from
// scratchpad/f314/fix1-contract.md, driven by R1-1/R1-2's findings (skills
// hand-edited to fit their own graders, and graders weak enough to pass an
// empty or echoed answer). Every scenario in every
// `stacks/*/skills/*/evals.json` must:
//
//   I1. fail when graded against the empty answer "";
//   I2. fail when graded against the echo answer "Sure. You asked: <prompt>";
//   I3. carry at least one POSITIVE (`contains`/`regex`) expectation that
//       does NOT already match the prompt text itself — the answer must add
//       something the question didn't already say;
//   I4. share no 6-word sequence with its own skill's SKILL.md body (words
//       lowercased, split on `[a-z0-9]+`) — the eval question must not be
//       pasted into the skill as a worked example (R1-1's react-code-review
//       finding);
//   I5. its skill's SKILL.md must contain no answer-key phrasing
//       ("verbatim", "exact sentence", "open your answer", ...) telling the
//       model how to word its answer to trip the grader (R1-1's
//       nodejs-esm-migration/react-upgrade-migration findings).
//
// GRADING SEMANTICS: I1/I2 reuse `gradeExpectations` from `./governance/
// eval.ts` — the exact same "a scenario fails when ANY expectation fails"
// rule `evalSkill`'s own trial loop applies — rather than a second,
// independently-written grader that could quietly drift from the real one.
//
// CONTENT LANES ARE CONCURRENT: four other flow-314 workers are rewriting
// `SKILL.md`/`evals.json` under `stacks/*` while this file lands. A
// real-tree assertion below FAILING RIGHT NOW is expected — the important
// property this file guarantees is that the RULES THEMSELVES are exact,
// which the synthetic negative/positive fixtures (second describe block)
// pin independently of whatever the real tree currently contains.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { gradeExpectations, type EvalScenarioSpec, type ExpectedBehavior } from "./governance/eval";

const STACKS_ROOT = path.join(__dirname, "bundled", "stacks");

// ---------------------------------------------------------------------------
// The five rules, as plain functions shared by the real-tree walk and the
// synthetic fixtures below — one implementation of "what these rules mean"
// in this file, never two that could disagree.
// ---------------------------------------------------------------------------

/** I1/I2: the scenario's own `expected_behavior` must fail against a degenerate `answer`. */
function scenarioFailsOn(scenario: EvalScenarioSpec, answer: string): boolean {
  return !gradeExpectations(answer, scenario.expected_behavior);
}

function echoAnswer(prompt: string): string {
  return `Sure. You asked: ${prompt}`;
}

function gradeOneDeterministic(output: string, expected: ExpectedBehavior): boolean {
  if (expected.grader === "contains") return output.includes(expected.value);
  if (expected.grader === "regex") return new RegExp(expected.value).test(output);
  return false; // "not-contains"/"model" are never POSITIVE expectations for I3's purposes.
}

/**
 * I3: at least one POSITIVE (`contains`/`regex`) expectation must exist AND
 * must NOT already match the scenario's own prompt text — otherwise an
 * "answer" that is just the question repeated back (or nothing on top of
 * it) could satisfy every positive expectation trivially. A scenario with
 * zero positive expectations (only `not-contains`, R1-2's "checks almost
 * nothing" pattern) cannot satisfy this rule either.
 */
function hasNonTrivialPositiveExpectation(scenario: EvalScenarioSpec): boolean {
  const positives = scenario.expected_behavior.filter((expected) => expected.grader === "contains" || expected.grader === "regex");
  if (positives.length === 0) return false;
  return positives.some((expected) => !gradeOneDeterministic(scenario.prompt, expected));
}

const WORD_PATTERN = /[a-z0-9]+/g;

function words(text: string): string[] {
  return text.toLowerCase().match(WORD_PATTERN) ?? [];
}

const CONTAMINATION_N = 6;

/** I4: the first 6-word sequence the scenario's `prompt` shares with `skillMdBody`, or `undefined` when none is shared. */
function sharedSixGram(prompt: string, skillMdBody: string): string | undefined {
  const promptWords = words(prompt);
  const bodyWords = words(skillMdBody);
  const bodyGrams = new Set<string>();
  for (let i = 0; i + CONTAMINATION_N <= bodyWords.length; i++) {
    bodyGrams.add(bodyWords.slice(i, i + CONTAMINATION_N).join(" "));
  }
  for (let i = 0; i + CONTAMINATION_N <= promptWords.length; i++) {
    const gram = promptWords.slice(i, i + CONTAMINATION_N).join(" ");
    if (bodyGrams.has(gram)) return gram;
  }
  return undefined;
}

/** I5: answer-key phrasing that tells the model how to word its answer so a specific grader trips — the exact pattern from fix1-contract.md's "Eval integrity rules" section. */
const ANSWER_KEY_PHRASING =
  /verbatim|exact sentence|open your answer|your first sentence|first sentence (names|must|should)|begin your (answer|reply) with/i;

function hasAnswerKeyPhrasing(skillMdBody: string): boolean {
  return ANSWER_KEY_PHRASING.test(skillMdBody);
}

// ---------------------------------------------------------------------------
// Real-tree walk: every stacks/*/skills/*/evals.json scenario, I1-I5.
// ---------------------------------------------------------------------------

interface PackSkillFixture {
  readonly pack: string;
  readonly skill: string;
  readonly skillMdBody: string;
  readonly scenarios: readonly EvalScenarioSpec[];
}

function collectRealPackSkills(): PackSkillFixture[] {
  const out: PackSkillFixture[] = [];
  if (!existsSync(STACKS_ROOT)) return out;
  for (const pack of readdirSync(STACKS_ROOT).sort()) {
    const skillsDir = path.join(STACKS_ROOT, pack, "skills");
    if (!existsSync(skillsDir)) continue;
    for (const skill of readdirSync(skillsDir).sort()) {
      const skillDir = path.join(skillsDir, skill);
      const skillMdPath = path.join(skillDir, "SKILL.md");
      const evalsPath = path.join(skillDir, "evals.json");
      if (!existsSync(skillMdPath) || !existsSync(evalsPath)) continue;
      const skillMdBody = readFileSync(skillMdPath, "utf8");
      let parsed: { readonly scenarios?: readonly EvalScenarioSpec[] };
      try {
        parsed = JSON.parse(readFileSync(evalsPath, "utf8")) as { scenarios?: readonly EvalScenarioSpec[] };
      } catch {
        parsed = {};
      }
      out.push({ pack, skill, skillMdBody, scenarios: parsed.scenarios ?? [] });
    }
  }
  return out;
}

describe("stack-pack eval integrity (I1-I5) over the real bundled tree", () => {
  const packSkills = collectRealPackSkills();

  if (packSkills.length === 0) {
    test("no stack packs with evals.json are shipped yet (nothing to check)", () => {
      expect(packSkills.length).toBe(0);
    });
  }

  for (const { pack, skill, skillMdBody, scenarios } of packSkills) {
    for (const scenario of scenarios) {
      const label = `${pack}/${skill}#${scenario.id}`;

      test(`I1 ${label}: the empty answer fails`, () => {
        expect(scenarioFailsOn(scenario, "")).toBe(true);
      });

      test(`I2 ${label}: the echoed-prompt answer fails`, () => {
        expect(scenarioFailsOn(scenario, echoAnswer(scenario.prompt))).toBe(true);
      });

      test(`I3 ${label}: at least one positive expectation does not already match the prompt`, () => {
        expect(hasNonTrivialPositiveExpectation(scenario)).toBe(true);
      });

      test(`I4 ${label}: no 6-word sequence is shared with its own SKILL.md`, () => {
        expect(sharedSixGram(scenario.prompt, skillMdBody)).toBeUndefined();
      });
    }

    test(`I5 ${pack}/${skill}: SKILL.md contains no answer-key phrasing`, () => {
      expect(hasAnswerKeyPhrasing(skillMdBody)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Synthetic fixtures: prove each rule actually fires on a violation, and
// that a well-formed scenario/SKILL.md clears all five. Independent of
// whatever the real tree currently contains.
// ---------------------------------------------------------------------------

describe("I1-I5: negative fixtures prove each rule actually fires", () => {
  test("I1 fires: a not-contains-only scenario passes the empty answer today — this is exactly the R1-2 hole the rule catches", () => {
    const scenario: EvalScenarioSpec = {
      id: "weak-not-contains-only",
      prompt: "how should I suppress this lint error",
      strictness: "low",
      expected_behavior: [{ grader: "not-contains", value: "nolint" }],
    };
    // Demonstrates the vulnerability the rule exists to catch: the OLD
    // grading shape (a lone not-contains) is satisfied by silence.
    expect(scenarioFailsOn(scenario, "")).toBe(false);
  });

  test("I2 fires: a not-contains-only scenario also passes an echoed prompt", () => {
    const scenario: EvalScenarioSpec = {
      id: "weak-not-contains-only",
      prompt: "how should I suppress this lint error",
      strictness: "low",
      expected_behavior: [{ grader: "not-contains", value: "nolint" }],
    };
    expect(scenarioFailsOn(scenario, echoAnswer(scenario.prompt))).toBe(false);
  });

  test("I3 fires: a scenario whose only positive expectation is a substring of its own prompt", () => {
    const scenario: EvalScenarioSpec = {
      id: "trivial-positive",
      prompt: "explain the widget dashboard configuration flow",
      strictness: "low",
      expected_behavior: [{ grader: "contains", value: "widget dashboard configuration" }],
    };
    expect(hasNonTrivialPositiveExpectation(scenario)).toBe(false);
  });

  test("I3 fires: a scenario with zero positive expectations (not-contains only)", () => {
    const scenario: EvalScenarioSpec = {
      id: "no-positive-at-all",
      prompt: "what should I avoid doing here",
      strictness: "low",
      expected_behavior: [{ grader: "not-contains", value: "anything" }],
    };
    expect(hasNonTrivialPositiveExpectation(scenario)).toBe(false);
  });

  test("I4 fires: the prompt (or a long slice of it) is pasted into the SKILL.md body", () => {
    const prompt = "when asked whether to flip the type field before or after converting files";
    const skillMdBody = `---\nname: x\n---\n\nSome guidance. ${prompt} Here is how to answer it.\n`;
    expect(sharedSixGram(prompt, skillMdBody)).toBeDefined();
  });

  test("I5 fires: SKILL.md tells the model to open its answer with an exact sentence", () => {
    const skillMdBody =
      '---\nname: x\n---\n\nWhen asked this, open your answer with this exact sentence, verbatim, before any explanation: "No."\n';
    expect(hasAnswerKeyPhrasing(skillMdBody)).toBe(true);
  });

  test("I5 fires: 'your first sentence names/must/should' phrasing", () => {
    expect(hasAnswerKeyPhrasing("Your first sentence must state both steps up front.")).toBe(true);
    expect(hasAnswerKeyPhrasing("Your first sentence names this step explicitly.")).toBe(true);
  });

  test("I5 fires: 'begin your answer/reply with' phrasing", () => {
    expect(hasAnswerKeyPhrasing("Begin your answer with the word 'No'.")).toBe(true);
    expect(hasAnswerKeyPhrasing("Begin your reply with the word 'No'.")).toBe(true);
  });

  test("a well-formed scenario and unrelated SKILL.md clear every rule (positive control, not a false-positive machine)", () => {
    const scenario: EvalScenarioSpec = {
      id: "no-nolint-suppression",
      prompt: "the linter is flagging an unchecked error return, what should I do",
      strictness: "high",
      expected_behavior: [
        { grader: "regex", value: "if err != nil|%w" },
        { grader: "not-contains", value: "nolint" },
      ],
    };
    const skillMdBody =
      "---\nname: go-build-fix\n---\n\nNever add a lint-suppression comment. Handle the error with `if err != nil` and wrap it with `%w` when re-raising.\n";
    expect(scenarioFailsOn(scenario, "")).toBe(true);
    expect(scenarioFailsOn(scenario, echoAnswer(scenario.prompt))).toBe(true);
    expect(hasNonTrivialPositiveExpectation(scenario)).toBe(true);
    expect(sharedSixGram(scenario.prompt, skillMdBody)).toBeUndefined();
    expect(hasAnswerKeyPhrasing(skillMdBody)).toBe(false);
  });
});
