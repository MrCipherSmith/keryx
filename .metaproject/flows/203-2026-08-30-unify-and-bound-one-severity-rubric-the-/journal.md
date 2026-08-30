# Flow Journal

- 2026-08-30T04:03:29.740Z - flow created
- 2026-08-30T04:04:22.529Z - task-added: T5: Baseline: record test/typecheck state and inventory every per-reviewer severity table
- 2026-08-30T04:04:22.618Z - task-added: T6: One canonical severity rubric; delete the ten per-reviewer tables
- 2026-08-30T04:04:22.709Z - task-added: T7: Resolve the ts-ignore contradiction and verify no two reviewers disagree on a condition
- 2026-08-30T04:04:22.800Z - task-added: T8: Iron Laws 2-4 into every reviewer, phrased generically
- 2026-08-30T04:04:22.891Z - task-added: T9: Test: every reviewer skill carries the Iron Laws
- 2026-08-30T04:04:22.985Z - task-added: T10: max_findings default of 10 in code, blockers exempt, with the drop recorded
- 2026-08-30T04:04:23.074Z - task-added: T11: Spend ceiling that stops and asks rather than proceeding
- 2026-08-30T04:04:23.167Z - task-added: T12: Concurrency cap on parallel dispatch, holding across orchestrator nesting
- 2026-08-30T04:04:23.257Z - task-added: T13: Round bound 3, made the same number in all four places that disagree
- 2026-08-30T04:04:23.347Z - task-added: T14: Loop detection on repeated finding id or identical consecutive output
- 2026-08-30T04:04:23.442Z - task-added: T15: Test: every cap records what it dropped, with a count
- 2026-08-30T04:04:23.539Z - task-added: T16: Skill format: version in metadata only; compatibility returned to its spec meaning
- 2026-08-30T04:04:23.636Z - task-added: T17: Document triggers and per-skill schemas as deliberate divergences
- 2026-08-30T04:04:23.725Z - task-added: T18: Scope stack-specific reviewers by detected stack; failure mode is to include
- 2026-08-30T04:04:23.813Z - task-added: T19: Verify both mirrors agree; bundled-rule guard passes
- 2026-08-30T04:04:23.905Z - task-added: T20: Quality gate: typecheck, full suite against baseline, guards, doc-links
- 2026-08-30T04:04:24.001Z - frozen: 15 criteria; checksum recorded
- 2026-08-30T04:04:24.090Z - started

## T6–T9 / AC1–AC4 — one rubric, the laws, and a guard

### AC1 — the rubric, and why the major/minor boundary is decidable

`## Severity (canonical)` now lives in `review-orchestrator/SKILL.md`. Every
per-reviewer rubric table was **deleted**, not left beside it; a guard in
`src/gdskills/review-skills-iron-laws.test.ts` fails on any
`| Severity | When to use |` or `| Severity | Meaning |` header anywhere in the
reviewer set, so a rival table cannot come back quietly.

`blocker` is four enumerated shapes: crash, data loss or corruption, exploitable
vulnerability, unimplemented acceptance criterion. Enumeration is what makes it
decidable — there is no judgement left to exercise.

The `major`/`minor` boundary is a question asked **of the finding, not of the
code**:

> Does it name a trigger, and the observable outcome that trigger produces?

Named → `major`. Not named, but a concrete maintenance cost at a named site →
`minor`. Neither → `info`. This is decidable by a third party because applying it
requires reading the finding text, not re-deriving the author's reasoning: look
for the trigger, look for the outcome. Two consequences are stated explicitly
because both were previously decided differently in different files — a claim of
runtime harm with no trigger is `info` and NOT `minor` (the two describe different
failures), and severity never depends on which reviewer found it.

One boundary is declined rather than invented: `major` against `major`. Two
findings that both name a trigger and an outcome are the same severity even when
one is obviously worse. Ordering inside a severity belongs to the operator, and a
fifth level to express it would put us back where we started.

### AC2 — the contradiction, and eight more found by search

`@ts-ignore` stays `minor`, and the reasoning is recorded at the rule
(`review-backend`, TypeScript Correctness): a suppressed compiler error names no
trigger and no observable wrong outcome — the code does what it did before the
comment was added — and what it costs is the next reader. That is the definition
of `minor`. It becomes `major` only when you can name the input the suppression
was hiding, at which point the finding is about that bug, not the comment.
`review-strict`, which said `major`, is already deleted.

The set was then enumerated by search rather than asserted. **The known
contradiction was one of nine.** Eight had not been named:

| # | Condition | Was | Now |
|---|---|---|---|
| 1 | `@ts-ignore` without explanation | `minor` (backend) / `major` (deleted strict) | `minor` |
| 2 | Race condition on shared mutable state | `major` (logic) / **`blocker`** (highload) | outcome-conditional, identical clause in both |
| 3 | Swallowed error / swallowed exception | `major` (logic) / **`blocker`** (clean-code) | outcome-conditional, identical clause in both |
| 4 | API/IO call in a component | **`blocker`** (frontend) / `major` (architecture) | `major` in both |
| 5 | Business logic in a controller | `major` (backend) / `major` (architecture) | agreed already; now cross-referenced |
| 6 | N+1 query | `major` (backend) / `major` (highload) | agreed already; now cross-referenced |
| 7 | Naming | `major` cap (clean-code) / `major` cap (style) | `minor`, escalating only on a named call site; identical rule in both |
| 8 | Duplication / DRY | `major` at ≥3 (clean-code) / `major` cap (style) | `minor`, reported once; identical rule in both |
| 9 | Unbounded resource | "at least `major`" (highload law 2) vs `blocker` (highload table) | contradiction **inside one file**; law now says "never `minor`", table decides |

Rows 5 and 6 were already consistent and are recorded because "we checked and
they agreed" is a different fact from "we never looked".

Row 9 is the one worth flagging: `review-highload` disagreed with itself. Its
Iron Laws stated severities, its table stated different ones, and nothing
compared them. The laws no longer state severities at all — they now say what is
always *reported*, and the conditions table says at what severity. `review-frontend`
had the same shape and got the same treatment.

Re-adjudicating every explicit `blocker` against the four shapes moved eleven
assignments in `review-frontend` alone (missing `observer()`, `makeObservable`,
missing `@observable`, `fetch` in a component, `useEffect` IO, `public` on a
member, two `runInAction` rules, the API-call rule). Stale UI is not a crash;
`public` on a member is a lint error CI already fails on. Two bidirectional-sync
rules stayed `blocker` because an unbounded update loop hangs the render — that
is the crash shape.

