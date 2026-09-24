// The eval-integrity guard for every `stacks/*/skills/*/evals.json`. These
// are permanent guarantees, enforced on every scenario in the real bundled
// tree, not a one-time repair:
//
//   I1. fail when graded against the empty answer "";
//   I2. fail when graded against the echo answer "Sure. You asked: <prompt>";
//   I3. a scenario with no judge expectation carries at least one POSITIVE
//       (`contains`/`regex`) expectation that does NOT already match the
//       prompt text itself; a judge scenario instead carries at least one
//       non-empty pass criterion, a non-empty rubric, and a calibration pair
//       (`known_right`/`known_wrong`) whose two answers differ;
//   I4. share no 6-word sequence with its own skill's SKILL.md body (words
//       lowercased, split on `[a-z0-9]+`) — the eval question must not be
//       pasted into the skill as a worked example;
//   I5. its skill's SKILL.md must contain no answer-key phrasing
//       ("verbatim", "exact sentence", "open your answer", ...) telling the
//       model how to word its answer to trip the grader;
//   I6. every `anti_patterns` token appears (case-insensitive) in the
//       skill's own SKILL.md;
//   I7. every `anti_patterns` token appears (case-insensitive) in the
//       scenario's own `calibration.known_wrong`;
//   I7b. every `anti_patterns` token is at least 4 characters long, or
//        contains a non-letter character — a generic word like "any" cannot
//        satisfy I6/I7 by accident;
//   I8. a judge scenario carries no `not-contains` expectation;
//   I9. every stack-pack behavior scenario is a judge scenario.
//
// ANTI-GAMING (AG): for every judge scenario, every canned answer
// `antiGamingAnswers` returns (`empty`, `echo`, `known-wrong`, `injection`,
// `stuffed`, `known-right`) must grade, through the recorded live judge, to
// exactly the outcome that canned answer expects. A judge scenario with no
// recording, a recording taken under a superseded `JUDGE_PROMPT_VERSION`, or
// a recording missing the digest for one of these answers, FAILS the check
// outright — never a silent skip, never a pass by omission — naming the
// `skills judge-check ... --record` command that fixes it.
//
// GRADING SEMANTICS: a scenario with no judge expectation is graded with
// `gradeExpectations` from `./governance/eval` — the exact same "a scenario
// fails when ANY expectation fails" rule `evalSkill`'s own trial loop
// applies. A judge scenario is graded with `gradeScenarioAnswer` from
// `./governance/judge` — the ONE grading function shared by `evalSkill`, the
// anti-gaming harness, and `keryx skills judge-check` — driven by a real
// judge verdict replayed from a recording (`recordedJudge`), never by a
// second, independently-written judge stand-in that could quietly drift from
// the real one.
//
// The real-tree assertions below (first describe block) hold on the current
// shipped tree, and any future change to `stacks/*/skills/*/evals.json` or
// `SKILL.md` that violates any rule must fail them — that is the point of
// running them against the real tree rather than only against fixtures. The
// synthetic negative/positive fixtures (second describe block) pin the rules
// themselves independently, so a rule's exactness is never only inferred
// from the real tree happening to pass.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { gradeExpectations, type EvalScenarioSpec, type ExpectedBehavior } from "./governance/eval";
import {
  antiGamingAnswers,
  gradeScenarioAnswer,
  judgeRequestDigest,
  JUDGE_PROMPT_VERSION,
  type Judge,
  type JudgeExpectation,
  type JudgeRequest,
} from "./governance/judge";
import { readJudgeRecording, recordedJudge, type JudgeRecordingFile } from "./governance/judge-recordings";

const STACKS_ROOT = path.join(__dirname, "bundled", "stacks");

// ---------------------------------------------------------------------------
// The rules, as plain functions shared by the real-tree walk and the
// synthetic fixtures below — one implementation of "what these rules mean"
// in this file, never two that could disagree.
// ---------------------------------------------------------------------------

/** A scenario carrying a `judge` expectation — flow 316's only kind now shipped in the real tree, but a fixture may still build a non-judge one to pin the legacy branch each rule still supports. */
function judgeExpectationOf(scenario: EvalScenarioSpec): JudgeExpectation | undefined {
  return scenario.expected_behavior.find((expected): expected is JudgeExpectation => expected.grader === "judge");
}

function isJudgeScenario(scenario: EvalScenarioSpec): boolean {
  return judgeExpectationOf(scenario) !== undefined;
}

