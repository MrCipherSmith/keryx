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
// `antiGamingAnswers` returns (`empty`, `echo`, `vague`, `known-wrong`,
// `subtle-wrong`, `injection`, `stuffed`, `known-right`) must grade, through
// the recorded live judge, to exactly the outcome that canned answer
// expects — checked against EVERY recorded sample of that answer (fix 1 /
// R1-4: the live judge is non-deterministic on identical input, so one
// recorded sample no longer stands for "this canned answer grades
// correctly"; a canned answer with `n` recorded samples gets `n` AG checks,
// one per sample, and ALL must hold). A judge scenario with no recording, a
// recording that cannot even be read (a stale pre-fix-1 shape, or any other
// malformed file), a recording taken under a superseded
// `JUDGE_PROMPT_VERSION`, or a recording missing the digest for one of these
// answers, FAILS the check outright — never a silent skip, never a pass by
// omission — naming the `skills judge-check ... --record` command that fixes
// it. A sample whose verdict carries an `error` (R1-8: the judge's reply was
// unparseable) is itself an AG failure, regardless of what its face-value
// verdict says — it was never a genuine grading.
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
import { normalizeRouteText, routeTokens } from "../lib/route-tokens";
import { gradeExpectations, type EvalScenarioSpec, type ExpectedBehavior } from "./governance/eval";
import { parseSkillFrontmatter } from "./skill-frontmatter";
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

/** I11 (R1 review, PR #719, M3) threshold: a positive trigger prompt at or above this Jaccard similarity against one of its own skill's frontmatter `triggers:` phrases is a near-copy, not an independent realistic phrasing. */
const TRIGGER_OVERLAP_THRESHOLD = 0.5;

/**
 * I11: the worst (highest) Jaccard token similarity — `|intersection| /
 * |union|` — a `positive` trigger prompt has against ANY of its own skill's
 * frontmatter `triggers:` phrases. Uses the SAME tokenizer
 * (`normalizeRouteText`/`routeTokens`) the real skill router scores with, so
 * "near-copy" here means the same thing it means to routing, not a second,
 * independently-invented notion of similarity. Jaccard (not one-sided
 * containment) is deliberate: a short trigger phrase fully embedded in a
 * much longer, genuinely-elaborated prompt should NOT count as a near-copy
 * on its own — the union in the denominator is what tells "the prompt
 * restates the trigger" apart from "the prompt happens to use a few of the
 * same words while saying something substantially longer and different".
 * Returns `{ ratio: 0, trigger: undefined }` when the skill has no triggers
 * or none share any token with the prompt.
 */