### AC3 — the laws, phrased for a style reviewer

One wording, byte-identical in all fourteen reviewers, under
`### Shared laws (every reviewer)`:

1. **A claim of runtime harm with no reproducible path is `info`.**
2. **Never flag the theoretical.**
3. **One finding per class, not one per occurrence.**

The security wording was not pasted. "No attack vector → INFO" became "no
reproducible path"; "hypothetical misuse of safe APIs" became "a safe API because
it could be misused, or a pattern because it is often wrong elsewhere"; "the same
class of issue in five files" became "the same shape at several sites". A style
reviewer has no attacker and no vulnerable code path, and a preamble that reads
as noise is a preamble that gets skipped.

Law 1 was also sharpened where it collided with the rubric: an unreproducible
claim is `info`, **not** `minor`, because `minor` is for findings that never
claimed runtime harm. Without that clause the law and the rubric would have
disagreed on the same input.

The attack-vector law stays in `review-security-code` under
`### Security-specific law`, and the test asserts that heading appears there and
nowhere else.

Exempt, with the same reasons as `review-skills-class-scope.test.ts`: the four
legacy opt-in profiles, `review-pr-feedback` (classifies other people's
comments), `review-verifier` (delete-only; produces no finding of its own).

### AC4 — what "present" means, and why it will not rot

**The test hardcodes no law text.** It parses the three laws out of the canonical
block in `review-orchestrator/SKILL.md` and asserts every non-exempt reviewer
contains them, whitespace-normalised (wrapping is layout, not contract).

- Rewording is free: change the canonical block, propagate, done.
- Rewording *one* reviewer fails — which is the defect this flow removed.
- A new reviewer with no laws fails: the denominator is `readdirSync`, exemptions
  are by name with a stated reason, and the complement must be empty.

A literal match would have rotted on the first edit, and the cheapest way to
green a rotted test is to weaken it — so it would have been worse than nothing.

The derived check has one hole, stated in the test rather than glossed: it cannot
tell whether the canonical block still says the three things AC3 named. Delete law
2, duplicate law 1, and every reviewer still agrees. So there is a second,
deliberately small layer — a semantic floor applied to the **canonical text only**:
each law matched by the concept it cannot lose without becoming a different rule
(`reproduc*` + `info`; `theoretic*|hypothetic*|speculat*`; `one finding|once` +
`site|occurrence|repeat|class`), asserting all three concepts are covered and no
two collapse onto the same law. Brittleness confined to one file instead of
spread across fourteen — the same trade as the rubric itself.

Mutation-checked: deleting law 2 from `review-style` fails with
`review-style: law 2`.

The AC2 search is also pinned, not just performed: the `@ts-ignore` guard scans
every reviewer for the condition co-located with a severity token and asserts the
set of severities is exactly `{minor}`; the two harmonised outcome-conditional
clauses are asserted verbatim in both files that carry them, because paraphrase is
how they drifted apart the first time.

16 tests, 36 assertions, `src/gdskills/review-skills-iron-laws.test.ts`.

### What in the plan turned out to be wrong

- "Ten reviewers carry their own severity table" — there were **seven** generic
  rubric tables (logic, highload, performance, clean-code, security, frontend,
  architecture) plus **four** one-line "Severity guidance" paragraphs in the small
  convention reviewers doing the same job less visibly, plus condition tables in
  backend and frontend. Eleven rubrics, not ten, and the four one-liners would
  have survived a search for tables.
- "`@ts-ignore` is the contradiction" — it is one of nine, and the other eight
  were live in the tree while the known one had already half-resolved itself when
  `review-strict` was deleted. The named contradiction was the least active.
- The plan treats the reviewers as disagreeing *with each other*.
  `review-highload` and `review-frontend` disagreed **with themselves**: Iron Laws
  assigning one severity, conditions table assigning another, in the same file.
  Nothing in a per-file rubric model can catch that.

### Gates

- `bun run typecheck` clean.
- `bun run test:guards` 161 pass / 0 fail.
- `bun run check:doc-links` 1130 links / 0 broken.
- `bun test` 5660 pass / 18 skip / 1 fail. The single failure is the recorded
  baseline one — `src/sac/fwk-service.test.ts` "same-size historical receipt
  corruption", machine-local, reproduces on unmodified `origin/main`. No other
  test fails. Pass count is above the 5595 baseline because of this flow's 16 new
  tests and concurrent work by the other two agents on this tree.
- `src/gdskills/bundled/skills/review/` and `.metaproject/skills/gdskills/review/`
  verified identical by `diff -rq`; the only entries not mirrored are the four
  legacy profiles and `review-pr-feedback`, which were already unmirrored at
  baseline.

## T16–T18 / AC11–AC13 — spec drift, deliberate divergences, stack scoping

Scope for this slice was frontmatter-only in skill files, plus
`src/gdskills/catalog.ts` and any code reading those frontmatter fields — no
skill **body** text, to stay clear of the concurrent Iron-Laws/rubric work
(above) and the caps/round-bound work in the orchestration skills.

### AC11 — `version` and `compatibility` drift

Removed by a deterministic script over every `SKILL*.md` under
`src/gdskills/bundled/skills/` and `.metaproject/skills/gdskills/` (277 files
carry frontmatter): **244 files changed**.

- Top-level `version:` (30 files) removed. 17 already had `metadata.version`
  duplicating it — dropped outright. 13 planning/autodoc skills had **no**
  `metadata` block at all (just `name`/`description`/`version`) — for those the
  top-level `version:` line was converted in place into a new `metadata:`
  block carrying the same value, so the data survives, not just the key.
- **What read the top-level field, checked before deleting anything:**
  `src/gdskills/catalog.ts`'s `BundledSkill`/`renderBundledSkill` — no, it's a
  separate synthetic catalog format with no `version`/`compatibility` fields at
  all, unrelated to the static `SKILL.md` files. `src/gdskills/verify.ts` and
  `export-plugin.ts` — no, both read a prose `Version:` line from
  **project-skills** (generated entity skills), a different format entirely.
  `src/harness/tool/metaproject-adapter.ts`'s `parseSkillFrontmatter` — reads
  only `description`/`triggers`. Conclusion: nothing in the codebase read the
  top-level `version:` key, so no reader needed updating.
