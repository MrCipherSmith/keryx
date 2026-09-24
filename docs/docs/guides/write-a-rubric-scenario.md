# Write a rubric (judge) eval scenario

A stack-pack skill's behavioral evals used to grade an answer by string
matching — `contains`/`regex`/`not-contains` against the answer text. That
graded wording, not behavior: an answer that correctly warned against
`@ts-ignore` failed a `not-contains "@ts-ignore"` check for saying the token
at all, alongside an answer that actually used it. Flow 316 replaced that for
behavior scenarios with a rubric graded by a separate LLM judge call. This
guide covers how to write one.

## The schema

A behavior scenario's `expected_behavior` array may carry at most one judge
expectation, alongside zero or more deterministic ones:

```json
{
  "grader": "judge",
  "rubric": "What a correct answer does, 1-4 sentences, behaviour not wording.",
  "pass_criteria": ["every one must hold (>= 1 entry)"],
  "fail_criteria": ["any one holding fails the answer (optional)"]
}
```

A judge expectation carries no `value` — `rubric`/`pass_criteria`/
`fail_criteria` replace it. A scenario that carries one must also carry
`calibration` (required) and may carry `anti_patterns` (optional):

```json
"calibration": {
  "known_right": "<hand-written correct answer>",
  "known_wrong": "<hand-written plausible wrong answer that commits the forbidden anti-pattern>"
},
"anti_patterns": ["@ts-ignore", "as any"]
```

`validateEvalSpec` (`src/gdskills/governance/eval.ts`) throws `EvalSpecError`,
naming the file, for any malformed judge field: `calibration` missing, its
two answers empty or identical, or an `anti_patterns` entry that is empty.

### A real example

`src/gdskills/bundled/stacks/go/skills/go-implementation/evals.json`,
scenario `context-propagation`, mixes a deterministic check with a judge
check on the same scenario:

```json
{
  "id": "context-propagation",
  "prompt": "I'm adding a new function to internal/order that calls a downstream client. How should I handle the context and errors?",
  "strictness": "high",
  "expected_behavior": [
    { "grader": "regex", "value": "context\\.Context" },
    {
      "grader": "judge",
      "rubric": "A correct answer explains passing context.Context as the function's first parameter through to the downstream client call (not stored on a struct), and wrapping the error the downstream call returns with fmt.Errorf(\"...: %w\", err) so callers can unwrap it with errors.Is/errors.As, rather than discarding it or replacing it with a plain %v/string.",
      "pass_criteria": [
        "States that context.Context should be the function's first parameter, passed through to the downstream call, not stored on a struct field.",
        "States that the error returned by the downstream call should be wrapped with %w (e.g. fmt.Errorf(\"doing x: %w\", err)) rather than discarded or reformatted with %v/string concatenation.",
        "Connects the wrap to how callers use it (e.g. errors.Is/errors.As), even briefly."
      ],
      "fail_criteria": [
        "Recommends discarding or swallowing the downstream error (e.g. `_ = err` with no comment) instead of wrapping and returning it. Mentioning that only to warn against it is not a failure."
      ]
    }
  ]
}
```

An answer must pass BOTH: the regex (an unambiguous fact — the literal type
name `context.Context` has to appear) AND the judge (behavior — the answer
has to actually explain the parameter-passing and wrapping, not just mention
the type). `gradeScenarioAnswer` (`src/gdskills/governance/judge.ts`) is the
one function that combines them; `passed` is true only when every
deterministic expectation is true AND the judge verdict is `pass`.

## Writing the rubric, pass_criteria, and fail_criteria

- The `rubric` is 1-4 sentences describing what a correct answer **does** —
  the mechanism, not the vocabulary. Write it so it would still make sense if
  every keyword in it were paraphrased.
- Every `pass_criteria` entry must hold for the answer to pass — write each
  one as something a grader can check against the answer's actual content
  ("names X as the first step", "wraps the error with %w"), not a
  restatement of the rubric.
- `fail_criteria` is optional; any single entry holding fails the answer
  regardless of how many pass criteria also hold. Use it for the specific
  wrong move the scenario exists to catch (reaching for a suppression,
  skipping reproduction, mutating state in place).