/** I1/I2 (non-judge scenarios only): the scenario's own `expected_behavior` must fail against a degenerate `answer`. */
function scenarioFailsOn(scenario: EvalScenarioSpec, answer: string): boolean {
  return !gradeExpectations(answer, scenario.expected_behavior);
}

function echoAnswer(prompt: string): string {
  return `Sure. You asked: ${prompt}`;
}

function gradeOneDeterministic(output: string, expected: ExpectedBehavior): boolean {
  if (expected.grader === "contains") return output.includes(expected.value);
  if (expected.grader === "regex") return new RegExp(expected.value).test(output);
  return false; // "not-contains"/"model"/"judge" are never POSITIVE expectations for I3's purposes.
}

/**
 * I3 (non-judge scenarios): at least one POSITIVE (`contains`/`regex`)
 * expectation must exist AND must NOT already match the scenario's own
 * prompt text — otherwise an "answer" that is just the question repeated
 * back (or nothing on top of it) could satisfy every positive expectation
 * trivially. A scenario with zero positive expectations (only
 * `not-contains`) cannot satisfy this rule either.
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

/** I5: answer-key phrasing that tells the model how to word its answer so a specific grader trips. */
const ANSWER_KEY_PHRASING =
  /verbatim|exact sentence|open your answer|your first sentence|first sentence (names|must|should)|begin your (answer|reply) with/i;

function hasAnswerKeyPhrasing(skillMdBody: string): boolean {
  return ANSWER_KEY_PHRASING.test(skillMdBody);
}