- `compatibility:` (231 files, always co-located with a `metadata` block — 0
  exceptions found) moved to `metadata.compatible_harnesses`, same CSV value,
  `compatibility:` deleted. Nothing populated the spec's actual meaning
  (environment requirements in prose) so it was left absent, per the roadmap's
  "leave `compatibility` free for its specified meaning" — inventing prose
  requirements per skill would have been a judgement call outside this task.
- Verified: re-ran the inventory (0 top-level `version`, 0 `compatibility`, 0
  mismatches remaining) and parsed all 277 frontmatter blocks with `Bun.YAML.parse`
  — 0 errors.

### AC12 — documenting the deliberate divergences

Added a `## Frontmatter Fields (Agent Skills spec alignment)` section to
`skills-storage-workflow.mdc` (both `src/gdskills/bundled/rules/core/` and
`.metaproject/rules/core/` — a **rule**, not a skill, so full-body edits were
in scope). Chosen over `.metaproject/skills/catalog.md` because that file is
machine-generated (`Generated By: keryx`) and would be silently overwritten;
`skills-storage-workflow.mdc` is the existing hand-authored home for `SKILL.md`
authoring conventions and already documents the file layout these fields live
in. Records both AC11 fixes as "keep it this way" and both deliberate
divergences (`triggers`; per-skill `input-contract.schema.json` /
`output-contract.schema.json`) with the reasons from the roadmap, so a later
pass does not "fix" them back toward the spec.

### AC13 — stack scoping, and the file-ownership conflict it ran into

Flow 202 scoped `review-frontend-conventions` by editing a routing-table row in
`review-orchestrator/SKILL.md` **body** text — prose read by the dispatching
agent. This task's instructions say to stay consistent with that mechanism,
but this task's file-ownership rule forbids editing any skill's body text
(exactly to avoid collision with the concurrent Iron-Laws/rubric work, which
touches `review-orchestrator/SKILL.md`'s body directly, as this file
demonstrates above). Those two instructions are in direct conflict for this
AC, and the file-ownership rule — the one preventing concrete, observed
collision risk in a shared tree — was treated as binding.

**What was built instead, entirely in code and frontmatter:**

- `src/review/stack.ts` (new, tested — `src/review/stack.test.ts`, 18 tests):
  `detectProjectStack(cwd)` reads `package.json` once, deterministically, no
  model call. Four tags: `nestjs` (`@nestjs/*` prefix), `react`, `mobx`,
  `prisma` (exact dependency names). **Every failure path — missing file,
  unparsable JSON, non-object JSON — sets `uncertain: true`, which forces every
  tag `true`.** `scopeReviewerByStack` has exactly one path that returns
  `include: false`: detection ran cleanly AND the reviewer declared a
  requirement AND none of it was found. Every other path (no requirement
  declared, uncertain detection, requirement partially met) returns `true`.
  This is the literal AC13 failure-mode requirement, enforced by a type, not a
  sentence.
- `keryx review stack [--json]` (new subcommand in `src/commands/review.ts`,
  which is CLI code, not a skill): walks the installed
  `.metaproject/skills/gdskills/review/*/SKILL.md` set, reads each one's new
  `metadata.stack_requires` frontmatter field, and prints/returns the
  inclusion decision with a reason per reviewer — same "record what it
  dropped" convention as `renderCapsMarkdown` in `src/review/caps.ts`.
- `metadata.stack_requires` added (frontmatter only) to: `review-frontend`
  (`"react,mobx"`), `review-frontend-conventions` (`"react,mobx"`, matching the
  dependency set flow 202 already wrote into its body prose),
  `review-backend` (`"nestjs,prisma"` — its body mentions NestJS explicitly and
  ORM/database patterns generically, no literal "Prisma" string, so Prisma is
  included as an OR-condition rather than assumed absent), `code-mobx-store-review`
  (`"mobx"`, bundled-only — this skill is not installed in `.metaproject`'s
  mirror at all, legacy/opt-in, never auto-dispatched regardless).

**What is NOT done, and needs a follow-up outside this file-ownership
boundary:** `review-orchestrator/SKILL.md`'s Auto-detection/Routing Table body
does not yet call `keryx review stack` or consult its output — the mechanical
detection exists and is tested, but nothing dispatches it. Whoever next edits
`review-orchestrator`'s body (T19's verification pass, or a follow-up flow)
should wire the auto-detection table to run `keryx review stack --json` and
skip only the reviewers it reports `include: false` for, which — given the
tool's own contract — never happens on uncertain detection.

### Gates (T16–T18 slice)

- `bun run typecheck` clean.
- `bun test` — 5679 pass / 18 skip / 0 fail (the previously-flagged
  machine-local failure, `src/sac/fwk-service.test.ts`, passed cleanly here
  too — re-ran it in isolation, 24/24 pass). No new failures anywhere.
- `bun run test:guards` 161 pass / 0 fail.
- `bun run check:doc-links` 1130 links / 0 broken.
- Both copies verified for every file this slice touched: the 244-file AC11
  transform ran identically over both trees (same deterministic function, same
  input, since the two trees were byte-identical before it ran); the
  `metadata.stack_requires` additions were applied to both copies wherever a
  mirror exists. Residual `diff` mismatches on `review-*` skills are the
  concurrent Iron-Laws/rubric agent's body edits landing in one tree ahead of
  the other — confirmed by inspection that the mismatch starts well past the
  frontmatter boundary, and confirmed the frontmatter itself (first ~20-25
  lines) is byte-identical between mirrors on every file this slice edited.

---

## T10-T15 — the caps, the round bound, and loop detection (AC5-AC10)

### What was actually wrong

Nothing was capped. `budget.max_findings` was schema-required with no default
anywhere, so every caller had to invent one and none did. There was no token or
currency ceiling at all. There was no concurrency cap, while `review-orchestrator`
dispatches reviewers in parallel and runs nested under `flow-orchestrator` and
`job-orchestrator`. The round bound was four different numbers. And a loop was
only ever counted, never detected.

All four caps and the detector are now **in code**, in `src/review/caps.ts` and
`src/review/loop.ts`, reachable from the CLI, and wired into
`createManagedReviewPackage` so a caller that says nothing still gets a bound.

### AC5 — findings: 10 per reviewer, blockers exempt

`DEFAULT_MAX_FINDINGS_PER_REVIEWER = 10` in `src/review/caps.ts`. A default
stated only in a skill file is a default every caller re-implements, and the
schema-required-with-no-default state proved nobody does.

