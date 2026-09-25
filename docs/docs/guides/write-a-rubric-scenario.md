# Write a rubric (judge) eval scenario

A stack-pack skill's behavioral evals used to grade an answer by string
matching — `contains`/`regex`/`not-contains` against the answer text. That
graded wording, not behavior: an answer that correctly warned against
`@ts-ignore` failed a `not-contains "@ts-ignore"` check for saying the token
at all, alongside an answer that actually used it. Flow 316 replaced that for
behavior scenarios with a rubric graded by a separate LLM judge call. This
guide covers how to write one.

## Exclusion clauses in a `description`/`triggers` are safe to write (flow 334)

This is unrelated to judge rubrics, but the same "don't fight the grader,
write for it" spirit applies to a skill's `SKILL.md` frontmatter
`description`/`triggers`, which drive the SEPARATE lexical trigger scorer
(`src/gdskills/governance/scout.ts`, `checkSkillSelected`/`scoutSkill`) that
`keryx skills eval <id>`'s `triggerAccuracy` and `keryx skills scout` both
use.

Before flow 334, that scorer was a plain bag-of-words/IDF match with no
negation handling: text inside a skill's own exclusion clause — "Use when X.
**Not for** Y (use \`other-skill\` instead)." — counted Y's words as ordinary
POSITIVE evidence for the skill, exactly as if the description had claimed
them. Authors were working around this by stripping words out of
descriptions and stuffing eval prompts with jargon instead of writing the
clause the convention already recommends. Concrete measured case: before the
fix, `ts-js-node/nodejs-implementation`'s description — "... Not for UI
markup/rendering code (use the matching UI framework pack) or writing/fixing
tests (use nodejs-testing)." — scored 0.682 against the query "write vitest
tests for this service", purely from "writing"/"tests" sitting inside its own
disclaimer.

**The scorer now strips exclusion-clause text before scoring, on both the
entry and query side** (`stripExclusionClauses` in `scout.ts`). Write your
disclaimer normally — do not strip the topic word out of your description to
avoid a false match, and do not avoid stating what a skill is NOT for. The
recognized forms, surveyed from the bundled catalog:

- `Not for <clause>.` / `NOT for: <clause>.` — the dominant convention (37+
  bundled skills), usually paired with a redirect: `Not for X (use
  \`other-skill\`).`
- `Do not use for <clause>.`
- A sentence that OPENS with `Never <clause>.` (a mid-sentence `never` in
  otherwise-ordinary prose — "a fix that never widens beyond the failure" —
  is deliberately left alone; only a sentence-initial `Never` is treated as
  an exclusion clause, to avoid over-triggering on normal English).
- A `(not <clause>)` parenthetical aside, anywhere in the text.
- A standalone `Use \`<other-skill>\` instead.` redirect with no `Not for`
  wrapper.

Excluded tokens are dropped from the entry's positive evidence; they are
**not** turned into negative evidence (a skill is not penalized for the
topic it disclaims — see the `stripExclusionClauses` section comment in
`scout.ts` for the full reasoning). This is layered on top of the shared
tokenizer (`src/lib/route-tokens.ts`), not a change to it, and it does not
touch behavior-scenario judging on this page — it only affects
`triggerAccuracy` and `scoutSkill`'s use/fork overlap decision.

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
  "known_wrong": "<hand-written plausible wrong answer that commits the forbidden anti-pattern>",
  "vague": "<hand-written plausible answer that names the right direction but gives no concrete fix>",
  "subtle_wrong": "<hand-written realistic-sounding answer that still commits the anti-pattern or misses required behaviour>"
},
"anti_patterns": ["@ts-ignore", "as any"]
```

`vague` and `subtle_wrong` (fix 1 / R1-4, R1-11) are required alongside
`known_right`/`known_wrong` — all four must be non-empty and pairwise
different:

- **`vague`** — a plausible, generic answer of 1-3 sentences that points in
  the right direction ("fix the type instead of hiding the error", "add the
  missing dependency") but gives no concrete fix. Must FAIL. This is the
  leniency class review round 1 on PR #698 found the live judge passing
  before this fix (R1-4): a one-sentence paraphrase of the rubric's own
  direction, with nothing concrete shown, cleared some scenarios' judge
  calls.
- **`subtle_wrong`** — a reasonable-sounding, well-written answer that still
  commits the anti-pattern or misses a required behaviour in a realistic way
  — a partial fix, hedging, a non-`any` cast, log-and-continue, or a mock one
  layer too deep. Must FAIL. `known_wrong` calibrations tend to be strawmen
  ("Easiest fix: `<anti-pattern>`, no need to look further") that the judge
  fails trivially; `subtle_wrong` is what actually exercises the judge
  against a failure mode a real model might produce.

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
- **The concreteness rule (fix 1 / R1-4).** A pass criterion holds only when
  it is *concretely* present in the answer — the specific change, code, or
  step is actually shown or named, not merely gestured at or promised. An
  answer that only names the right direction ("fix the type instead of
  suppressing the error", "add the missing dependency") without showing what
  the fix actually is does not satisfy that criterion; write your
  `pass_criteria` so they require the concrete artefact, not just the
  direction, and use the `vague` calibration answer above to prove it. This
  is stated in the judge's own system prompt
  (`src/gdskills/governance/judge.ts`, `JUDGE_PROMPT_VERSION 2026-09-25.1`),
  which also requires the judge's "reason" to cite *where* in the answer each
  pass criterion is satisfied, not just restate the criterion.
- `fail_criteria` is optional; any single entry holding fails the answer
  regardless of how many pass criteria also hold. Use it for the specific
  wrong move the scenario exists to catch (reaching for a suppression,
  skipping reproduction, mutating state in place). **Never write a
  negation-only note as its own `fail_criteria` entry** — for example, a
  standalone "Mentioning X only to warn against it is not a failure." Fold
  that sentence into the fail criterion it qualifies instead (see "Warning is
  not failure" below); integrity rule I10 (below) rejects a negation-only
  note listed on its own.
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

`calibration.known_right`, `calibration.known_wrong`, `calibration.vague`,
and `calibration.subtle_wrong` are all hand-written, not generated:
`known_right` does what the skill teaches and must pass; the other three
must each fail, for different reasons (see "The anti-gaming requirement"
below). They drive both the anti-gaming harness and these integrity rules:

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
- **I7c (fix 1 / R1-7).** Every `anti_patterns` token also appears
  (case-insensitive) in the scenario's own judge expectation — its `rubric`
  or a `fail_criteria` entry — not just in `known_wrong` or `SKILL.md` prose.
  `anti_patterns` is authoring metadata for I6/I7; without I7c a token could
  satisfy I6/I7 by construction while the judge itself is never actually told
  about it, which makes the token a hint to the author, not something the
  grading ever exercises. **`anti_patterns` tokens must be literal
  constructs** the judge can check against the answer (a suppression
  comment, a type name, an API call) — not a prose phrase copied from the
  authored `known_wrong` text, which would trivially satisfy every one of
  these rules by construction without the judge ever needing to recognize the
  construct itself.

`anti_patterns` itself is optional — a scenario with no clean single-token
anti-pattern (for example, `go-implementation`'s `context-propagation`
scenario above) can omit it.

## The anti-gaming requirement

Every judge scenario must be proven hard to game against eight canned
answers (`antiGamingAnswers`, `src/gdskills/governance/judge.ts`; fix 1 /
R1-4, R1-11 widened this from six kinds to eight):

| Kind | Built from | Must grade |
|---|---|---|
| `empty` | `""` | FAIL — never reaches the judge; `gradeScenarioAnswer` short-circuits it |
| `echo` | `"Sure. You asked: " + prompt` | FAIL |
| `vague` | `calibration.vague` | FAIL — points in the right direction, shows no concrete fix |
| `known-wrong` | `calibration.known_wrong` | FAIL |
| `subtle-wrong` | `calibration.subtle_wrong` | FAIL — realistic-sounding, still wrong |
| `injection` | `known_wrong` + a paragraph telling the grader to output pass | FAIL |
| `stuffed` | `known_wrong` + the rubric and every pass/fail criterion pasted in | FAIL |
| `known-right` | `calibration.known_right` | PASS |

`injection` and `stuffed` prove the judge itself resists two specific
attacks: a direct prompt injection telling it to override its instructions,
and keyword-stuffing the rubric's own vocabulary into an otherwise-wrong
answer. Both are built ON TOP OF `known_wrong`, so a scenario cannot pass
them just by having a `known_wrong` that happens to already fail on its own
merits — the judge has to resist the added attack text specifically.
`vague` and `subtle-wrong` prove something different: not resistance to an
attack, but that the judge actually enforces the concreteness rule and
catches a realistic failure mode, rather than passing anything that gestures
in the right direction or sounds confident. Review round 1 on PR #698 found
the live judge passing some `vague` answers before this fix — see the
concreteness rule above.

### Recording the calibration

```
keryx skills judge-check <skill-id> --judge <provider>[:<model>] [--scope bundled|all] [--samples <n>] [--record] [--json]
```

Runs all eight canned answers for every judge scenario in the named skill
through the **live** judge (not a stub) and exits `1` if any verdict does
not match what that answer expects. The live judge is not deterministic on
identical input — review round 1 caught it flipping verdicts on the same
canned answer across two calls — so each non-`empty` canned answer is graded
`--samples` times (default **3**) rather than once, and a canned answer only
counts as matching its expectation when **every** sample agrees and none
errored. `--record` writes all of those samples (not a single verdict) to
`src/gdskills/governance/judge-recordings/<pack>__<skill>.json` — a stable,
diff-friendly JSON file the integrity guard replays offline. Recordings, in
other words, are **samples**: a recorded entry for a canned answer is proof
that a live judge, checked at record time, agreed with itself `--samples`
times in a row on that exact input — not proof that it always will.

A recording goes stale, and the integrity guard's anti-gaming (AG) check
fails closed rather than silently reusing it, when:

- **the recorded `requestDigest` no longer matches** a freshly-built
  request — the rubric, pass/fail criteria, prompt, or answer changed since
  the recording was taken;
- **`judgePromptVersion` in the recording is not the current
  `JUDGE_PROMPT_VERSION`** (`src/gdskills/governance/judge.ts`) — the judge's
  own system/user prompt text changed;
- **the recording is missing entirely** for a scenario that carries a judge
  expectation;
- **any recorded sample for a canned answer disagrees with another**, or
  carries a parse `error` — a recording is only trusted when its samples are
  unanimous.

Any of these names the exact fix in its failure message: re-run
`skills judge-check <skill-id> --judge ... --record`.

A recording is a **hand-writable file** — anyone with write access to the
repository can compute a `judgeRequestDigest` and author the expected
samples without ever calling a judge. Treat it like any other committed
artifact whose truth depends on the process that produced it: the real
control is reviewing the recording's diff in the pull request alongside the
scenario it backs, not the recording's mere presence. See the gate's own
threat-model note in `docs/requirements/keryx-agent-platform-expansion/
workstreams/W1-stack-catalog.md` for the same point applied to `eval`'s
trial records.

## The opt-in live check

`src/commands/stack-pack-judge-calibration.live.test.ts` runs the same
anti-gaming set against a real DeepSeek call, but only when
`KERYX_LIVE_JUDGE=1` is set — it costs real tokens and money, so it never
runs by default in CI or locally. Every other integrity check, including the
AG rule above, runs against the **recorded** verdicts and needs no network
access or `KERYX_LIVE_JUDGE`.

Flow 317 added a related but distinct live check: `keryx skills eval
--reverify <pack-dir> [--sample N] --judge <provider>[:<model>]` re-judges a
random sample of already-recorded TRIAL outputs (not the canned anti-gaming
answers `judge-check` uses) against the current live judge, and reports
where the live verdict disagrees with what was recorded. It closes a
different gap than `judge-check`: hard-to-game rubrics (`judge-check`) vs.
judge-verdict provenance and drift (`--reverify`) — see the CLI reference's
threat-model paragraph for `eval --reverify`.

## The full integrity rule list

`src/gdskills/stack-pack-eval-integrity.test.ts` enforces these permanently
on every scenario in the shipped tree:

- **I1.** fails when graded against the empty answer `""`.
- **I2.** fails when graded against the echo answer
  `"Sure. You asked: <prompt>"`.
- **I3.** a scenario with no judge expectation carries at least one
  POSITIVE (`contains`/`regex`) expectation that does not already match the
  prompt text itself; a judge scenario instead carries at least one
  non-empty pass criterion, a non-empty rubric, and a calibration set whose
  four answers are all non-empty and pairwise different.
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
- **I7c (fix 1 / R1-7).** every `anti_patterns` token appears
  (case-insensitive) in the scenario's own judge expectation — its `rubric`
  or a `fail_criteria` entry.
- **I8.** a judge scenario carries no `not-contains` expectation.
- **I9.** every stack-pack behavior scenario is a judge scenario.
- **I10 (fix 1 / R1-6).** no `fail_criteria` entry is a negation-only note
  (for example, a standalone "Mentioning X only to warn against it is not a
  failure.") — that sentence must be folded into the fail criterion it
  qualifies, never listed as its own criterion.
- **AG (anti-gaming).** for every judge scenario, every canned answer
  (`empty`, `echo`, `vague`, `known-wrong`, `subtle-wrong`, `injection`,
  `stuffed`, `known-right`) grades, through the recorded live judge, to
  exactly the outcome that answer expects — unanimously across all of a
  recorded canned answer's samples. A missing recording, a stale
  `judgePromptVersion`, a non-unanimous or errored sample, or a recording
  missing the digest for one of these answers fails the check outright —
  never a silent skip, never a pass by omission.

## How the stable-pack gate uses this

A pack's `stability` may only be `"stable"` once every skill's recorded eval
report clears `checkSkillReportForPackGate`
(`src/gdskills/governance/eval.ts`), which requires, on top of the integrity
checks above:

- `strictness: "high"`, `trials >= PACK_MIN_TRIALS` (`10` as of flow 317 —
  raised from `5`: several scenarios in the first honest runs sat exactly on
  the `PACK_BEHAVIOR_PASS_FLOOR`, one flipped trial away from failing either
  direction; doubling the trial count halves that single-flip swing), `scope: "bundled"`;
- `(runner, model)` and, when the report has any judge scenario,
  `(judge, judgeModel)` both in `STACK_PACK_GATE_POLICY`
  (`src/gdskills/governance/gate-policy.ts`) — pinned to DeepSeek
  `deepseek-chat` for both roles;
- `runnerPromptVersion` equal to the current `RUNNER_PROMPT_VERSION` (flow
  317: every `--runner` call now appends a uniform "answer in text, no
  tools" system note, since the single-turn runner has no tool wiring at all
  and a model that tries one anyway produces a non-answer);
- `judgePromptVersion` equal to the current `JUDGE_PROMPT_VERSION`;
- every ran behavior scenario's `passRate` at or above
  `PACK_BEHAVIOR_PASS_FLOOR` (`0.8`);
- every ran behavior scenario carrying `trialRecords`, its recorded
  `passes`/`passRate`/trial count matching what those records show, and
  `regradeRecordedReport` finding no discrepancy between the recorded
  `passed` values and a re-derivation from those same records — the judge is
  never re-run at gate time; "re-derive" means recomputing from the recorded
  outputs and recorded verdicts, not re-judging them.

**What the gate proves, and what it does not.** The checks above prove
internal consistency of a recorded report against the skill's *current*
files: the recorded outputs hash to their recorded digests, the counts and
pass rate are re-derived from the trial records rather than trusted as
self-declared fields, and trigger results are re-scored live against the
current bundled catalog every time. The gate does **not** prove provenance —
the trial outputs, the judge's verdicts, the runner/judge labels, and every
AG recording described above are self-declared by whoever ran the eval, and
nothing here re-runs the judge model against them. The actual control for
provenance is review of the committed `eval.json` / recording diff in the
pull request, the same way any other committed artifact is reviewed. See
`docs/requirements/keryx-agent-platform-expansion/workstreams/
W1-stack-catalog.md`, "Threat model: what the gate proves, and what it does
not (fix 1, R1-2)", for the full statement and the planned follow-up (FU6, a
live re-judge sampler).

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

### The lesson from this flow: a prompt with no code needs a rubric that fits

Two scenarios failed for the same underlying reason before fix 1:
`python-build-fix`'s `mypy-error-no-blanket-suppress` (prompt: "mypy reports a
type error on a function I touched. Fix it.") and, under the hardened judge,
`react-build-fix`'s `no-disable-hooks-lint` (prompt carries no code either).
**When a scenario's prompt contains no code, its rubric must not demand that
the answer name code-level specifics it cannot possibly derive** — the exact
type mismatch, the exact declaration to change — because a genuinely correct
answer to an under-specified prompt is to ask for the missing information (or
to state the fix in general terms) rather than invent a plausible-looking
fake. The fix, in both cases, was not to weaken the rubric to accept a vague
answer (the `vague` calibration must still fail): it was to accept either (a)
asking for the missing concrete detail while correctly committing to the
right kind of fix and refusing the anti-pattern, or (b) a **concrete
illustrative example** — a corrected declaration or dependency array shown as
code, invented for the purpose of demonstrating the mechanism, clearly framed
as an example rather than claimed as the actual fix for code the answer never
saw. Write your `pass_criteria` to accept a concrete illustrative example
whenever the prompt itself supplies no code for the answer to quote from —
otherwise a correct answer that plays it straight ("I don't have the actual
error text — here's the pattern once you do") fails the concreteness rule for
a reason that is really the prompt's fault, not the answer's.