function positiveTriggerOverlap(prompt: string, triggers: readonly string[]): { ratio: number; trigger: string | undefined } {
  const promptTokens = routeTokens(normalizeRouteText(prompt));
  let worstRatio = 0;
  let worstTrigger: string | undefined;
  for (const trigger of triggers) {
    const triggerTokens = routeTokens(normalizeRouteText(trigger));
    if (triggerTokens.size === 0) continue;
    let shared = 0;
    for (const token of triggerTokens) {
      if (promptTokens.has(token)) shared += 1;
    }
    const union = new Set([...promptTokens, ...triggerTokens]).size;
    const ratio = union === 0 ? 0 : shared / union;
    if (ratio > worstRatio) {
      worstRatio = ratio;
      worstTrigger = trigger;
    }
  }
  return { ratio: worstRatio, trigger: worstTrigger };
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

/**
 * I7c (fix 1 / R1-7): an `anti_patterns` token appears in the skill's
 * SKILL.md (I6) and the scenario's own `calibration.known_wrong` (I7), but
 * neither of those proves the JUDGE is ever told about it — grading runs
 * entirely off the rubric/pass/fail-criteria text `buildJudgePrompt` sends,
 * never off `anti_patterns` or SKILL.md. This rule closes that gap: the
 * token must also appear in the rubric text, or in one of the fail
 * criteria, or I6/I7 are "trivially satisfiable by construction" (the exact
 * phrase from R1-7) without the judge ever seeing the forbidden thing named.
 */
function tokenAppearsInRubricOrFailCriteria(token: string, judgeExpectation: JudgeExpectation | undefined): boolean {
  if (judgeExpectation === undefined) return false;
  if (hasCaseInsensitiveSubstring(judgeExpectation.rubric, token)) return true;
  return (judgeExpectation.fail_criteria ?? []).some((criterion) => hasCaseInsensitiveSubstring(criterion, token));
}

/** I7c violation: true when `token` appears in neither the rubric nor any fail criterion. */
function violatesI7c(token: string, judgeExpectation: JudgeExpectation | undefined): boolean {
  return !tokenAppearsInRubricOrFailCriteria(token, judgeExpectation);
}

/**
 * I10 (fix 1 / R1-6): a fail criterion that is only a negation-only note —
 * "Mentioning X only to warn against it is not a failure." and its variants
 * — is not a real fail criterion. Read literally against `buildJudgePrompt`'s
 * own "Fail criteria — ANY holding fails the answer" framing, a correct
 * answer that warns against the anti-pattern "holds" that criterion's own
 * sentence (it IS mentioning X); it worked in the shipped tree only because
 * the judge's system prompt carries the same rule globally. The rule lives
 * in the system prompt (`judge.ts`'s `SYSTEM_PROMPT`) — a scenario-level
 * fail criterion must never restate it as a standalone entry.
 */
const NEGATION_ONLY_FAIL_CRITERION = /^\s*(mentioning|merely mentioning|naming)\b/i;

function isNegationOnlyFailCriterion(criterion: string): boolean {
  return NEGATION_ONLY_FAIL_CRITERION.test(criterion);
}

/** I10 violation: true when `criterion` is a negation-only note (see `isNegationOnlyFailCriterion`). */
function violatesI10(criterion: string): boolean {
  return isNegationOnlyFailCriterion(criterion);
}

/**
 * R1-12: I8 and I9 as named predicates, shared verbatim by the real-tree
 * walk and the synthetic "fires" fixtures below — the review found the two
 * call sites re-implementing the same boolean expression independently, so a
 * change to one would never be caught by the other's "fires" test. Following
 * this file's own header promise ("one implementation of what these rules
 * mean"), every rule below this point is a named function used by both.
 */
function violatesI8(scenario: EvalScenarioSpec): boolean {
  return isJudgeScenario(scenario) && scenario.expected_behavior.some((expected) => expected.grader === "not-contains");
}

function violatesI9(scenario: EvalScenarioSpec): boolean {
  return !isJudgeScenario(scenario);
}

function judgeCheckCommand(pack: string, skill: string): string {
  return `bun ./src/cli.ts skills judge-check ${pack}/${skill} --judge deepseek:deepseek-chat --record`;
}

/**
 * Reading a recording is no longer allowed to crash test COLLECTION
 * (`describe`-time code, run synchronously before any `test()` body) — a
 * recording written under the pre-fix-1 shape (`verdict`/`reason` instead of
 * `samples`) now fails `JudgeRecordingFormatError` validation, which every
 * currently-committed recording will until the orchestrator re-records it
 * (this task's own expected "red until re-recorded" state). A thrown error
 * at collection time would abort the ENTIRE test file, turning "some AG
 * checks are red" into "the whole file cannot even run" — so the read is
 * wrapped here and the failure is deferred into the individual test bodies
 * that need it, exactly like a missing file already was.
 */
interface RecordingLookup {
  readonly file?: JudgeRecordingFile;
  readonly error?: Error;
}

function loadRecordingLookup(pack: string, skill: string): RecordingLookup {
  try {
    const file = readJudgeRecording(`${pack}/${skill}`);
    return file !== undefined ? { file } : {};
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/**
 * The anti-gaming (AG) invariant for one SAMPLE of one canned answer: graded
 * through the recorded live judge's `sampleIndex`'th sample of that answer,
 * its `passed` outcome must equal what that answer's `kind` expects.
 * Fix 1 / R1-8: a sample whose verdict carries an `error` is itself a
 * mismatch — `false` — regardless of what its face-value verdict says (it
 * was never a genuine grading, only a manufactured fail after the judge's
 * reply proved unparseable). Shared by the real-tree walk and the synthetic
 * fixtures so both exercise the exact same fail-closed behavior on a
 * missing/unreadable/stale/incomplete recording — never a silent skip, never
 * a pass by omission. Throws (never returns) when the recording cannot
 * ground the check at all, naming the `skills judge-check ... --record`
 * command that fixes it.
 */
async function gradeAntiGamingAnswer(
  pack: string,
  skill: string,
  scenario: EvalScenarioSpec,
  answer: ReturnType<typeof antiGamingAnswers>[number],
  recording: JudgeRecordingFile | undefined,
  sampleIndex = 0,
  loadError?: Error,
): Promise<boolean> {
  const cmd = judgeCheckCommand(pack, skill);
  if (loadError !== undefined) {
    throw new Error(`judge recording for ${pack}/${skill} could not be read: ${loadError.message} -- re-record with \`${cmd}\``, { cause: loadError });
  }
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
    judge = recordedJudge(recording, sampleIndex);
  } catch (error) {
    throw new Error(`judge recording for ${pack}/${skill} could not be used: ${error instanceof Error ? error.message : String(error)} -- re-record with \`${cmd}\``, { cause: error });
  }
  let grade: Awaited<ReturnType<typeof gradeScenarioAnswer>>;
  try {
    grade = await gradeScenarioAnswer(answer.answer, scenario, judge);
  } catch (error) {
    throw new Error(
      `judge recording for ${pack}/${skill} is missing an entry for scenario "${scenario.id}" kind "${answer.kind}" sample ${sampleIndex}: ${error instanceof Error ? error.message : String(error)} -- re-record with \`${cmd}\``,
      { cause: error },
    );
  }
  if (grade.judge?.error !== undefined) return false;
  return grade.passed === (answer.expect === "pass");
}

/**
 * How many recorded samples exist for one canned answer, so the real-tree
 * walk can register exactly that many `AG ... sample N` tests. Falls back to
 * 1 (registering a single test that fails closed through
 * `gradeAntiGamingAnswer`'s own missing-recording/missing-entry handling)
 * when the recording could not be loaded, or has no entry for this exact
 * request yet — the AG contract is "never a silent skip", so under-counting
 * to 1 rather than 0 is the safe direction: it always registers at least one
 * failing test rather than none.
 */
function sampleCountForAG(
  scenario: EvalScenarioSpec,
  judgeExpectation: JudgeExpectation,
  answer: ReturnType<typeof antiGamingAnswers>[number],
  lookup: RecordingLookup,
): number {
  if (lookup.file === undefined) return 1;
  const digest = judgeRequestDigest({ scenarioId: scenario.id, prompt: scenario.prompt, answer: answer.answer, expectation: judgeExpectation });
  const entry = lookup.file.entries.find((candidate) => candidate.requestDigest === digest);
  return entry !== undefined && entry.samples.length > 0 ? entry.samples.length : 1;
}

// ---------------------------------------------------------------------------
// Real-tree walk: every stacks/*/skills/*/evals.json scenario, I1-I9 and AG.
// ---------------------------------------------------------------------------

interface PackSkillFixture {
  readonly pack: string;
  readonly skill: string;
  readonly skillMdBody: string;
  readonly scenarios: readonly EvalScenarioSpec[];
  readonly triggers: readonly string[];
  readonly positives: readonly string[];
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
      let parsed: { readonly scenarios?: readonly EvalScenarioSpec[]; readonly triggers?: { readonly positive?: readonly string[] } };
      try {
        parsed = JSON.parse(readFileSync(evalsPath, "utf8")) as {
          scenarios?: readonly EvalScenarioSpec[];
          triggers?: { readonly positive?: readonly string[] };
        };
      } catch {
        parsed = {};
      }
      const frontmatter = parseSkillFrontmatter(skillMdBody);
      out.push({
        pack,
        skill,
        skillMdBody,
        scenarios: parsed.scenarios ?? [],
        triggers: frontmatter.triggers ?? [],
        positives: parsed.triggers?.positive ?? [],
      });
    }
  }
  return out;
}