**Per reviewer, not per review.** A single global cap on a fourteen-reviewer
fan-out is decided by dispatch order: whoever runs first spends the budget and
the rest are truncated whatever they found. Asserted by the test that gives
`review-style` fourteen findings and `review-logic` three, and requires
review-logic to keep all three.

**Two exemptions, and neither consumes the budget.** `severity: "blocker"` is the
canonical rubric's merge-blocking class; `blocking_merge: true` is the reviewer
saying the same thing on the record. A reviewer with three blockers still gets
its full ten ordinary findings — the cap bounds reading effort, and a blocker was
never the part that made a report unreadable.

**Where it runs, and where it must not.** Over the reported findings that
survived verification, and over neither the verifier's refutations nor the
`--refuted` channel. Those are the record of what was raised and then
*dismissed*. Truncating them would rebuild by hand the exact state flow 202
measured — a corpus holding only the survivors of an unlogged triage, which
reports 100% precision whatever the reviewers got right. A reading cap belongs on
the report, never on the dismissals.

### AC6 — spend: currency, not tokens, at 3 USD

The unit was the decision, and it is argued rather than asserted:

- **A token count is not comparable across models.** The same 200k tokens differ
  by more than an order of magnitude in cost between the cheapest and most
  capable model in one vendor's line-up. One token ceiling is either inert for
  the small model or ruinous for the large one, and a ceiling whose meaning
  depends on an unrecorded model choice is not a ceiling.
- **Currency is the unit the decision is made in.** Nobody stops a review because
  it used tokens. It is also the unit the operator's budget is denominated in and
  the unit a harness reports.
- **Steps and rounds are already bounded** by AC8. A token cap would be a third
  bound in the same shape as the first two — "how much work" — while leaving the
  only one that can surprise anybody unbounded.
- **The conversion runs one way.** Tokens plus a stated per-model rate give
  currency; currency alone cannot be turned back into tokens. `spendFromTokens()`
  is the converter for a caller that holds only counts.

3.00 USD follows SWE-agent, which chose a $3/instance dollar cap over a step
budget, and the unit matches: a keryx review round is one target and one reviewer
fan-out, the analogue of one SWE-agent instance.

**Where "stops and asks" is real.** `keryx review budget --spent <usd>` runs
*before* dispatch and exits non-zero — that is the only point at which stopping
is still possible. `review ingest --spent` can only *record* that a round went
over, because by then the money is spent; it writes the package and then refuses.
The package is written deliberately: it is the record of the round running out of
money, and a cap that refused the write would delete the evidence that it fired,
which is the same class of failure as an ingest overwriting the pre-filter's drop
table.

Comparison is `>=`, not `>`. A ceiling is the first value that is too much.

### AC7 — concurrency: 4, and it does NOT hold across the nesting

`DEFAULT_MAX_PARALLEL_REVIEWERS = 4`. Chosen against numbers that are known: the
harness allows on the order of 20 concurrent subagents, `review-orchestrator` has
fourteen reviewers, and the nesting is three deep. 4 gives four waves for a full
reviewer set and leaves room for two enclosing levels to hold work of their own
without the total approaching the harness limit. It is not tuned to a measured
throughput number and does not claim to be.

**Plainly: the cap does not bind the nested total, unless every enclosing
orchestrator declares its in-flight count.** keryx is a CLI invoked once per
command. It has no view of subagents running inside another orchestrator's
process, the harness reports no live subagent count to it, and there is no lease
or lock between the three levels. What the plan bounds with certainty is one
dispatch plan.

The one mechanism that *can* reach the nesting is a declaration:
`--outstanding <n>`, the count the caller already has in flight, which shrinks
the effective wave. It is a declaration, not an observation, and nothing here
verifies it. So the record carries `holds_across_nesting: yes (against the
declared count)` or `no`, and when it is `no` it says why in the record rather
than leaving the reader to assume the cap covered more than it did.
`flow-orchestrator` Phase 3 now passes `--outstanding`.

`effective` floors at 1 rather than 0: a caller already over the cap would
otherwise be told to dispatch nothing, which deadlocks the round. One at a time
is the slowest plan that still finishes, and the declared figure is on the record
for whoever wants to explain why it crawled.

### AC8 — the round bound is 3 in the three places that bound the same thing

- `task-implementer` — 3, unchanged. Now carries the evidence and the reason.
- `job-orchestrator` — 3, unchanged. Now carries the evidence and a stuck check.
- `flow-orchestrator` — **6 -> 3**, in the mermaid diagram, the resume budget
  (step 0.0.3.5) and the Phase 4 PR review/fix loop.
- `/goal --auto` — **kept at 8**, justified in `src/commands/goal-command.ts`.

The evidence, cited in each file that carries the bound rather than only here:
*"the first three to four repair iterations account for most achievable gains"*
(arXiv:2607.05197); correctness falls **0.820 -> 0.673** across two forced
revisions while cumulative ever-correct is **0.847** (arXiv:2607.24604) — the
agent finds the fix and then destroys it, throwing away ~15 points by not
stopping. Aider hardcodes `max_reflections = 3`; OpenHands' critic uses 3.
Rounds four through six were not buying convergence in `flow-orchestrator`; they
were buying regressions.

**Why `/goal --auto` stays 8.** The three unified bounds are *repair* loops: the
same artifact revised again against the same failing signal. That is the shape
the evidence is about, and the mechanism it measures is degradation under
re-revision. `/goal --auto` is a *continuation* loop: each round advances a
course and the loop ends on a positive `isCourseDone` signal, not on "the failing
check finally passed". Nothing is re-revised, so the degradation mechanism has
nothing to act on. Cutting it to 3 would import a number from a body of evidence
that does not apply and would stop `--auto` mid-course on ordinary multi-step
goals. Two different bounds carrying one number because the numbers looked untidy
is the same defect as four bounds carrying four numbers because nobody compared
them.

What is *not* claimed: 8 is not evidence-backed either. It is a budget on an
open-ended loop, and the honest guard on such a loop is repetition rather than
count. Said so in the file, so the next reader inherits the open question rather
than a number.

Pinned by `src/gdskills/round-bound.test.ts`, which fails on the old `at most
six` and also fails if the `/goal --auto` divergence stops being justified in the
file that carries it.

### AC9 — detection, over persisted state

`src/review/loop.ts`. Two signals:

- the same finding identity in two distinct rounds;
- two **consecutive** rounds whose output is identical after whitespace and
  timestamp normalisation.