/** I6/I7: case-insensitive substring check. */
function hasCaseInsensitiveSubstring(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** I7b: a token is specific enough to name a real anti-pattern (not a generic word like "any") when it is at least 4 characters long, or contains a character that is not a plain letter (a flag, a symbol, a hyphenated/spaced phrase). */
function isSpecificToken(token: string): boolean {
  return token.length >= 4 || /[^a-zA-Z]/.test(token);
}

function judgeCheckCommand(pack: string, skill: string): string {
  return `bun ./src/cli.ts skills judge-check ${pack}/${skill} --judge deepseek:deepseek-chat --record`;
}

/**
 * The anti-gaming (AG) invariant for one canned answer: graded through the
 * recorded live judge, its `passed` outcome must equal what that answer's
 * `kind` expects. Shared by the real-tree walk and the synthetic fixtures so
 * both exercise the exact same fail-closed behavior on a missing/stale/
 * incomplete recording — never a silent skip, never a pass by omission.
 * Throws (never returns) when the recording cannot ground the check at all,
 * naming the `skills judge-check ... --record` command that fixes it.
 */
async function gradeAntiGamingAnswer(
  pack: string,
  skill: string,
  scenario: EvalScenarioSpec,
  answer: ReturnType<typeof antiGamingAnswers>[number],
  recording: JudgeRecordingFile | undefined,
): Promise<boolean> {
  const cmd = judgeCheckCommand(pack, skill);
  if (recording === undefined) {
    throw new Error(`no judge recording for ${pack}/${skill} yet -- run \`${cmd}\` to create one`);
  }
  if (recording.judgePromptVersion !== JUDGE_PROMPT_VERSION) {
    throw new Error(
      `judge recording for ${pack}/${skill} is stale (recorded under judgePromptVersion "${recording.judgePromptVersion}", current is "${JUDGE_PROMPT_VERSION}") -- re-record with \`${cmd}\``,
    );
  }
  let judge: Judge;
  try {
    judge = recordedJudge(recording);
  } catch (error) {
    throw new Error(`judge recording for ${pack}/${skill} could not be used: ${error instanceof Error ? error.message : String(error)} -- re-record with \`${cmd}\``, { cause: error });
  }
  let grade: Awaited<ReturnType<typeof gradeScenarioAnswer>>;
  try {
    grade = await gradeScenarioAnswer(answer.answer, scenario, judge);
  } catch (error) {
    throw new Error(
      `judge recording for ${pack}/${skill} is missing an entry for scenario "${scenario.id}" kind "${answer.kind}": ${error instanceof Error ? error.message : String(error)} -- re-record with \`${cmd}\``,
      { cause: error },
    );
  }
  return grade.passed === (answer.expect === "pass");
}

// ---------------------------------------------------------------------------
// Real-tree walk: every stacks/*/skills/*/evals.json scenario, I1-I9 and AG.
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

describe("stack-pack eval integrity (I1-I9, AG) over the real bundled tree", () => {
  const packSkills = collectRealPackSkills();

  if (packSkills.length === 0) {
    test("no stack packs with evals.json are shipped yet (nothing to check)", () => {
      expect(packSkills.length).toBe(0);
    });
  }

  for (const { pack, skill, skillMdBody, scenarios } of packSkills) {
    for (const scenario of scenarios) {
      const label = `${pack}/${skill}#${scenario.id}`;
      const hasJudge = isJudgeScenario(scenario);
      const judgeExpectation = judgeExpectationOf(scenario);
      // Read once per scenario (cheap: a single small JSON file, or a fast
      // "does not exist" check) so I2's registration decision and every AG
      // test below share the exact same recording snapshot.
      const recording = hasJudge ? readJudgeRecording(`${pack}/${skill}`) : undefined;

      test(`I1 ${label}: the empty answer fails`, async () => {
        if (hasJudge) {
          // The empty-answer path is graded WITHOUT calling the judge at all
          // (`gradeScenarioAnswer` short-circuits it) — this holds even
          // before any recording exists.
          const grade = await gradeScenarioAnswer("", scenario);
          expect(grade.passed).toBe(false);
        } else {
          expect(scenarioFailsOn(scenario, "")).toBe(true);
        }
      });

      // I2 needs a real judge verdict for the echoed-prompt answer (it is
      // not short-circuited) — until a recording exists for this skill, this
      // is honestly "not yet checked", not a fabricated pass, so it is
      // skipped rather than failed. The AG block below never affords a judge
      // scenario the same grace: it fails outright on a missing recording.
      const i2Test = hasJudge && recording === undefined ? test.skip : test;
      i2Test(`I2 ${label}: the echoed-prompt answer fails`, async () => {
        if (hasJudge) {
          const judge = recordedJudge(recording!);
          const grade = await gradeScenarioAnswer(echoAnswer(scenario.prompt), scenario, judge);
          expect(grade.passed).toBe(false);
        } else {
          expect(scenarioFailsOn(scenario, echoAnswer(scenario.prompt))).toBe(true);
        }
      });

      test(`I3 ${label}: ${hasJudge ? "rubric/pass-criteria/calibration are well-formed" : "at least one positive expectation does not already match the prompt"}`, () => {
        if (hasJudge) {
          expect(judgeExpectation).toBeDefined();
          expect(judgeExpectation!.pass_criteria.length).toBeGreaterThanOrEqual(1);
          expect(judgeExpectation!.pass_criteria.every((criterion) => criterion.trim().length > 0)).toBe(true);
          expect(judgeExpectation!.rubric.trim().length).toBeGreaterThan(0);
          expect(scenario.calibration).toBeDefined();
          expect(scenario.calibration!.known_right.trim().length).toBeGreaterThan(0);
          expect(scenario.calibration!.known_wrong.trim().length).toBeGreaterThan(0);
          expect(scenario.calibration!.known_right).not.toBe(scenario.calibration!.known_wrong);
        } else {
          expect(hasNonTrivialPositiveExpectation(scenario)).toBe(true);
        }
      });

      test(`I4 ${label}: no 6-word sequence is shared with its own SKILL.md`, () => {
        expect(sharedSixGram(scenario.prompt, skillMdBody)).toBeUndefined();
      });

      for (const token of scenario.anti_patterns ?? []) {
        test(`I6 ${label} [${token}]: anti_patterns token appears in SKILL.md`, () => {
          expect(hasCaseInsensitiveSubstring(skillMdBody, token)).toBe(true);
        });

        test(`I7 ${label} [${token}]: anti_patterns token appears in calibration.known_wrong`, () => {
          expect(hasCaseInsensitiveSubstring(scenario.calibration?.known_wrong ?? "", token)).toBe(true);
        });

        test(`I7b ${label} [${token}]: anti_patterns token is specific (>= 4 chars, or has a non-letter char)`, () => {
          expect(isSpecificToken(token)).toBe(true);
        });
      }

      if (hasJudge) {
        test(`I8 ${label}: a judge scenario carries no not-contains expectation`, () => {
          expect(scenario.expected_behavior.some((expected) => expected.grader === "not-contains")).toBe(false);
        });
      }

      test(`I9 ${label}: every stack-pack behavior scenario is a judge scenario`, () => {
        expect(hasJudge).toBe(true);
      });

      if (hasJudge) {
        for (const answer of antiGamingAnswers(scenario)) {
          test(`AG ${label} [${answer.kind}]: recorded verdict matches expect="${answer.expect}"`, async () => {
            const ok = await gradeAntiGamingAnswer(pack, skill, scenario, answer, recording);
            expect(ok).toBe(true);
          });
        }
      }
    }

    test(`I5 ${pack}/${skill}: SKILL.md contains no answer-key phrasing`, () => {
      expect(hasAnswerKeyPhrasing(skillMdBody)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Synthetic fixtures: prove each rule actually fires on a violation, and
// that a well-formed scenario/SKILL.md clears every rule. Independent of
// whatever the real tree currently contains.
// ---------------------------------------------------------------------------

/** A well-formed judge scenario whose calibration and anti_patterns are internally consistent — the base every fixture below either uses as-is (positive control) or deliberately breaks one field of (negative fixtures). */
function makeJudgeScenario(overrides: Partial<EvalScenarioSpec> = {}): EvalScenarioSpec {
  return {
    id: "judge-scenario",
    prompt: "how should I handle the ignored error here",
    strictness: "high",
    expected_behavior: [
      {
        grader: "judge",
        rubric: "A correct answer checks the error explicitly and never suppresses it with badtoken.",
        pass_criteria: ["Checks the error explicitly before doing anything else."],
        fail_criteria: ["Suppresses the finding with badtoken instead of handling the error."],
      },
    ],
    calibration: {
      known_right: "Check the error with an explicit branch and handle or wrap it before returning.",
      known_wrong: "Just add badtoken above the line and move on, the error doesn't matter.",
    },
    anti_patterns: ["badtoken"],
    ...overrides,
  };
}

describe("I1-I9: negative fixtures prove each rule actually fires", () => {
  test("I1 fires: a not-contains-only scenario passes the empty answer today — this is exactly the hole the rule catches", () => {
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

  test("I6 fires: an anti_patterns token is not named anywhere in SKILL.md", () => {
    const scenario = makeJudgeScenario({ anti_patterns: ["zzz-not-present-token"] });
    const skillMdBody = "---\nname: x\n---\n\nUnrelated guidance with no mention of the forbidden thing.\n";
    expect(hasCaseInsensitiveSubstring(skillMdBody, scenario.anti_patterns![0]!)).toBe(false);
  });

  test("I7 fires: an anti_patterns token is not named in calibration.known_wrong", () => {
    const scenario = makeJudgeScenario({
      calibration: { known_right: "does the right thing", known_wrong: "does the wrong thing without naming the forbidden thing" },
    });
    expect(hasCaseInsensitiveSubstring(scenario.calibration!.known_wrong, "badtoken")).toBe(false);
  });

  test("I7b fires: a generic short all-letters token ('any') is not specific enough", () => {
    expect(isSpecificToken("any")).toBe(false);
  });

  test("I7b passes: a token with >= 4 letters, or one with a non-letter character, is specific", () => {
    expect(isSpecificToken("nolint")).toBe(true);
    expect(isSpecificToken("a-b")).toBe(true); // 3 chars, but a hyphen makes it specific
    expect(isSpecificToken("@ts-ignore")).toBe(true);
  });

  test("I8 fires: a judge scenario carrying a not-contains expectation violates the rule", () => {
    const base = makeJudgeScenario();
    const scenario: EvalScenarioSpec = {
      ...base,
      expected_behavior: [...base.expected_behavior, { grader: "not-contains", value: "nolint" }],
    };
    expect(isJudgeScenario(scenario)).toBe(true);
    expect(scenario.expected_behavior.some((expected) => expected.grader === "not-contains")).toBe(true);
  });

  test("I9 fires: a scenario with only deterministic expectations is not a judge scenario", () => {
    const scenario: EvalScenarioSpec = {
      id: "no-judge",
      prompt: "explain the retry backoff policy",
      strictness: "low",
      expected_behavior: [{ grader: "contains", value: "backoff" }],
    };
    expect(isJudgeScenario(scenario)).toBe(false);
  });

  test("a well-formed non-judge scenario and unrelated SKILL.md clear I1-I5 (positive control, not a false-positive machine)", () => {
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

  test("a well-formed judge scenario and its SKILL.md clear I3, I6, I7, I7b, I8, I9 (positive control, not a false-positive machine)", () => {
    const scenario = makeJudgeScenario();
    const skillMdBody = "---\nname: fixture-skill\n---\n\nNever produce output containing badtoken; it is forbidden here.\n";

    expect(isJudgeScenario(scenario)).toBe(true);
    const judgeExpectation = judgeExpectationOf(scenario)!;
    expect(judgeExpectation.pass_criteria.length).toBeGreaterThanOrEqual(1);
    expect(judgeExpectation.pass_criteria.every((criterion) => criterion.trim().length > 0)).toBe(true);
    expect(judgeExpectation.rubric.trim().length).toBeGreaterThan(0);
    expect(scenario.calibration!.known_right).not.toBe(scenario.calibration!.known_wrong);

    for (const token of scenario.anti_patterns ?? []) {
      expect(hasCaseInsensitiveSubstring(skillMdBody, token)).toBe(true);
      expect(hasCaseInsensitiveSubstring(scenario.calibration!.known_wrong, token)).toBe(true);
      expect(isSpecificToken(token)).toBe(true);
    }
    expect(scenario.expected_behavior.some((expected) => expected.grader === "not-contains")).toBe(false);
  });
});

describe("AG: synthetic fixtures prove the anti-gaming check actually fires", () => {
  test("AG fires: a missing recording fails closed, naming the record command", async () => {
    const scenario = makeJudgeScenario();
    const answer = antiGamingAnswers(scenario).find((candidate) => candidate.kind === "known-wrong")!;
    // A skill id that genuinely has no recording on disk — this never reads
    // or writes any real committed recording, it proves "no file" fails
    // closed rather than passing by omission.
    await expect(gradeAntiGamingAnswer("zzz-fixture-pack", "zzz-fixture-skill", scenario, answer, undefined)).rejects.toThrow(/judge-check/);
  });

  test("AG fires: a recording taken under a superseded judgePromptVersion fails closed", async () => {
    const scenario = makeJudgeScenario();
    const answer = antiGamingAnswers(scenario).find((candidate) => candidate.kind === "known-wrong")!;
    const staleFile: JudgeRecordingFile = {
      judgePromptVersion: "some-old-version",
      judge: "deepseek",
      judgeModel: "deepseek-chat",
      recordedAt: new Date(0).toISOString(),
      entries: [],
    };
    await expect(gradeAntiGamingAnswer("fixture-pack", "fixture-skill", scenario, answer, staleFile)).rejects.toThrow(/judge-check/);
  });

  test("AG fires: a recording whose judge wrongly passes known-wrong fails the AG invariant", async () => {
    const scenario = makeJudgeScenario();
    const answer = antiGamingAnswers(scenario).find((candidate) => candidate.kind === "known-wrong")!;
    const request: JudgeRequest = {
      scenarioId: scenario.id,
      prompt: scenario.prompt,
      answer: answer.answer,
      expectation: judgeExpectationOf(scenario)!,
    };
    const badFile: JudgeRecordingFile = {
      judgePromptVersion: JUDGE_PROMPT_VERSION,
      judge: "deepseek",
      judgeModel: "deepseek-chat",
      recordedAt: new Date().toISOString(),
      entries: [
        {
          scenarioId: scenario.id,
          kind: answer.kind,
          requestDigest: judgeRequestDigest(request),
          verdict: "pass", // a broken/gamed judge wrongly passing a known-wrong answer
          reason: "stub judge that wrongly passes everything",
        },
      ],
    };
    const ok = await gradeAntiGamingAnswer("fixture-pack", "fixture-skill", scenario, answer, badFile);
    // The AG invariant is `grade.passed === (expect === "pass")`; known-wrong
    // expects "fail", so a judge that (wrongly) passed it must make this
    // `false` — proving the check would catch a gamed/broken judge instead
    // of rubber-stamping it.
    expect(ok).toBe(false);
  });

  test("AG positive control: a recording whose judge grades every canned answer correctly clears the check", async () => {
    const scenario = makeJudgeScenario();
    const answers = antiGamingAnswers(scenario);
    const goodFile: JudgeRecordingFile = {
      judgePromptVersion: JUDGE_PROMPT_VERSION,
      judge: "deepseek",
      judgeModel: "deepseek-chat",
      recordedAt: new Date().toISOString(),
      entries: answers.map((answer) => ({
        scenarioId: scenario.id,
        kind: answer.kind,
        requestDigest: judgeRequestDigest({
          scenarioId: scenario.id,
          prompt: scenario.prompt,
          answer: answer.answer,
          expectation: judgeExpectationOf(scenario)!,
        }),
        verdict: answer.expect,
        reason: "correctly graded stub",
      })),
    };
    for (const answer of answers) {
      const ok = await gradeAntiGamingAnswer("fixture-pack", "fixture-skill", scenario, answer, goodFile);
      expect(ok).toBe(true);
    }
  });
});