/**
 * I11 (R1 review, PR #719, M3) is enforced hard only on the five batch-2
 * packs (flow 318) — the ones actually authored/fixed against it. Batch-1
 * (`ts-js-node`, `react`, `python`, `go`) was authored before this rule
 * existed and, measured the same way, comes back 99/110 positives at or
 * above the 0.5 Jaccard threshold — rewriting that much authored content
 * unreviewed, mid-fix, is out of this flow's scope (its own positives were
 * never flagged as scorer-tuned the way this batch's were). Deferred
 * explicitly rather than silently: tracked as follow-up work for a future
 * flow, not exempted forever.
 */
const I11_ENFORCED_PACKS: ReadonlySet<string> = new Set([
  "nestjs",
  "nextjs-nuxt",
  "vue",
  "angular",
  "mobx",
  // Wave 4 batch 3 (flow 335) — authored after I11 existed, enforced.
  "django",
  "fastapi",
  "rust",
  "java-kotlin-spring",
  "docker-k8s-terraform",
  "ci-github-gitlab",
  // Wave 4 batch 4 (flow 336) — authored after I11 existed, so enforced
  // from the start rather than deferred like batch 1.
  "csharp-dotnet",
  "swift-ios",
  "kotlin-android",
  "flutter-dart",
  // Wave 4 batch 5 (flow 337) — authored against I11 from the start.
  "php-laravel",
  "ruby-rails",
  "c-cpp",
  "sql-db",
]);