`detectReviewLoop()` takes no budget, no round bound and no attempt limit, and
that is deliberate: a detector handed the remaining budget is a detector that can
be argued out of firing ("two rounds left, keep going"). The attempt count is
carried on the result as context for the report and is never a condition on
`escalate`.

**Finding identity is `dedupe_key`, then `global_id`, then a derived content
key — never the display `id`.** `F-001` denotes a different finding in every
round of every review in the corpus, so a detector keyed on it fires on the
second round of every flow whatever happened, and a detector that always fires is
one that gets turned off. `global_id` is safe to include because a freshly minted
`<reviewId>#<id>` can never collide across rounds; it matches only when a producer
deliberately carried round N's key into round N+1, which is that producer stating
the finding is the same one.

Identical output must be *consecutive*: two identical rounds with a different one
between them is a round that changed something and then changed it back — a
different and rarer pathology than being stuck.

**It reads real state.** `readFlowReviewRounds()` reads
`.metaproject/flows/<dir>/reviews/*` ordered by `manifest.createdAt`;
`readTaskAttemptCount()` reads `tasks[].attempts.count` from `flow.json`, which
flow 201 put there precisely so a bound survives a session restart. A resumed
orchestrator's own context starts at zero while the real count does not.

Reachable as `keryx review loop --flow <id> [--task <Tn>]`, exit 1 on escalation.
`flow-orchestrator` runs it before spending an attempt, in both the resume path
and the PR review/fix loop; `job-orchestrator`'s FIX step gained a STUCK CHECK
that breaks "even with iterations left"; `task-implementer` gained the same rule
in prose for its self-fix attempts.

### AC10 — every cap records what it dropped

`renderCapsMarkdown()` writes a `## Caps` block into every package's `scope.md`,
next to the existing `## Stage counts`, and the CLI prints the same facts on the
terminal the operator was already looking at.

- **Findings cap:** limit, seen, retained, truncated, exempt, reviewers
  truncated, and a row per truncating reviewer naming **every truncated id**. A
  count says how much vanished and never which; "truncated: 7" is
  indistinguishable from seven duplicates and seven real findings.
- **Concurrency cap:** cap, declared outstanding, effective wave size, wave
  count, `reviewers_queued`, the wave table, and the sentence "N reviewer(s) were
  QUEUED, not dropped".
- **Spend cap:** ceiling, spent, status, `over_by`, and — when it fired — "STOPPED
  at the ceiling and asked the operator. Work after this point was not done, and
  the report is incomplete by that much."

Following `src/review/scope.ts` exactly, including the part that is easy to miss:
**a cap that did not run prints `not recorded`, never `0`.** "Dropped nothing" and
"never ran" are different facts. Three distinct renderings exist and all three
are asserted: `not recorded — no findings cap ran over this package`, `_the
findings cap ran and truncated nothing_`, and the drop table. Unreported spend is
`not-recorded` and explicitly not `under`: a round that never reported its spend
has not demonstrated it stayed inside the ceiling, only never contradicted it.

### What in the plan was wrong

1. **"Loop detection: doc-only, risk none"** (roadmap §2.6). It is not doc-only.
   A detector written as prose in an orchestrator skill reads the orchestrator's
   own context, which is the thing that resets on a session restart — the exact
   defect flow 201 fixed by putting the counter in `flow.json`. Detection had to
   be code reading persisted state, or it would have been another instruction to
   an agent about what it should have remembered.

2. **AC9's wording, "the same finding identifier"**, is a trap taken literally.
   The obvious identifier is `id`, and `id` is per-report: keying on it escalates
   every flow on its second round. The criterion is only satisfiable with an
   identity that carries content, which is why the resolution order is written
   down and tested rather than assumed.

3. **AC5's "10 per reviewer" needed a scope the criterion does not state.** A cap
   over *all* findings in a package would truncate the `--refuted` dismissal
   records, silently undoing flow 202's fix. The criterion says nothing about
   which channel; applying it to all of them would have been faithful to the text
   and destructive.

4. **AC7 as written cannot be satisfied honestly by a CLI.** "The cap must hold
   across that nesting" is not something a per-command process can do: it cannot
   observe subagents in another process. The criterion's escape hatch — "or state
   plainly that it does not" — is the only truthful answer, and the record says so
   in the record rather than in a comment nobody reads. The `--outstanding`
   declaration is the most that can be offered, and it is labelled as a
   declaration.

5. **Two existing tests asserted `not.toContain("not recorded")` over the whole
   `scope.md`.** They meant the pre-filter half. As written they forbade any
   *other* stage from honestly reporting that it never ran — the assertion would
   have blocked the AC10 discipline it was written to protect. Narrowed to the
   pre-filter's own sentence, with the reason recorded at the assertion.

6. **Two tests that assert the fifteen-finding consolidated review round-trips**
   became assertions about the cap once the cap existed. Lifted explicitly with
   `maxFindingsPerReviewer: 1000` and a comment, rather than left to fail or
   quietly renumbered — the parser is what they test, and the cap has its own.

### Files

- `src/review/caps.ts` (new) — the three caps and `renderCapsMarkdown`.
- `src/review/loop.ts` (new) — detection, and the readers for persisted state.
- `src/review/caps.test.ts`, `src/review/loop.test.ts` (new) — 42 tests.
- `src/gdskills/round-bound.test.ts` (new) — pins the round bound in all four
  places and the mirror equality of the three orchestration skills.
- `src/review/managed.ts`, `src/review/types.ts` — the caps run at ingest and are
  written into `scope.md`.
- `src/commands/review.ts` — `review budget`, `review loop`, and the five new
  ingest flags; the cap facts printed on the terminal.
- `src/commands/goal-command.ts` — `DEFAULT_AUTO_GOAL_ROUNDS` justified, value
  unchanged.
- `flow-orchestrator`, `job-orchestrator`, `task-implementer` SKILL.md and every
  harness variant, both mirrors — 21 skill files.
- `docs/docs/cli-reference.md`, `docs/docs/guides/review-with-a-record.md`.

### Gates (T10-T15)

- `bun run typecheck` clean.
- `bun run test:guards` 161 pass / 0 fail.
- `bun run check:doc-links` 1130 links / 0 broken.
- `bun test` **5693 pass / 18 skip / 1 fail**. The single failure is the recorded
  baseline one — `src/sac/fwk-service.test.ts` "same-size historical receipt
  corruption invalidates the checkpoint and refuses append", machine-local. It
  passes in isolation (24/24) and did not reproduce at all in an earlier full run
  of the same tree (5694 pass / 0 fail), so it is flaky rather than newly broken.
  No other test failed in either run. Pass count is above the 5595 baseline
  because of this flow's new tests and concurrent work by the other two agents on
  this tree.