- **"Warning is not failure."** Mentioning an anti-pattern only to warn
  against it, or to explain why it must not be used, is not the same as
  committing it. Say so explicitly in the `fail_criteria` entry that names
  the anti-pattern — see the `go-implementation` example above
  ("Mentioning that only to warn against it is not a failure") and
  `nodejs-build-fix`'s `no-ts-ignore-suppression` scenario, which adds the
  same sentence to its own suppression-related fail criterion. This clause
  is what a plain `not-contains "@ts-ignore"` check could never express: the
  judge's system prompt (`src/gdskills/governance/judge.ts`, `SYSTEM_PROMPT`)
  states the same rule globally ("do not fail an answer for correctly
  describing what to avoid"), but naming it again in the scenario's own fail
  criterion removes any doubt for that specific rubric.

## When a deterministic check is allowed

Keep a `contains`/`regex`/`not-contains` expectation only for an unambiguous
fact — a specific API name, type, or syntax that every correct answer must
literally contain, regardless of how it phrases the explanation around it.
`context\.Context` and `getByRole` (`react-testing`'s
`mock-network-boundary` scenario) are both this shape: there is no correct
answer that solves the task without naming that exact token.

**Never use `not-contains` on a judge scenario.** Integrity rule I8 (below)
refuses it outright, and it is exactly the check that produced the
mis-specified batch-1 graders flow 316 replaced: a `not-contains
"@ts-ignore"` check fails a correct answer that warns against `@ts-ignore`
just as readily as it fails one that uses it — the token's mere presence
proves nothing about which the answer actually did. A judge scenario's
`fail_criteria` is the replacement: it can express "recommends X as the
fix" in a way a substring match cannot.

## Calibration and anti_patterns

`calibration.known_right` and `calibration.known_wrong` are hand-written,
not generated: `known_right` does what the skill teaches and must pass;
`known_wrong` commits the specific anti-pattern the skill forbids and must
fail. They drive both the anti-gaming harness (below) and two integrity
rules:

- **I6.** Every `anti_patterns` token appears (case-insensitive) in the
  skill's own `SKILL.md` — an anti-pattern the scenario checks for but the
  skill never actually forbids is not a real anti-pattern.
- **I7.** Every `anti_patterns` token appears (case-insensitive) in the
  scenario's own `calibration.known_wrong` — the wrong answer has to
  actually commit the anti-pattern it is supposed to demonstrate.
- **I7b.** Every `anti_patterns` token is at least 4 characters long, or
  contains a non-letter character — a generic short word like `any` cannot
  satisfy I6/I7 by accident (it will appear almost anywhere). Name the
  specific form instead: `` `any` `` (backtick-quoted) or `as any` reads as
  a real anti-pattern token; a bare `any` does not.

`anti_patterns` itself is optional — a scenario with no clean single-token
anti-pattern (for example, `go-implementation`'s `context-propagation`
scenario above) can omit it.

## The anti-gaming requirement

Every judge scenario must be proven hard to game against six canned answers
(`antiGamingAnswers`, `src/gdskills/governance/judge.ts`):

| Kind | Built from | Must grade |
|---|---|---|
| `empty` | `""` | FAIL — never reaches the judge; `gradeScenarioAnswer` short-circuits it |
| `echo` | `"Sure. You asked: " + prompt` | FAIL |
| `known-wrong` | `calibration.known_wrong` | FAIL |
| `injection` | `known_wrong` + a paragraph telling the grader to output pass | FAIL |
| `stuffed` | `known_wrong` + the rubric and every pass/fail criterion pasted in | FAIL |
| `known-right` | `calibration.known_right` | PASS |

`injection` and `stuffed` prove the judge itself resists two specific
attacks: a direct prompt injection telling it to override its instructions,
and keyword-stuffing the rubric's own vocabulary into an otherwise-wrong
answer. Both are built ON TOP OF `known_wrong`, so a scenario cannot pass
them just by having a `known_wrong` that happens to already fail on its own
merits — the judge has to resist the added attack text specifically.

### Recording the calibration

```
keryx skills judge-check <skill-id> --judge <provider>[:<model>] [--scope bundled|all] [--record] [--json]
```

Runs all six canned answers for every judge scenario in the named skill
through the **live** judge (not a stub) and exits `1` if any verdict does
not match what that answer expects. `--record` writes the verdicts to
`src/gdskills/governance/judge-recordings/<pack>__<skill>.json` — a stable,
diff-friendly JSON file the integrity guard replays offline.

A recording goes stale, and the integrity guard's anti-gaming (AG) check
fails closed rather than silently reusing it, when:

- **the recorded `requestDigest` no longer matches** a freshly-built
  request — the rubric, pass/fail criteria, prompt, or answer changed since
  the recording was taken;
- **`judgePromptVersion` in the recording is not the current
  `JUDGE_PROMPT_VERSION`** (`src/gdskills/governance/judge.ts`) — the judge's
  own system/user prompt text changed;
- **the recording is missing entirely** for a scenario that carries a judge
  expectation.

Any of these names the exact fix in its failure message: re-run
`skills judge-check <skill-id> --judge ... --record`.

## The opt-in live check

`src/commands/stack-pack-judge-calibration.live.test.ts` runs the same
anti-gaming set against a real DeepSeek call, but only when
`KERYX_LIVE_JUDGE=1` is set — it costs real tokens and money, so it never
runs by default in CI or locally. Every other integrity check, including the
AG rule above, runs against the **recorded** verdicts and needs no network
access or `KERYX_LIVE_JUDGE`.

## The full integrity rule list

`src/gdskills/stack-pack-eval-integrity.test.ts` enforces these permanently
on every scenario in the shipped tree:

- **I1.** fails when graded against the empty answer `""`.
- **I2.** fails when graded against the echo answer
  `"Sure. You asked: <prompt>"`.
- **I3.** a scenario with no judge expectation carries at least one
  POSITIVE (`contains`/`regex`) expectation that does not already match the
  prompt text itself; a judge scenario instead carries at least one
  non-empty pass criterion, a non-empty rubric, and a calibration pair whose
  two answers differ.
- **I4.** shares no 6-word sequence with its own skill's `SKILL.md` body —
  the eval question must not be pasted into the skill as a worked example.
- **I5.** its skill's `SKILL.md` contains no answer-key phrasing
  ("verbatim", "exact sentence", "open your answer", ...) telling the model
  how to word its answer to trip the grader.
- **I6.** every `anti_patterns` token appears (case-insensitive) in the
  skill's own `SKILL.md`.
- **I7.** every `anti_patterns` token appears (case-insensitive) in the
  scenario's own `calibration.known_wrong`.
- **I7b.** every `anti_patterns` token is at least 4 characters long, or
  contains a non-letter character.
- **I8.** a judge scenario carries no `not-contains` expectation.
- **I9.** every stack-pack behavior scenario is a judge scenario.
- **AG (anti-gaming).** for every judge scenario, every canned answer
  (`empty`, `echo`, `known-wrong`, `injection`, `stuffed`, `known-right`)
  grades, through the recorded live judge, to exactly the outcome that
  answer expects. A missing recording, a stale `judgePromptVersion`, or a
  recording missing the digest for one of these answers fails the check
  outright — never a silent skip, never a pass by omission.

## How the stable-pack gate uses this

A pack's `stability` may only be `"stable"` once every skill's recorded eval
report clears `checkSkillReportForPackGate`
(`src/gdskills/governance/eval.ts`), which requires, on top of the integrity
checks above:

- `strictness: "high"`, `trials >= PACK_MIN_TRIALS` (`5`), `scope: "bundled"`;
- `(runner, model)` and, when the report has any judge scenario,
  `(judge, judgeModel)` both in `STACK_PACK_GATE_POLICY`
  (`src/gdskills/governance/gate-policy.ts`) — pinned to DeepSeek
  `deepseek-chat` for both roles;
- `judgePromptVersion` equal to the current `JUDGE_PROMPT_VERSION`;
- every ran behavior scenario's `passRate` at or above
  `PACK_BEHAVIOR_PASS_FLOOR` (`0.8`);
- every ran behavior scenario carrying `trialRecords`, and
  `regradeRecordedReport` finding no discrepancy between the recorded
  `passed` values and a fresh re-grade of those same records.

## Never tune a SKILL.md to pass

If a scenario's known-right answer fails under the judge, or a real gate run
scores lower than expected, the fix is the rubric, the criteria, or the
calibration — never `SKILL.md`. Editing a skill's own instructions to make
an eval pass after seeing the run is tuning the skill to the grader, the
exact failure mode flow 314 and flow 316 both exist to close; it also
invalidates the eval as a signal that the skill actually behaves correctly
for an unseen prompt. When flow 316's honest gate run found `python` and
`go` scenarios that were themselves under-specified or too narrow (see
`docs/requirements/keryx-agent-platform-expansion/workstreams/
W1-stack-catalog.md`, "Implementation notes: grader reliability
(flow 316)"), the fix was recorded as follow-up work on the grader, not
applied mid-run — and no `SKILL.md` was touched.