describe("stack-pack eval integrity (I1-I9, AG) over the real bundled tree", () => {
  const packSkills = collectRealPackSkills();

  if (packSkills.length === 0) {
    test("no stack packs with evals.json are shipped yet (nothing to check)", () => {
      expect(packSkills.length).toBe(0);
    });
  }

  for (const { pack, skill, skillMdBody, scenarios, triggers, positives } of packSkills) {
    for (const scenario of scenarios) {
      const label = `${pack}/${skill}#${scenario.id}`;
      const hasJudge = isJudgeScenario(scenario);
      const judgeExpectation = judgeExpectationOf(scenario);
      // Read once per scenario (cheap: a single small JSON file, or a fast
      // "does not exist"/"malformed" check) so I2's registration decision and
      // every AG test below share the exact same recording snapshot. Never
      // thrown at collection time (see `loadRecordingLookup`'s doc comment).
      const recordingLookup: RecordingLookup = hasJudge ? loadRecordingLookup(pack, skill) : {};
      const recording = recordingLookup.file;

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
      // skipped rather than failed. A recording that DOES exist but could not
      // be read (malformed/stale-shape) is a different case — that is not
      // "not yet checked", it is broken, so it runs and fails rather than
      // skipping. The AG block below never affords a judge scenario the same
      // missing-file grace: it fails outright on a missing recording.
      const i2Test = hasJudge && recording === undefined && recordingLookup.error === undefined ? test.skip : test;
      i2Test(`I2 ${label}: the echoed-prompt answer fails`, async () => {
        if (hasJudge) {
          if (recordingLookup.error !== undefined) throw recordingLookup.error;
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

        if (hasJudge) {
          test(`I7c ${label} [${token}]: anti_patterns token appears in the rubric or a fail criterion`, () => {
            expect(violatesI7c(token, judgeExpectation)).toBe(false);
          });
        }
      }

      if (hasJudge) {
        test(`I8 ${label}: a judge scenario carries no not-contains expectation`, () => {
          expect(violatesI8(scenario)).toBe(false);
        });

        for (const criterion of judgeExpectation?.fail_criteria ?? []) {
          test(`I10 ${label}: fail criterion is not a negation-only note ["${criterion}"]`, () => {
            expect(violatesI10(criterion)).toBe(false);
          });
        }
      }

      test(`I9 ${label}: every stack-pack behavior scenario is a judge scenario`, () => {
        expect(violatesI9(scenario)).toBe(false);
      });

      if (hasJudge && judgeExpectation !== undefined) {
        for (const answer of antiGamingAnswers(scenario)) {
          const sampleCount = sampleCountForAG(scenario, judgeExpectation, answer, recordingLookup);
          for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
            test(`AG ${label} [${answer.kind}] sample ${sampleIndex}: recorded verdict matches expect="${answer.expect}"`, async () => {
              const ok = await gradeAntiGamingAnswer(pack, skill, scenario, answer, recording, sampleIndex, recordingLookup.error);
              expect(ok).toBe(true);
            });
          }
        }
      }
    }

    test(`I5 ${pack}/${skill}: SKILL.md contains no answer-key phrasing`, () => {
      expect(hasAnswerKeyPhrasing(skillMdBody)).toBe(false);
    });

    if (I11_ENFORCED_PACKS.has(pack)) {
      for (const positive of positives) {
        test(`I11 ${pack}/${skill} [${JSON.stringify(positive)}]: no ${TRIGGER_OVERLAP_THRESHOLD}+ Jaccard overlap with a frontmatter trigger`, () => {
          const { ratio, trigger } = positiveTriggerOverlap(positive, triggers);
          expect(ratio, trigger === undefined ? "" : `near-copy of trigger "${trigger}" (Jaccard ${ratio.toFixed(2)})`).toBeLessThan(
            TRIGGER_OVERLAP_THRESHOLD,
          );
        });
      }
    }
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
      vague: "Handle the error properly instead of ignoring it.",
      subtle_wrong: "Log the error and continue — it's non-fatal, so there's no need to branch on it explicitly.",
    },
    anti_patterns: ["badtoken"],
    ...overrides,
  };
}

describe("I1-I9: negative fixtures prove each rule actually fires", () => {
  test("I11 fires: a positive trigger prompt that closely restates its own skill's frontmatter trigger", () => {
    const { ratio, trigger } = positiveTriggerOverlap("fix this NestJS UnknownDependenciesException", [
      "fix this NestJS UnknownDependenciesException",
    ]);
    expect(ratio).toBeGreaterThanOrEqual(TRIGGER_OVERLAP_THRESHOLD);
    expect(trigger).toBe("fix this NestJS UnknownDependenciesException");
  });

  test("I11 does not fire: a realistic, substantially different prompt sharing only a couple of words with a trigger", () => {
    const { ratio } = positiveTriggerOverlap(
      "The team migrated this service to standalone providers last sprint, and now the DI container throws on startup with no explanation. Where do I even start looking?",
      ["fix this NestJS UnknownDependenciesException"],
    );
    expect(ratio).toBeLessThan(TRIGGER_OVERLAP_THRESHOLD);
  });

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
      calibration: {
        known_right: "does the right thing",
        known_wrong: "does the wrong thing without naming the forbidden thing",
        vague: "does something in the right general direction",
        subtle_wrong: "does a plausible partial version of the wrong thing without naming the forbidden thing",
      },
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

  test("I7c fires: an anti_patterns token is named in known_wrong/SKILL.md but never in the rubric or a fail criterion", () => {
    // Satisfies I6/I7 by construction (R1-7's own complaint) — SKILL.md and
    // known_wrong both name it — but the judge is never told, because
    // grading runs entirely off the rubric/pass/fail-criteria text.
    const scenario = makeJudgeScenario({
      expected_behavior: [
        {
          grader: "judge",
          rubric: "A correct answer checks the error explicitly before doing anything else.",
          pass_criteria: ["Checks the error explicitly before doing anything else."],
          fail_criteria: ["Ignores the error entirely."],
        },
      ],
    });
    const judgeExpectation = judgeExpectationOf(scenario);
    expect(violatesI7c("badtoken", judgeExpectation)).toBe(true);
  });

  test("I7c passes: the token named in the rubric clears the rule", () => {
    const scenario = makeJudgeScenario(); // rubric text mentions "badtoken"
    expect(violatesI7c("badtoken", judgeExpectationOf(scenario))).toBe(false);
  });

  test("I7c passes: the token named only in a fail criterion (not the rubric) also clears the rule", () => {
    const scenario = makeJudgeScenario({
      expected_behavior: [
        {
          grader: "judge",
          rubric: "A correct answer checks the error explicitly before doing anything else.",
          pass_criteria: ["Checks the error explicitly before doing anything else."],
          fail_criteria: ["Suppresses the finding with badtoken instead of handling the error."],
        },
      ],
    });
    expect(violatesI7c("badtoken", judgeExpectationOf(scenario))).toBe(false);
  });

  test('I10 fires: a standalone "Mentioning X only to warn against it is not a failure" fail criterion', () => {
    expect(violatesI10("Mentioning badtoken only to warn against it is not a failure.")).toBe(true);
    expect(violatesI10("Merely mentioning the anti-pattern to warn against it is not a failure.")).toBe(true);
    expect(violatesI10("Naming the suppression comment to warn against it is not a failure.")).toBe(true);
  });

  test("I10 passes: a real fail criterion (not a negation-only note) clears the rule", () => {
    expect(violatesI10("Suppresses the finding with badtoken instead of handling the error.")).toBe(false);
    expect(violatesI10("Force-deletes without warning about unmerged work.")).toBe(false);
  });

  test("I8 fires: a judge scenario carrying a not-contains expectation violates the rule", () => {
    const base = makeJudgeScenario();
    const scenario: EvalScenarioSpec = {
      ...base,
      expected_behavior: [...base.expected_behavior, { grader: "not-contains", value: "nolint" }],
    };
    expect(violatesI8(scenario)).toBe(true);
  });

  test("I9 fires: a scenario with only deterministic expectations is not a judge scenario", () => {
    const scenario: EvalScenarioSpec = {
      id: "no-judge",
      prompt: "explain the retry backoff policy",
      strictness: "low",
      expected_behavior: [{ grader: "contains", value: "backoff" }],
    };
    expect(violatesI9(scenario)).toBe(true);
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

  test("a well-formed judge scenario and its SKILL.md clear I3, I6, I7, I7b, I7c, I8, I9, I10 (positive control, not a false-positive machine)", () => {
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
      expect(violatesI7c(token, judgeExpectation)).toBe(false);
    }
    expect(violatesI8(scenario)).toBe(false);
    expect(violatesI9(scenario)).toBe(false);
    for (const criterion of judgeExpectation.fail_criteria ?? []) {
      expect(violatesI10(criterion)).toBe(false);
    }
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
          // a broken/gamed judge wrongly passing a known-wrong answer
          samples: [{ verdict: "pass", reason: "stub judge that wrongly passes everything" }],
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

  test("AG positive control: a recording whose judge grades every canned answer correctly, in every recorded sample, clears the check", async () => {
    const scenario = makeJudgeScenario();
    const answers = antiGamingAnswers(scenario);
    const SAMPLE_COUNT = 3;
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
        samples: Array.from({ length: SAMPLE_COUNT }, () => ({ verdict: answer.expect, reason: "correctly graded stub" })),
      })),
    };
    for (const answer of answers) {
      for (let sampleIndex = 0; sampleIndex < SAMPLE_COUNT; sampleIndex += 1) {
        const ok = await gradeAntiGamingAnswer("fixture-pack", "fixture-skill", scenario, answer, goodFile, sampleIndex);
        expect(ok).toBe(true);
      }
    }
  });

  // Fix 1 / R1-4: "AG over every sample" — a recording that flips on just
  // ONE of several samples must fail the check for that sample, even though
  // its other samples (and every other canned answer) grade correctly. One
  // stale/lucky recorded sample must never let a flaky judge hide behind its
  // neighbors.
  test("AG fires: one flipped sample among several recorded samples fails the check for that sample, not the whole entry", async () => {
    const scenario = makeJudgeScenario();
    const answer = antiGamingAnswers(scenario).find((candidate) => candidate.kind === "known-wrong")!;
    const request: JudgeRequest = {
      scenarioId: scenario.id,
      prompt: scenario.prompt,
      answer: answer.answer,
      expectation: judgeExpectationOf(scenario)!,
    };
    const flakyFile: JudgeRecordingFile = {
      judgePromptVersion: JUDGE_PROMPT_VERSION,
      judge: "deepseek",
      judgeModel: "deepseek-chat",
      recordedAt: new Date().toISOString(),
      entries: [
        {
          scenarioId: scenario.id,
          kind: answer.kind,
          requestDigest: judgeRequestDigest(request),
          samples: [
            { verdict: "fail", reason: "correctly failed, sample 0" },
            { verdict: "pass", reason: "wrongly passed, sample 1 — the judge flipped" },
            { verdict: "fail", reason: "correctly failed, sample 2" },
          ],
        },
      ],
    };
    expect(await gradeAntiGamingAnswer("fixture-pack", "fixture-skill", scenario, answer, flakyFile, 0)).toBe(true);
    expect(await gradeAntiGamingAnswer("fixture-pack", "fixture-skill", scenario, answer, flakyFile, 1)).toBe(false);
    expect(await gradeAntiGamingAnswer("fixture-pack", "fixture-skill", scenario, answer, flakyFile, 2)).toBe(true);
  });

  // R1-8: an error-carrying verdict is itself a mismatch, even when its
  // face-value verdict happens to equal the expected outcome — it was never
  // a genuine grading, only a manufactured fallback after the judge's reply
  // proved unparseable twice in a row.
  test("AG fires: an error-carrying sample is a mismatch even when its face-value verdict equals expect", async () => {
    const scenario = makeJudgeScenario();
    const answer = antiGamingAnswers(scenario).find((candidate) => candidate.kind === "known-wrong")!; // expects "fail"
    const request: JudgeRequest = {
      scenarioId: scenario.id,
      prompt: scenario.prompt,
      answer: answer.answer,
      expectation: judgeExpectationOf(scenario)!,
    };
    const erroringFile: JudgeRecordingFile = {
      judgePromptVersion: JUDGE_PROMPT_VERSION,
      judge: "deepseek",
      judgeModel: "deepseek-chat",
      recordedAt: new Date().toISOString(),
      entries: [
        {
          scenarioId: scenario.id,
          kind: answer.kind,
          requestDigest: judgeRequestDigest(request),
          samples: [{ verdict: "fail", reason: "judge returned an unparseable verdict", error: "judge reply was not valid JSON" }],
        },
      ],
    };
    const ok = await gradeAntiGamingAnswer("fixture-pack", "fixture-skill", scenario, answer, erroringFile, 0);
    expect(ok).toBe(false);
  });

  test("AG fires: a recording that could not be read (loadError) fails closed, naming the record command", async () => {
    const scenario = makeJudgeScenario();
    const answer = antiGamingAnswers(scenario).find((candidate) => candidate.kind === "known-wrong")!;
    await expect(
      gradeAntiGamingAnswer("fixture-pack", "fixture-skill", scenario, answer, undefined, 0, new Error("recording must be a JSON object")),
    ).rejects.toThrow(/judge-check/);
  });

  test("sampleCountForAG: falls back to 1 when the recording has no matching entry, and returns the entry's sample count when it does", () => {
    const scenario = makeJudgeScenario();
    const judgeExpectation = judgeExpectationOf(scenario)!;
    const answer = antiGamingAnswers(scenario).find((candidate) => candidate.kind === "known-wrong")!;

    expect(sampleCountForAG(scenario, judgeExpectation, answer, {})).toBe(1);

    const request: JudgeRequest = { scenarioId: scenario.id, prompt: scenario.prompt, answer: answer.answer, expectation: judgeExpectation };
    const file: JudgeRecordingFile = {
      judgePromptVersion: JUDGE_PROMPT_VERSION,
      judge: "deepseek",
      judgeModel: "deepseek-chat",
      recordedAt: new Date().toISOString(),
      entries: [
        {
          scenarioId: scenario.id,
          kind: answer.kind,
          requestDigest: judgeRequestDigest(request),
          samples: [{ verdict: "fail", reason: "a" }, { verdict: "fail", reason: "b" }, { verdict: "fail", reason: "c" }],
        },
      ],
    };
    expect(sampleCountForAG(scenario, judgeExpectation, answer, { file })).toBe(3);
  });
});