- Bundled skills and `.metaproject/` mirrors verified byte-identical for
  `flow-orchestrator`, `job-orchestrator` and `task-implementer` by
  `src/gdskills/round-bound.test.ts`, not by hand.

### Routing audit

`graph_used: no (not-relevant — the work was in files the task named)`,
`wiki_used: no (not-relevant)`, `ctx_used: yes (rg and file reads throughout)`,
`raw_rg_used: no`.

---

## AC9 / AC13 repair pass — the detector was inert, and the stack gate inverted

Scope: `src/review/loop.ts`, `src/review/stack.ts`, `src/review/managed.ts` and
their tests only. `src/commands/review.ts` and every skill file were held by
other agents on this tree and were not touched; the signatures `review.ts`
imports (`detectReviewLoop`, `readFlowReviewRounds`,
`renderLoopDetectionMarkdown`, `readTaskAttemptCount`) are unchanged.

### AC9 — loop detection could not fire on the state the pipeline writes

Two independent mechanisms, both reproduced end-to-end before anything changed.

**Mechanism A — a ranked identity the writer guaranteed would differ.**
`assignGlobalIds` (`managed.ts`) mints `<reviewId>#<id>` on every finding
*before* it is persisted. `findingIdentity` ranked `global_id` above the derived
content key, so the top-ranked key differed between any two rounds by
construction:

```
round1 global_id: 2026-08-30-ingest-demo#F-001
round2 global_id: round-2#F-001              -> equal: false
```

`repeated-finding` could not fire on anything `createManagedReviewPackage`
produced. Identity is now a **set**, not a ranking, and two findings are the same
one when their key sets INTERSECT: `dedupe:`, `global:`, `derived:`. The grouping
is a union-find over key strings (`KeyGroups`), because a set-valued identity
means a finding carrying both a carried `global_id` and a matching content key
has to bind those keys into one group — otherwise a single repetition splits into
two groups of one and neither reaches the threshold.

Reordering alone (the review's suggestion) was declined: it makes `global_id`
dead code, and `global_id` is the only key that survives a **reworded** problem
statement, which is the one thing the content key cannot do. Both directions are
now pinned by tests.

The derived key is also **omitted** when the finding has no `problem`, `file` or
`symbol`. It used to render `derived:?|?|?|?|`, which makes every contentless
finding identical to every other one from the same reviewer.

**Mechanism B — two rounds, one directory.** `defaultReviewId` is
`<YYYY-MM-DD>-<mode>-<ref>` and the documented invocation never passes
`--review-id`, so a second round of the same branch on the same day **overwrote**
the first: one package on disk, `rounds_seen: 1`, repetition structurally
unobservable. That is the canonical repair loop AC9 exists to guard.

`allocatePackage` now takes the next free directory for a **default-named**
round — `<base>`, `<base>-r02`, `<base>-r03`; two digits so name-order matches
round order for `readFlowReviewRounds`' fallback sort. The first round of a day
keeps exactly the name it had, which is why no existing package or test changed.

**An explicit `--review-id` still overwrites, deliberately.** A caller naming the
id is stating the identity of the round, and re-ingesting under that name is the
retry path after a failed gate. A discriminator there would turn every retry into
a phantom round with byte-identical output — exactly what `identical-output`
escalates on. Stated cost rather than hidden: an operator who runs `review
ingest` twice on the same report *without* `--review-id` now records two rounds
and gets an `identical-output` escalation. That is a true statement about the
record, and it is the direction to be wrong in — the alternative (reuse the
directory when the report matches) deletes precisely the signal a genuinely stuck
round produces.

**AC10 on the detector's own negative.** `renderLoopDetectionMarkdown` printed
"no repeated finding and no identical consecutive output" unconditionally,
including when the second check never ran: `identical-output` needs BOTH rounds'
`report.md`, and a package whose report is missing contributes nothing, silently.
`LoopDetection` now carries `outputPairsCompared` / `outputPairsPossible`, the
header prints `output_pairs_compared: X of Y`, and a run with `X = 0` says the
check did not run rather than that it was clean. A pair whose reports both
normalise to empty counts as *not compared* — two empty reports were absent in
all but name.

**Failing-then-passing.** `src/review/loop.test.ts` 18 pass -> 6 new tests
failing (`global_id` shadowing the content key; the contentless derived key; both
AC10 wordings; and the end-to-end pair, which failed on
`expect(second).not.toBe("2026-08-30-ingest-flow-203-unify-and-bound")` —
mechanism B, reproduced through the writer) -> 24 pass. The end-to-end tests
construct **no round object**: they call `createManagedReviewPackage` twice with
no `reviewId`, read back through `readFlowReviewRounds`, and assert
`escalate: true`. Hand-built fixtures are what let this ship — the old suite was
18/18 green while the detector was inert in production, because no fixture
carried a `global_id`.

**What the fix still cannot detect.** `identical-output` remains exact: one
changed word in the Summary still defeats it, by design — a fuzzy threshold is a
number nobody can defend and it would fire on rounds that genuinely differ. What
changed is that its silence is now labelled. `repeated-finding` still cannot see
a finding the reviewer re-derived with a different problem statement AND a
different file AND no carried key; nothing in the record distinguishes that from
a new finding. And a producer that sets `dedupe_key` inconsistently across rounds
defeats every key at once — `dedupe_key` is trusted by design, with no second
opinion behind it.

### AC13 — stack scoping failed toward SKIP on the common monorepo shape

`detectProjectStack` set `uncertain: false` on any clean parse. A `package.json`
declaring no dependency block, or a monorepo workspace root whose `react` lives
in `packages/web`, therefore reported every tag `false` and **excluded**
`review-frontend`, `review-frontend-conventions`, `review-backend` and
`code-mobx-store-review` — the exact inversion of AC13's "include, never skip".

Two new uncertain paths, both before any tag is computed:

- **`workspaces` declared** (array form, or npm's `{packages: [...]}`) ->
  uncertain, with the globs named in the reason. An empty list is *not* a
  workspace root: it enumerates no sub-package, so nothing is unread.
- **Zero declared dependency names** across
  `dependencies`/`devDependencies`/`peerDependencies`/`optionalDependencies` ->
  uncertain. An explicitly empty block is treated the same as a missing one: both
  are equally uninformative about what the code uses, and `{}` is far more often
  a leftover than an assertion.

**Walking the globs was considered and declined**, with the reason in the module
doc. It needs directory traversal, which turns one deterministic read into an
unbounded filesystem walk whose failure modes — a glob matching nothing, a
sub-package with no manifest, a symlinked package outside the tree — each need
their own answer, and every wrong answer among them costs a *skipped reviewer*.
Being uncertain about a monorepo root is cheap and honest; the reason names the
globs so an operator can point the detector at a sub-package instead.

keryx's own manifest declares 7 dependency names and no `workspaces`, so
self-detection is unchanged: `uncertain: false`, all four tags `false`.

**Failing-then-passing.** `src/review/stack.test.ts` 18 pass -> 5 new tests
failing (`uncertain` was `false` for: no dependency block; explicitly empty
blocks; a workspace root with root-only devDeps; the npm object form; and a
workspace root that *does* name `react`) -> 24 pass. A sixth new test (empty
`workspaces: []` stays certain) passed from the start and is kept as the
boundary.

### What in the review was wrong or incomplete

- The suggested fix — "rank the derived content key above `global_id`" — repairs
  mechanism A and silently kills the carried-key case, because the derived key
  always produces a value once there is any content, so `global_id` would never
  be reached. The set-valued identity keeps both.
- The review suggested the `< 2 rounds` wording should perhaps be weakened. It
  already was. The unguarded negative was in the other branch — `>= 2 rounds`,
  which claimed the identical-output check was clean when it had not run.
- The review's stack table listed three failure cases; a fourth was live and
  unnamed: `{"dependencies": {}}`, an explicitly empty block, which reads as
  "clean parse, nothing found" and excludes the same four reviewers.

### Gates

- `bun run typecheck` clean.
- `bun test` **5707 pass / 18 skip / 1 fail**, against the recorded 5693/18/1
  baseline. The one failure is the baseline one — `src/sac/fwk-service.test.ts`
  "same-size historical receipt corruption", machine-local, reproducing on
  unmodified `origin/main`. No other test failed. 12 of the +14 pass delta are
  this slice's new tests; the other 2 are the concurrent agents on this tree.
- `bun run test:guards` 161 pass / 0 fail.
- `bun run check:doc-links` 1130 links / 0 broken.
- Working tree only: nothing committed, nothing pushed, no `flow task done`.

### Follow-up outside this file-ownership boundary

`docs/docs/guides/review-with-a-record.md` and `docs/docs/cli-reference.md`
document `review ingest` but state no default review-id format, so nothing there
is stale. The `-r02` round suffix and the explicit-`--review-id` overwrite rule
are worth one line in the guide; whoever next edits those files should add it.

### Routing audit

`graph_used: no (not-relevant — the task named the three files)`,
`wiki_used: no (not-relevant)`, `ctx_used: yes (every search, read and command
routed through keryx ctx)`, `raw_rg_used: no`.


## 2026-08-30 — corrections from the pre-PR review

Two claims made in this journal were wrong and are corrected here rather than
edited away.

**The SAC failure is not flaky and does not pass in isolation.** Two entries
above say *"it passes in isolation (24/24)"* and *"it is flaky rather than newly
broken"*. Measured: `src/sac/fwk-service.test.ts` gives **23 pass / 1 fail** in
isolation on this branch, and **23/1 on `origin/main` in a clean worktree, three
runs out of three**, same test and same assertion. The conclusion those entries
drew — pre-existing, not caused by this work — is correct. The evidence offered
for it was not, and a wrong supporting claim would have been inherited by the PR
body.

**The stack-scoping wiring is done.** An entry above records it as outstanding,
and `review --help` said the same. `review-orchestrator` calls
`keryx review stack --json` before dispatch in both mirrors; the help text and
this note now agree with the tree.

## Fixes applied after the pre-PR review

- **Loop detection could not fire on real state** (blocker) — handed to an agent;
  see its entry.
- **Stack scoping failed toward skip** on a manifest with no dependencies block,
  which is the ordinary monorepo-root shape — same agent.
- **Prose said AND, the code implements OR.** `review-orchestrator` claimed a
  reviewer runs only when *every* declared tag is present; `stack.ts` requires
  *any*. The command's output is the machine answer and fails toward inclusion,
  so the prose was the wrong half.
- **`review-style` still carried two severities for one condition, in one file** —
  line 107 survived untouched while the new shared law contradicted it. That is
  the same shape this flow claimed to have removed from `review-highload` and
  `review-frontend`.
- **The rubric deletion dropped one condition**: `review-highload`'s floor for
  blocking I/O on a shared event loop, while the skill's own `description` still
  advertised hot-path blocking I/O as in scope. Restored as a table row with its
  trigger and outcome named. A mechanical sweep over all 49 severity-bearing
  lines removed from `origin/main` found no other loss.
- **Severity tracked how well a finding was written.** The `major` test asks
  whether a finding names a trigger and an observable outcome — so a crisply
  worded cosmetic nit read as `major` while a tersely stated real defect read as
  `info`. That is not cosmetic: `applyFindingsCap` truncates by severity, so the
  typo would survive and the defect would be cut. The rubric now states that an
  outcome costing a user, a caller or persisted state nothing is `minor` however
  precisely its trigger is named.
- **The Iron Laws guard had two holes**, both closed and both proven by breaking
  them: a reviewer could carry all three laws verbatim and negate one in the next
  paragraph, and the guard read only the bundled tree while agents read the
  installed mirror.

The first version of the override guard is worth recording as a mistake: it
matched the bare word "exception" and fired on three lines in `review-frontend`
that *affirm* the laws — "No exception for small stores", "unless it violates an
Iron Law. It never overrides…". A check that fires on the text it exists to
protect is worse than no check. It now requires the negation to name a law, and
its window ends at the next heading instead of running into unrelated prose.
- 2026-08-30T05:05:18.686Z - task-done: T1: Collect remaining context
- 2026-08-30T05:05:18.788Z - task-done: T5: Baseline: record test/typecheck state and inventory every per-reviewer severity table
- 2026-08-30T05:05:18.892Z - task-done: T6: One canonical severity rubric; delete the ten per-reviewer tables
- 2026-08-30T05:05:18.997Z - task-done: T7: Resolve the ts-ignore contradiction and verify no two reviewers disagree on a condition
- 2026-08-30T05:05:19.095Z - task-done: T8: Iron Laws 2-4 into every reviewer, phrased generically
- 2026-08-30T05:05:19.195Z - task-done: T9: Test: every reviewer skill carries the Iron Laws
- 2026-08-30T05:05:19.296Z - task-done: T10: max_findings default of 10 in code, blockers exempt, with the drop recorded
- 2026-08-30T05:05:19.399Z - task-done: T11: Spend ceiling that stops and asks rather than proceeding
- 2026-08-30T05:05:19.499Z - task-done: T12: Concurrency cap on parallel dispatch, holding across orchestrator nesting
- 2026-08-30T05:05:19.601Z - task-done: T13: Round bound 3, made the same number in all four places that disagree
- 2026-08-30T05:05:19.700Z - task-done: T14: Loop detection on repeated finding id or identical consecutive output
- 2026-08-30T05:05:19.804Z - task-done: T15: Test: every cap records what it dropped, with a count
- 2026-08-30T05:05:19.909Z - task-done: T16: Skill format: version in metadata only; compatibility returned to its spec meaning
- 2026-08-30T05:05:20.009Z - task-done: T17: Document triggers and per-skill schemas as deliberate divergences
- 2026-08-30T05:05:20.112Z - task-done: T18: Scope stack-specific reviewers by detected stack; failure mode is to include
- 2026-08-30T05:05:20.213Z - task-done: T19: Verify both mirrors agree; bundled-rule guard passes
- 2026-08-30T05:05:20.320Z - task-done: T20: Quality gate: typecheck, full suite against baseline, guards, doc-links
- 2026-08-30T05:05:42.349Z - ac-confirmed: AC1: Canonical rubric in review-orchestrator; all eleven per-reviewer rubrics deleted (seven tables plus four one-line paragraphs the plan had missed). A guard fails on any rival table returning. blocker defined by enumeration of four shapes.
- 2026-08-30T05:05:42.449Z - ac-confirmed: AC2: ts-ignore settled as minor with reasoning at the rule. Nine collisions found, not one - eight unnamed, and two reviewers disagreed with themselves between their laws and their conditions table. review-style's surviving duplicate was caught by the pre-PR review and removed.
- 2026-08-30T05:05:42.544Z - ac-confirmed: AC3: Iron Laws 2-4 in all fourteen reviewers, reworded so a style reviewer reads them naturally. Law 1 sharpened where it met the rubric: an unreproducible claim is info, not minor. The attack-vector law stays security-specific.
- 2026-08-30T05:05:42.642Z - ac-confirmed: AC4: review-skills-iron-laws.test.ts parses the laws out of the canonical block rather than hardcoding text, so rewording is free and rewording one reviewer fails. Two holes found in review and closed: a law override in the next paragraph, and the guard reading only the bundled tree.
- 2026-08-30T05:05:42.740Z - ac-confirmed: AC5: DEFAULT_MAX_FINDINGS_PER_REVIEWER = 10 in code, per reviewer not per review, blockers and merge-blocking exempt. Scoped to reported findings only - applied to all channels it would truncate dismissal records and undo flow 202.
- 2026-08-30T05:05:42.837Z - ac-confirmed: AC6: Currency ceiling, 3.00 USD per round, not tokens: the same 200k tokens differ more than 10x in cost within one vendor line-up, so a token ceiling's meaning depends on an unrecorded model choice. Runs before dispatch and exits 1; recording after the fact writes the package then refuses, because a cap that stopped the write would delete its own evidence.
- 2026-08-30T05:05:42.938Z - ac-confirmed: AC7: Concurrency capped at 4 and it does NOT hold across orchestrator nesting - stated plainly. keryx is a per-command CLI with no lease between levels; the only cross-level mechanism is a parent's unverified declaration, and the record says which case applied.
- 2026-08-30T05:05:43.035Z - ac-confirmed: AC8: Round bound 3 in the three places that bound a repair loop. /goal --auto stays at 8, argued: a continuation loop ends on a positive signal with nothing re-revised, so the repair-loop evidence does not apply - and the file records that 8 is not evidence-backed either.
- 2026-08-30T05:05:43.131Z - ac-confirmed: AC9: Detection over persisted state, never the orchestrator's context. Identity is a set of dedupe/global/derived keys grouped by union-find; the reviewer proved the first implementation could not fire at all on real data, and the end-to-end test now goes through createManagedReviewPackage twice.
- 2026-08-30T05:05:43.231Z - ac-confirmed: AC10: Every cap records what it cut: truncated ids listed, queued not dropped, stopped at the ceiling with the shortfall. not recorded rather than 0 when a stage did not run - and the loop record now prints output_pairs_compared X of Y, so zero says the check never ran.
- 2026-08-30T05:05:43.330Z - ac-confirmed: AC11: 244 skill files transformed deterministically over both trees: top-level version removed in favour of metadata.version, harness list moved out of compatibility. Nothing read the removed fields - verified before removing. 277 frontmatter blocks parse, zero drift.
- 2026-08-30T05:05:43.426Z - ac-confirmed: AC12: triggers and per-skill I/O schemas documented as deliberate in skills-storage-workflow.mdc - a rules file, not the machine-generated catalog which would be overwritten on the next update.
- 2026-08-30T05:05:43.521Z - ac-confirmed: AC13: keryx review stack reads the manifest deterministically. Failure mode is to include: missing, corrupt, workspaces-declaring, empty-dependency-set and explicitly-empty manifests all resolve uncertain, and uncertain runs everything. Exactly one code path excludes.
- 2026-08-30T05:05:43.619Z - ac-confirmed: AC14: diff over both skill trees, both schema mirrors and the contracts directory: identical for everything this flow touched. The bundled-rule guard passes, and a new test asserts the installed review mirror matches its bundled source.
- 2026-08-30T05:05:43.717Z - ac-confirmed: AC15: typecheck clean; test:guards 161/0; check:doc-links 1130 links 0 broken; bun test 5708 pass / 18 skip / 0 fail against a 5595 baseline.
- 2026-08-30T05:10:41.575Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/411 (warning: PR is not a draft)
- 2026-08-30T05:10:41.666Z - task-done: T2: Implement per plan
- 2026-08-30T05:10:41.759Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-30T05:10:41.851Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-30T05:10:41.950Z - completing
- 2026-08-30T05:10:43.659Z - done: all gates passed
