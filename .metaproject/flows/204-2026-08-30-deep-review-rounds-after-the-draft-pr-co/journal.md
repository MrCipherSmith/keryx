# Flow Journal

- 2026-08-30T05:31:30.403Z - flow created
- 2026-08-30T05:32:26.447Z - task-added: T5: Baseline: record test/typecheck state
- 2026-08-30T05:32:26.542Z - task-added: T6: Blast radius computed from gdgraph affected, ranked, capped, drops recorded
- 2026-08-30T05:32:26.634Z - task-added: T7: Regression scope rejects non-regression findings in code
- 2026-08-30T05:32:26.727Z - task-added: T8: Recompute the blast radius on changed-file set change and always on the final round
- 2026-08-30T05:32:26.820Z - task-added: T9: Test: blast radius is computed and every capped drop is recorded
- 2026-08-30T05:32:26.913Z - task-added: T10: review gate in flow complete, five conditions
- 2026-08-30T05:32:27.005Z - task-added: T11: Clean defined positively per finding; dismissal needs a recorded human decision
- 2026-08-30T05:32:27.098Z - task-added: T12: Test: round cap with unsatisfied gate leaves the flow in-progress
- 2026-08-30T05:32:27.189Z - task-added: T13: Collect PR comments from all three sources, bots as humans
- 2026-08-30T05:32:27.282Z - task-added: T14: External findings: source, external_ref, classified severity, never silently dropped
- 2026-08-30T05:32:27.375Z - task-added: T15: Verifier cannot refute an external finding alone; answered-disagree still replies
- 2026-08-30T05:32:27.469Z - task-added: T16: Reply once at the end, two sentences, threaded, enforced in code
- 2026-08-30T05:32:27.565Z - task-added: T17: Never resolve a thread we did not open
- 2026-08-30T05:32:27.659Z - task-added: T18: Test: one reply and one disposition per comment; idempotent across restart
- 2026-08-30T05:32:27.750Z - task-added: T19: Model tiers in skills; a concrete model name fails a test
- 2026-08-30T05:32:27.843Z - task-added: T20: Tier resolution per provider; unknown provider inherits the session model
- 2026-08-30T05:32:27.936Z - task-added: T21: Deterministic tier assignment recorded in the dispatch
- 2026-08-30T05:32:28.029Z - task-added: T22: Rewrite model-selection.mdc; it forbids adaptive selection today
- 2026-08-30T05:32:28.120Z - task-added: T23: Brevity rule for every outward GitHub artifact, enforced not advised
- 2026-08-30T05:32:28.212Z - task-added: T24: Verify both mirrors; bundled-rule and review-mirror guards pass
- 2026-08-30T05:32:28.307Z - task-added: T25: Quality gate: typecheck, full suite against baseline, guards, doc-links
- 2026-08-30T05:32:28.399Z - frozen: 20 criteria; checksum recorded
- 2026-08-30T05:32:28.490Z - started

## T19-T22 (AC14-AC17) — adaptive model selection

- Resolver: `src/gdskills/model-tier.ts` + `src/gdskills/model-tier.test.ts` (32 tests).
  Placed in `gdskills` because that layer owns the dispatch contract and the skills
  that declare tiers. It PRODUCES the `tiers` map that `src/harness/child/model.ts`
  already consumes, so `resolveChildModel` keeps the three authorization gates and
  nothing is duplicated.
- Skills declare `model_tier: light|standard|deep` in SKILL.md frontmatter.
  Applied to 15 review skills (minus `review-orchestrator`, whose body was being
  edited concurrently, and the four legacy opt-in profiles) plus `code-verifier`,
  `job-documenter`, `task-implementer`, `autodoc-architect`. Both trees.
- AC15 fallback: `buildTierMap` is TOTAL over `light/standard/deep/cheap`, so
  `resolveChildModel`'s `unknown model tier` denial is unreachable, and an
  unclassifiable provider gets the session's provider AND model for every tier.
  Tested end-to-end through `resolveChildModel` with a real-but-unmapped provider
  (`zai`), plus a negative case proving the dispatch IS denied without the map.
- AC16: `assignTier` is pure and returns ordered rule ids; recorded on the dispatch
  as `model.tier_reasons` alongside `tier`, `provider_family`, `tier_resolution`
  (schema + `.metaproject/core/` mirror). Floors are applied AFTER downgrades, so
  "at least deep" holds for a blast-radius round over a tiny diff.
- AC14 enforcement is two-sided: `model.tier` is now an ENUM in the contract (a
  model name cannot be written into it), and `concreteModelDeclarations` sweeps
  every SKILL.md in both trees for a model ASSIGNMENT (not a mention).
- AC17: `model-selection.mdc` rewritten in `src/gdskills/bundled/rules/core/` and
  mirrored. "Always ask user before changing model for sub-agents" and the stale
  `gpt-5.x-codex` list are gone; a test asserts both stay gone in both trees.
- Vocabulary conflict recorded: `docs/requirements/keryx-multi-agent-engine/schemas/
  child-model-selection.schema.json` freezes `cheap/standard/deep`, and
  `src/harness/child/escalation.ts` uses the same ladder. AC14 names `light`.
  `parseModelTier` reads `cheap` as `light`; the frozen schema was not touched.
- Gates at hand-off: typecheck clean, `test:guards` 161/0, `check:doc-links` 0
  broken. Full `bun test` 5731 pass / 18 skip / 9 fail — all 9 in `src/flow/**`
  and `src/review/**` (concurrent AC5/AC10 work), none in the files above.
  `src/sac/fwk-service.test.ts` passed this run.

## T6-T9 (AC1-AC4) — scope B, the blast radius

- New module `src/review/blast-radius.ts` + `blast-radius.test.ts` (43 tests).
  Pure over `(GraphData, changedFiles, testFiles, config)` — no fs, no network,
  no model — so the defaults could be measured rather than asserted. Wired as
  `keryx review blast-radius`.
- **Depth 2, measured, not accepted from the spec.** 80 commits touching `src/**`
  against a 1,041-node / 3,147-edge graph, set size after dedup and the scope-A
  path exclusions:

      depth 1: median 7,  p75 18, p90 30,  max 86,  >40 files on 3% of commits
      depth 2: median 19, p75 41, p90 65,  max 143, 25%
      depth 3: median 27, p75 48, p90 106, max 213, 39%
      depth 4: median 27, p75 52, p90 146, max 242, 41%

  Depth 1 sees 41% of depth 2 (hop-1 contributed 487 entries against hop-2's 711
  over 40 commits). Depth 3 adds 8 files in the median and doubles the p90; depth
  4 is indistinguishable from 3 because the graph saturates. Depth 2 confirmed.
- **Cap 40, confirmed on what it cuts rather than how often.** It fires on 20 of
  80 commits (25%), and on 18 of those 20 it removes only hop-2 entries — only 2
  commits in 80 have more than 40 DIRECT dependents. Cost (AC-D5): the capped
  depth-2 set is a median 582 KB / p90 1,057 KB of source, 9.9% of the graph's
  10.7 MB — affordable as a file list with dependency paths, not inlined.
- **Related-test lookup kept, but narrowed, and the spec's version rejected.** All
  481 test files are graph nodes and a test importing its subject is a hop-1
  dependent, so the covering tests are already in the set. Running the naming
  heuristic over the changed files AND the radius adds 1,154 tests over 80
  commits: 389 unreachable from the change at ANY depth, 259 reachable only at
  depth >= 3 — i.e. re-adding exactly what the depth bound just excluded.
  Restricted to the CHANGED FILES only it adds median 0 / p90 5 / max 8 and fires
  on 18 of 77 commits. That is what shipped, ranked below every graph entry so
  the cap reaches it first.
- AC1: `dropped[]` carries every cut file with hop, fan-in, `via`, source and the
  rule that cut it (`cap` or `pre-filter`); `unresolved[]` carries every changed
  file the graph could not answer for. A test asserts `retained + droppedByCap +
  droppedByPreFilter === candidates`, so nothing can vanish between the two lists.
- AC3 is four deterministic rules in `screenBlastRadiusFindings`, not prose:
  `outside-set`, `non-regression-dimension` (reviewer identity, name normalised
  like `verification.ts`'s private `actorKey`), `non-regression-severity`
  (`minor` means "the code behaves correctly" under the canonical rubric, so it
  cannot be a regression claim; floor configurable), `no-link-to-change` (nothing
  in the finding names a changed file, module or symbol). Rejections are returned
  and rendered, never dropped.
- AC4: `blastRadiusRecomputeDecision` evaluates `isFinalRound` BEFORE the
  file-set equality check, so an unchanged set cannot suppress the final-round
  recompute. `--previous <json> [--final]` makes it mechanical.
- Known gaps, stated rather than implied: (a) the record is written to
  `blast-radius.md`/`.json` and is NOT referenced from `manifest.artifacts` —
  `REQUIRED_ARTIFACTS` is a closed list and adding a seventh strands every
  package on disk; `review ingest` therefore does not carry the block forward the
  way it carries `## Pre-filter scope`. (b) No `review-regression` reviewer skill
  exists; `screenBlastRadiusFindings` accepts the name when one is created.
  (c) The graph sees no Markdown, JSON or shell file: 428 of 897 changed files in
  the measured history have no node, so a skill/rule change has no radius at all.
- Gates: typecheck clean apart from `runComments` (concurrent AC8-AC13 work),
  `test:guards` 161/0, `check:doc-links` 0 broken, both skill mirrors byte-equal.
  Full `bun test` 5817 pass / 18 skip / 1 fail — the one failure is
  `src/review/managed.test.ts` asserting `FINDING_DISPOSITION_STATES` against the
  concurrent addition of `answered-disagree`. `src/sac/fwk-service.test.ts`
  passed both in the suite and in isolation.

## 2026-08-30 — T10/T11/T12: the review completion gate (AC5, AC6, AC7)

- A sixth gate in `src/flow/service.ts` `complete()`, between `tasks` and
  `health`. Implementation in `src/flow/review-gate.ts`; 35 tests in
  `src/flow/review-gate.test.ts`; hand-written package fixtures in
  `src/flow/review-fixtures.ts` (test scaffolding, imported by four suites, so
  not a `.test.ts` file).
- Opt-in per package on the flow-201 precedent: `gates.review`, written by `flow
  init`, declared in `flow-state.schema.json` (runtime + regenerated docpack
  copy). A package without the flag reports `skipped`, so no historical package
  is retroactively invalidated — including this one.
- AC6 is implemented as a rule about EVIDENCE, not about the latest file. The
  six persisted disposition states map onto the specification's three:
  `acted-on` = `fixed` (needs a SHA in the disposition evidence AND a verifier
  `refuted` verdict whose own evidence cites that SHA), `dismissed-incorrect` =
  `refuted` (needs a verifier `refuted` verdict with method and evidence), the
  other three `dismissed-*` = `dismissed` (need a named human decision).
  Everything else, including `unknown` and an absent disposition, is
  non-terminal.
- The absence hole is closed by evaluating the union of every ingested round,
  taking the LATEST record of each finding identity (`findingIdentities` from
  `review/loop.ts`, plus a union-find over the key sets). A blocker raised in
  round 1 and simply not re-reported in round 2 still blocks: vanishing is not a
  disposition. §2.2 says "the latest round" and §2.1 says "every finding ever
  raised"; this reads the first as "the latest state of each finding", which is
  the only reading that satisfies the second.
- `unobserved` is a first-class condition status distinct from `violated`, and
  BOTH fail. A gate that passes because nothing was recorded is the defect this
  gate exists to remove; it does not become acceptable by being spelled "we could
  not check". `skipped` is reserved for "this package did not opt in" and for an
  explicit `require_clean_round: false`.
- AC7: `complete()` already returns a failing flow to `in-progress`; what was
  added is that when `roundsSeen >= 3` the detail SAYS the cap is spent and the
  decision is the operator's, so a bare failure is not mistaken for "run another
  round". `REVIEW_ROUND_CAP` is duplicated as a constant here because the bound
  lives only as a sentence in three skill files, which this task may not edit.
- Configuration: `.metaproject/tasks.config.json` `completion.severity_floor`
  (`blocker`/`major`/`minor`, default `minor`; `info` is clamped with a note) and
  `completion.require_clean_round`. A malformed file yields defaults PLUS a note
  rendered into the gate detail — never a silent fallback.
- `TrackerAdapter.prStatus` now returns an optional `headSha` (`gh pr view --json
  headRefOid`). Optional, so no adapter outside `src/flow/` breaks; `null`/absent
  means UNKNOWN, which the gate reports as unobserved rather than as a match.
- **Dependency on the external-comment work (AC8–AC13), which had landed nothing
  when this was written.** No shape was guessed. Two seams, both satisfiable
  without editing this gate: (1) `FlowServiceDeps.externalCommentsGate`, a
  function returning `{ collected, unanswered[], detail }` — wire it in
  `src/commands/flow.ts` `getService()`; (2) the round record itself — findings
  carrying `source: "external"` (each needs a terminal disposition AND an
  `external_ref.reply_url`, per AC13's "exactly one reply"), or a coverage entry
  in `manifest.coverage` named one of `EXTERNAL_COMMENT_COVERAGE_REVIEWERS`
  (`external-comments`, `pr-comments`, `review-comment-collector`) with status
  `run`. With a PR present and none of these, the condition is UNOBSERVED and the
  gate fails, naming both seams in the message. With no PR it passes: no PR, no
  comment anyone could have left.
- Where the specification is wrong, and what was implemented instead:
  - §2.2 condition 5 requires the verifier to have run in **`filter`** mode. The
    same document's Configuration table sets `verification_mode` default to
    `annotate`, and `src/review/types.ts` documents `annotate` staying the
    default "for one release" precisely so the drop rate is measured before it
    costs a real finding. Requiring `filter` would make every flow that follows
    the documented default un-completable. Implemented as "the verifier ran and
    its stats are recorded"; `off` is a violation, `annotate` and `filter` pass.
  - §2.1 and §2.2 disagree about the scope of the disposition check (see above).
  - §2.1 requires "a human decision recorded" for a dismissal, and nothing in the
    repository records one. It is enforced as an attribution requirement — the
    evidence must name who decided (`human:`, `operator:`, `decided-by:`, …).
    Stated plainly in the code: this cannot stop an orchestrator writing
    `human: alice` about a decision alice never made. What it guarantees is that
    dismissing requires naming a person, in a form an auditor can grep and alice
    can contradict. That is strictly more than the previous state, which required
    nothing.
- Baseline check: the recorded baseline is 5707 pass / 18 skip / 1 fail
  (`src/sac/fwk-service.test.ts`, machine-local). After this work: 5815 pass /
  18 skip / 3 fail on a full run. Run in isolation, only
  `src/sac/fwk-service.test.ts` fails; the other two
  (`src/gdskills/review-skills-iron-laws.test.ts` "installed mirror carries the
  same laws", `src/harness/tool/builtin/spawn-subagent-child-slate.test.ts`
  tmpdir leak) PASS in isolation and belong to concurrent work in this tree, not
  to this change. `src/flow`, `src/commands/flow`, `src/harness/flow`, `src/mcp`
  and `src/review` together: 647 pass / 0 fail. `typecheck` clean, `test:guards`
  161/0, `check:doc-links` 0 broken.
- Docs updated with the code: `docs/docs/cli-reference.md` (a "The `review`
  completion gate" section) and `.metaproject/modules/tasks.md` (a "Completion
  gates" section).

## T13-T18, T23 - external PR comments (AC8-AC13, AC18)

- New `src/review/pr-comments.ts` + `src/review/pr-comments.test.ts` (70 tests):
  collection from all three GitHub sources, severity classification, conversion to
  external findings, the AC10 verdict rule, brevity enforcement, reply routing,
  posting, and durable state.
- Every GitHub call goes through an injected port. `createFixturePort` answers
  reads from JSON and records writes; `createGhPort` shells to `gh api` and holds
  no logic. Nothing in the test suite or in a `--fixtures` run opens a socket.
  Nothing was posted to a live pull request.
- AC12 is a property of the port, not a rule someone follows: `guardGitHubRequest`
  allows exactly three reads and two writes. `graphql` - and therefore
  `resolveReviewThread`, `unresolveReviewThread`, `minimizeComment` - is
  unreachable. A source-text test asserts those names appear only inside the
  sentence explaining their absence.
- AC11 two-sentence budget is applied, not requested: `enforceReplyBrevity` CUTS
  to the budget and appends the link, so the long version is not reachable from
  its return value. Truncating with no link to point at throws. A fenced code
  block in a reply throws (link, do not paste).
- AC10: `applyExternalVerdictRule` runs after `mergeVerifications` in `managed.ts`.
  A `refuted` verdict on an external finding never removes it and never becomes
  `dismissed-incorrect` - it becomes `answered-disagree`, which is NOT in
  `FINDING_DISMISSAL_STATES` and still owes a reply. Reclaims are rendered into
  `scope.md`.
- AC9 side effect worth naming: external findings bypass the per-reviewer findings
  cap (`partitionExternalFindings`). That cap drops silently, and `reviewer` on an
  external finding is the commenter's login, so 30 CodeRabbit comments would have
  truncated to 10 with 20 people unanswered.
- AC13 durability: `.metaproject/reviews/pr-comments/<owner>__<repo>__<n>.json`,
  written after EVERY post. Tests cover the restart case (state re-read from disk,
  zero posts) and the crash-mid-pass case (first reply recorded, rerun finishes).
- Contract: `review-finding.schema.json` gains `source`, `external_ref` and the
  `answered-disagree` disposition state, mirrored into
  `.metaproject/core/gdskills/contracts/`. `scripts/review-precision-baseline.ts`
  gains `answered-disagree` as a category - NOT in the precision ratio - because a
  state the writer emits and the measurement does not know is reported as a stale
  ledger and exits 1. A new test pins that invariant against the file rather than
  against a copied list.
- CLI: `keryx review comments collect|reply`, both accepting `--fixtures`, and
  `reply` accepting `--dry-run`. `reply` refuses without `--final`.
- Skill body updated in both mirrors (byte-identical): Step 0 / Step 14 in the
  workflow, `pr_comments` in the input contract, `## External PR comments`, and
  `## Everything written to GitHub is brief`.
- Exported for the T10 completion gate: `unansweredComments(state)` and
  `readPrCommentState(cwd, repo, number)`.
- Suite after these changes: 5888 pass / 18 skip / 1 fail
  (`src/sac/fwk-service.test.ts`, machine-local, pre-existing). typecheck,
  test:guards and check:doc-links clean.

## T19-T21 rework — the family table is gone (operator correction)

The first pass shipped a hardcoded family -> model table (`PROVIDER_FAMILIES`:
Claude `sonnet`/`opus`/`fable`, Codex `terra`/`sol`). The operator rejected it:
*"Don't hardcode models. The orchestrator should determine its provider's models
at runtime and decide itself. If it cannot work it out, it takes its own model."*

The first pass's own report was the evidence. `fable` appeared nowhere else in
this repository; the three Claude names were CLI aliases rather than provider
model ids; Codex was given two models for three tiers. A table written from one
conversation is stale the day a provider ships anything.

**What replaced it: discover -> rank -> fall back.**

- **Discover.** `rankDiscoveredModels(session, catalog)` takes the catalogue as an
  ARGUMENT — a structural subset of `DetectedProvider` (`{name, models}`), so
  `detectProviders()`'s output is passed in verbatim. The module reads no network,
  no filesystem, no environment; the default catalogue is `[]`, so a caller that
  discovers nothing gets the safe direction rather than a built-in list. Tests
  inject literal catalogues and stay offline.
- **Rank.** Only the session provider's own models are candidates, so a child can
  never resolve onto a provider the parent holds no grant for (G1 preserved).
- **Anchor on the session model.** `standard` IS the session model; `deep` is the
  highest-ranked discovered model *strictly* above it; `light` the lowest
  *strictly* below. Strictness rules out lateral moves. Anchoring is what makes
  "never a downgrade" checkable rather than hoped for: a tier can only move away
  from the session model in the direction its own name points.

**The knowledge that could not be eliminated, stated rather than hidden.**
Capability cannot be derived from a bare string — `haiku` is smaller than `opus`
and nothing about the two strings says so. `MODEL_RANK_HINTS` is that residue: 16
entries, each a `\b<word>\b` regex over a SIZE WORD (`nano`, `mini`, `lite`,
`flash`, `haiku`, `sonnet`, `medium`, `opus`, `pro`, `max`, `ultra`, …), an
ordinal weight, and a note. It is a different kind of knowledge from a model
table:

- it names words, never models, so it claims nothing about what exists and cannot
  go stale when a provider ships something;
- it is applied to whatever detection reported, so an unfamiliar vendor is ranked
  if its names use those words (`qwen-3-max` > `qwen-3-mini` with no vendor entry
  anywhere);
- a model matching no hint is UNRANKED, which is deliberately not the same as
  ranked zero — collapsing the two would let an unknown model be ordered against
  a known one;
- it is one exported array, overridable per call.

Two guards keep it that shape: a source-text test asserts no model-id-shaped
literal survives in the non-comment body of `model-tier.ts` (including `fable`,
`terra` and `sol` by name, so the rejected table's return would be loud), and a
second asserts every hint pattern matches `^\b[a-z]+\b$` — a shape that cannot
name a model.

**Codenames are unrankable, and that is the honest answer.** `terra`, `sol`,
`luna`, `fable` carry no size, so a session on one falls back to itself. The
rejected table ordered exactly those codenames from a single conversation.

**Three outcomes, three records** (`tier_resolution`, previously two):
`discovered` (a discovered model was assigned), `session-ranked` (ranking WORKED
and placed the tier at the session's own model — always for `standard`, and for
`light`/`deep` when nothing sits below/above), `session-fallback` (ranking was
refused). The last two carry the same `model`, which is precisely why they must
not be collapsed. `model_discovery` records what was on the table when it
happened: `candidates` (as discovered), `ranked` (best-first, unrankable entries
absent), `session_rank`, `fallback_reason`. `provider_family` is gone with the
families. Schema + `.metaproject/core/` mirror updated; both mirrors byte-equal.

**Ranking is refused** when the session names no model, no discovered provider
matches the session's provider id (external CLI runtime, or detection that has
not run), the provider reported no models, or the hints cannot place the
SESSION's own model. The last is the subtle one and the reason for the anchor:
without knowing where the session sits, `light` could pick something larger.
A refusal never fails a dispatch and never downgrades — `buildTierMap` stays
total over `light/standard/deep/cheap`, so `resolveChildModel`'s `unknown model
tier` denial remains unreachable (AC15), still tested end-to-end plus a negative
case proving the map is load-bearing.

`assignTier` is unchanged — the signal -> tier logic was measured sound and is
unaffected. Only tier -> model changed.

**Known gaps, named rather than implied.**

- The hints are English size words. A provider naming models `v1/v2/v3`, by date,
  or by parameter count (`70b`) is unrankable and falls back. A `\b\d+b\b` hint
  was considered and rejected: parameter count is not comparable across families.
- `MODEL_RANK_HINTS` is still knowledge, just knowledge of vocabulary rather than
  of inventory. It can be wrong (a vendor using `pro` for a small model).
- `detectProviders()` returns CURATED static lists for anthropic/openai/gemini,
  so "discovered at runtime" is only as live as that layer. The design is correct
  end to end the moment those become live listings; before this change, making
  them live would have changed nothing.
- Nothing yet CALLS `buildTierMap`/`decideDispatchModel` from a real dispatch
  path — unchanged from the first pass. The producer exists and is total; wiring
  it into the orchestrator is separate work.
- An external CLI runtime (`claude-cli`, `codex-cli`) is not in
  `detectProviders()`'s output at all, so such a session always falls back. That
  is correct-by-default, not a solved case.

Gates: `bun test` 5903 pass / 18 skip / **0 fail** (the machine-local
`src/sac/fwk-service.test.ts` baseline failure did not reproduce this run);
`model-tier.test.ts` 46 tests. Two mutation checks confirm the fallback tests
bite: removing the `!ranking.usable` guard fails 5 tests, relaxing the strict
rank comparison to `>=` fails 3. typecheck clean, `test:guards` 161/0,
`check:doc-links` 0 broken across 1130 links, both mirrors byte-identical.
Working tree only — nothing committed or pushed.

## Round: deep-review remediation — pr-comments and blast-radius (AC3, AC13, AC18)

Six defects from the deep review, each reproduced before being fixed and each
with a test that goes red when the fix alone is reverted.

**AC13 — a kill AFTER the POST landed produced a second reply.** State was
written after every post, which bounds the loss to one comment; it does not close
the window, because the record only ever learns about a reply the process
survived. The write now BRACKETS the request: `handled_comments` carries an
`in_flight: true` marker written before the POST leaves, replaced by the settled
entry when it returns. A marker found on the next run is resolved against the
pull request itself — `findPostedReply` looks for that exact rendered body and,
for a threaded reply, in that exact thread — so the reply is either adopted with
its real url or sent. Chose body-and-thread matching over identity matching
because `state.self` can be null on a resumed state, and a recovery path that
refuses to run without an identity fails in exactly the case it exists for. The
seam that leaves: a retry which REWRITES the reply text would post a second,
different one; that is stated on the function. The old idempotency test crashed
by throwing from the port BEFORE the request was served, so the reply never
existed and the window was never exercised. The new `githubWorld()` port appends
each POST into the read fixtures as GitHub would, and can die after serving one.

**AC13/AC5 — the overflow backlog claimed answers nobody gave.**
`unansweredComments` tested id membership only, so a row with `reply_url: null`
read as answered — despite the code comment beside it claiming the opposite. It
now requires a reply url. `collectPrComments` re-offers such a comment for the
same reason: the gate and the collector disagreeing would make a comment
simultaneously unanswerable and unclearable. The backlog's `reply_url` now also
falls back to a summary posted on an earlier run.

**AC6 — the backlog overwrote the orchestrator's decision.** Every backlogged
comment was stamped `dismissed-deprioritised`, a dismissal on the orchestrator's
own authority. `ReplyPass.backlog` now carries `{ comment, disposition }` and the
record keeps the outcome actually reached. The cap changes how a comment is
answered, never what was decided about it.

**AC3 — the regression screen refused genuine blocker regressions, two ways.**
The reviewer deny-list (`non-regression-dimension`) is gone: sitting after the
`major` floor it could only ever fire on `major`/`blocker` findings, and it
refused a blocker reading "the module graph has a cycle and the CLI fails to
boot" on the grounds that `review-architecture` raised it. Judge the claim, not
the claimant — `outside-set`, the severity floor and the link rule already do
that work, and all three are facts about the claim rather than about its author.
Separately, `findingText` now includes `finding.file`: a finding anchored to a
changed file by rule 1 was then rejected by rule 3 for not repeating its own
filename in prose.

**AC18 — the two-sentence budget bounded sentences, not bytes.** A
3,999-character single sentence was posted verbatim. `enforceReplyBrevity` now
also enforces `DEFAULT_MAX_REPLY_CHARS = 600`: whole sentences are dropped first,
a lone over-long sentence is cut at a word boundary with an ellipsis, the whole
sentence goes into `dropped` so nothing is lost from the record, and a cut with
no link is refused exactly as the sentence budget refuses one.

**Cosmetic — `--brief` contradicted itself on depth.** Related tests rank at
`depth + 1`, so `depth <= 2` sat above a hop-3 row. The header now reads
`graph depth <= 2` and names the related-test hop when one is present.

Concluded wrong in the review: nothing. Two things were left deliberately, and
they are choices rather than omissions — the `Re <url>:` anchor stays outside
both brevity bounds because it is an address rather than an explanation, and the
overflow summary's own `overflow-summary:` record keeps `dismissed-deprioritised`
because that is the summary's disposition, not any comment's.

Flagged, not mine to change (owner of `src/commands/review.ts`): the `keryx
review` help still says "Each reply is at most 2 sentences" with no mention of
the character ceiling, and there is no `--max-chars` beside `--max-sentences`.
Pre-existing and unrelated: `bun test src/review/pr-comments.test.ts` alone exits
1 with 0 failures — a leaked `process.exitCode` from the CLI test, which
reproduces on the HEAD version of that file.

Docs: `cli-reference.md` (`review comments` brevity, the kill window, the backlog
disposition; `review blast-radius` scope-B screen rules and why none of them
reads the reviewer's name) and `guides/review-with-a-record.md` (a new `review
comments` section, "what survives a kill", the deny-list removal, and the usage
block resynced to the real `keryx review` output). Both `review-orchestrator`
skill mirrors updated to three rules and left byte-identical.

Gates: `bun test` **5933 pass / 18 skip / 0 fail** (baseline 5903 / 18 / 0; +30
tests). typecheck clean, `test:guards` 161/0, `check:doc-links` 0 broken across
1,130 links. Working tree only — nothing committed, nothing pushed, nothing
posted to GitHub.

## Review remediation — the review gate's producer, and four ways it read clean

Working tree only; nothing committed or pushed. Baseline on this machine before
the work: `bun test` **5902 pass / 18 skip / 1 fail** — the failure is the
machine-local `src/sac/fwk-service.test.ts` this journal already records twice.
The 5903 / 0-fail figure in the hand-off is that suite passing on a luckier run,
not a different tree.

### B1 — nothing wrote `manifest.target.head`, so `flow complete` was bricked

`ManagedReviewTarget.head` existed, `managed-review-package.schema.json` already
accepted it, and the gate's condition 3 compared against it. No producer set it.
Every flow this build created reported `head-commit (unobserved)` and could not
complete.

- `createManagedReviewPackage` resolves it now. `resolveTargetHead` takes what
  the caller declared, else `resolveGitHead(cwd)` — `git rev-parse HEAD`, output
  shape-checked against `^[0-9a-f]{40}$`, `null` rather than `""` when there is
  no checkout to ask. `buildManifest` takes the resolved target as an argument
  instead of reading `input.target`, so a manifest cannot be built without the
  head having been considered.
- `--head <sha>` on `review start|attach|ingest`, validated as 7-40 hex and
  refused otherwise. Printed on every create and on `review status` — and
  printed as an ABSENCE when it is one, because an operator who has to open
  `manifest.json` to learn the round recorded no head reads silence as a match.
- **Deviation from the review, stated rather than buried.** The review asked for
  "`git rev-parse HEAD`, or the PR head for a `pr` target". The precedence is
  inverted: the local checkout wins even for a `pr` target, and the pull
  request's own head is used only when there is no checkout to ask (a PR
  reviewed from outside a clone) — resolved one layer up in `commands/review.ts`
  so `managed.ts` reaches no network and no test does either. Reason: the two
  values differing MEANS the round ran against something other than what will
  merge, which is exactly what condition 3 exists to catch. Recording the PR
  head there would make the gate pass on the discrepancy it was added to find.

**The evidence is a real CLI run, because a fixture is what hid this.**
`src/flow/review-gate.e2e.test.ts` creates a real git repository, `chdir`s into
it, and calls the operator's own entry points — `flowCommand` and
`reviewCommand`: `flow init` -> `freeze` -> `start` -> `ac confirm` ->
`task done` -> `review ingest` -> `flow complete --merged` — asserting on what
the CLI prints. Five tests on B1: the recorded head equals the repository's real
HEAD (nothing in the test wrote it); `flow complete` prints `all 5 conditions
hold`; stripping `target.head` back out of the package the CLI wrote reproduces
`head-commit (unobserved)` verbatim; `--head` overrides and a stale value is
caught as `violated` rather than trusted; `--head HEAD~1` is refused; a second
round moves the recorded head with the tree. Mutation check: reverting the one
line in `buildManifest` fails two of them with `Received: undefined`.

**What was done about the fixtures.** `src/flow/review-fixtures.ts` wrote
`target.head` from its own option, which is why 35 gate tests were green over a
missing producer. It now carries a header saying so in as many words — *a fixture
proves the READER and can never prove the WRITER* — the standing rule that any
criterion about what a package CONTAINS needs at least one test through the real
CLI, and a pointer to the e2e suite. The fixtures were kept rather than deleted:
they express a truncated manifest, a stale SHA and a package written by an older
keryx, none of which a real run can produce.

### B2 — `answered-disagree` was terminal nowhere

The state AC10 requires the pipeline to produce — `managed.ts` writes it through
`applyExternalVerdictRule` — fell through `findingVerdict` to "not a state this
build recognises", so AC10's own outcome failed conditions 2 and 4 permanently.
It is terminal now when a reply exists (`external_ref.reply_url`, or a reply
named in the disposition evidence) and non-terminal otherwise, with a message
saying that refuting somebody's comment is not answering it. The verdict kind is
`answered`, deliberately not `dismissed`: the two say different things about what
we still owe the person who raised it.

### MAJOR 1 — a round that stopped being readable took its findings with it

`latestFindingStates` filtered to `round.ingested`, so a round whose
`manifest.json` was truncated lost its readable `findings.json` too — and
condition 1 reported `pass` while NAMING the round it had just lost. Two
changes: the evaluation runs over every round, because an unreadable manifest
does not un-raise a blocker sitting in a readable `findings.json`; and condition
1 reports `unobserved` when any round is unreadable instead of stepping over it.
The test asserts both halves against the same package, before and after
`rm manifest.json`.

### MAJOR 2 / MAJOR 3 — condition 4 was a one-flag bypass with an unwired seam

`manifest.coverage` is written by `normalizeCoverage` straight from
`--reviewers`, with `status: "run"` and the reason "selected for managed review
package". `--reviewers pr-comments` therefore completed a flow with any number of
unanswered comments, and the gate reported that the collection "ran and found
nothing". Nothing had run.

- The coverage-name satisfier is gone. `EXTERNAL_COMMENT_COVERAGE_REVIEWERS`
  survives for the failure message and for `review status`, documented as
  explicitly not a way to satisfy the condition.
- `durableExternalCommentsGate` reads what the collector actually writes:
  `readPrCommentState` / `unansweredComments` over
  `.metaproject/reviews/pr-comments/<owner>__<repo>__<n>.json`. An absent file is
  `collected: false` (unobserved); so is a file whose `rounds_collected` is 0;
  neither is "nothing unanswered".
- Wired at the composition root — `commands/flow.ts` exposes `flowServiceDeps()`
  and passes it — AND defaulted inside `runReviewGate`, so a caller that forgets
  the dependency does not get a weaker gate. The exported builder exists so a
  test can assert the wiring: a dependency only tests supply is a dependency
  that is not wired.
- The round-level check (an external finding needs a terminal disposition AND a
  `reply_url`) now runs alongside the collector rather than only when no
  collector is present, so a collector answering "nothing outstanding" cannot
  cover for a package that says otherwise.

### MINOR — `acted-on` accepted an English word as a commit SHA

`\b[0-9a-f]{7,40}\b` matches `effaced`, `defaced`, `facade`, `deadbeef`. Now
eight characters minimum AND at least one digit, which no English word has.
`git cat-file -e` was considered and rejected: it proves existence rather than
shape, and this predicate is applied to packages written in other clones against
commits that may never have been fetched — a gate failing because an object is
not local would fail honest records.

### Mutation checks

Each fix was reverted in isolation and the suite re-run. Loose SHA pattern: 1
fail. `answered-disagree` branch removed: 2 fail. `latestFindingStates` back to
ingested-only: 1 fail. Coverage-name satisfier restored: 1 fail. The
`buildManifest` head line: 2 fail in the e2e suite.

### Docs

`docs/docs/cli-reference.md` (the five conditions rewritten; `--head` documented
under `review`) and `.metaproject/modules/tasks.md` (the completion-gate
paragraph). No skill, rule or schema was edited, so no mirror needed refreshing.

### Gates

`bun run typecheck` clean, `bun run test:guards` 161 / 0, `bun run
check:doc-links` 0 broken across 1130 links.

Full suite after the work: **5933 pass / 18 skip / 0 fail** (5951 across 486
files), against the 5902 / 18 / 1 measured on this machine before it. Net +31
tests; the one prior failure was `src/sac/fwk-service.test.ts`, which passed
this run as it has intermittently throughout this flow.

### What in the review I concluded was wrong

Nothing was wrong on the facts. Every claim reproduced: no assignment to
`target.head` anywhere in `src/review/**`; `findingVerdict` with no
`answered-disagree` branch; `latestFindingStates` filtering to ingested rounds;
`externalCommentsGate` supplied by two test cases and by no production caller;
`\b[0-9a-f]{7,40}\b` matching `effaced`. The one substantive disagreement is
the head-resolution PRECEDENCE for `pr` targets, recorded under B1 above: the
review's "or the PR head for a `pr` target" would make condition 3 pass on
exactly the divergence it was added to detect, so the local checkout wins and
the PR head is the fallback rather than the other way round.
- 2026-08-30T07:11:54.752Z - task-done: T1: Collect remaining context
- 2026-08-30T07:11:55.036Z - task-done: T2: Implement per plan
- 2026-08-30T07:11:55.320Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-30T07:11:55.606Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-30T07:11:55.894Z - task-done: T5: Baseline: record test/typecheck state
- 2026-08-30T07:11:56.178Z - task-done: T6: Blast radius computed from gdgraph affected, ranked, capped, drops recorded
- 2026-08-30T07:11:56.442Z - task-done: T7: Regression scope rejects non-regression findings in code
- 2026-08-30T07:11:56.750Z - task-done: T8: Recompute the blast radius on changed-file set change and always on the final round
- 2026-08-30T07:11:57.027Z - task-done: T9: Test: blast radius is computed and every capped drop is recorded
- 2026-08-30T07:11:57.304Z - task-done: T10: review gate in flow complete, five conditions
- 2026-08-30T07:11:57.597Z - task-done: T11: Clean defined positively per finding; dismissal needs a recorded human decision
- 2026-08-30T07:11:57.897Z - task-done: T12: Test: round cap with unsatisfied gate leaves the flow in-progress
- 2026-08-30T07:11:58.183Z - task-done: T13: Collect PR comments from all three sources, bots as humans
- 2026-08-30T07:11:58.466Z - task-done: T14: External findings: source, external_ref, classified severity, never silently dropped
- 2026-08-30T07:11:58.748Z - task-done: T15: Verifier cannot refute an external finding alone; answered-disagree still replies
- 2026-08-30T07:11:59.026Z - task-done: T16: Reply once at the end, two sentences, threaded, enforced in code
- 2026-08-30T07:11:59.315Z - task-done: T17: Never resolve a thread we did not open
- 2026-08-30T07:11:59.613Z - task-done: T18: Test: one reply and one disposition per comment; idempotent across restart
- 2026-08-30T07:11:59.903Z - task-done: T19: Model tiers in skills; a concrete model name fails a test
- 2026-08-30T07:12:00.203Z - task-done: T20: Tier resolution per provider; unknown provider inherits the session model
- 2026-08-30T07:12:00.481Z - task-done: T21: Deterministic tier assignment recorded in the dispatch
- 2026-08-30T07:12:00.776Z - task-done: T22: Rewrite model-selection.mdc; it forbids adaptive selection today
- 2026-08-30T07:12:01.062Z - task-done: T23: Brevity rule for every outward GitHub artifact, enforced not advised
- 2026-08-30T07:12:01.331Z - task-done: T24: Verify both mirrors; bundled-rule and review-mirror guards pass
- 2026-08-30T07:12:01.630Z - task-done: T25: Quality gate: typecheck, full suite against baseline, guards, doc-links
- 2026-08-30T07:13:30.611Z - ac-confirmed: AC1: src/review/blast-radius.ts computeBlastRadius + ReviewRoundManifest scope_b in src/review/types.ts record the set, the depth and every capped drop; src/review/blast-radius.test.ts asserts the drop list is non-empty when the cap bites.
- 2026-08-30T07:13:30.886Z - ac-confirmed: AC2: computeBlastRadius walks keryx gdgraph affected from the changed files, ranks by edge distance, bounds by depth 2 / 40 files (both measured over 80 commits); no code path takes a model-chosen file list.
- 2026-08-30T07:13:31.166Z - ac-confirmed: AC3: screenBlastRadiusFindings in src/review/blast-radius.ts rejects outside-set findings, findings under the severity floor and findings with no link to the change, in code; the reviewer deny-list was removed because it screened by author, not content.
- 2026-08-30T07:13:31.447Z - ac-confirmed: AC4: blastRadiusRecomputePlan (src/review/blast-radius.ts:552) forces a recompute when the changed-file set differs and unconditionally on the final round; covered in blast-radius.test.ts.
- 2026-08-30T07:13:31.765Z - ac-confirmed: AC5: src/flow/review-gate.ts implements the five conditions and is wired as the review gate in src/flow/service.ts; src/flow/review-gate.e2e.test.ts drives flow init/freeze/start + review ingest + flow complete through the real CLI.
- 2026-08-30T07:13:32.090Z - ac-confirmed: AC6: reviewFindingsGate requires a terminal disposition per finding: fixed needs a commit SHA and a verifier verdict against it, refuted needs method and evidence, the three wont-fix dismissals need a recorded human decision, answered-disagree needs a reply URL. Absence never clears a finding — the check runs over the latest state of every finding ever raised.
- 2026-08-30T07:13:32.392Z - ac-confirmed: AC7: flow complete refuses while the review gate is unsatisfied; the round cap is reported as the blocker and the flow stays in-progress. Covered in src/flow/review-gate.test.ts and end to end in review-gate.e2e.test.ts.
- 2026-08-30T07:13:32.667Z - ac-confirmed: AC8: collectPrComments reads pulls/comments, pulls/reviews and issues/comments; bot authors take the same path as humans — only our own identity is excluded. src/review/pr-comments.test.ts covers all three sources.
- 2026-08-30T07:13:32.938Z - ac-confirmed: AC9: externalFindingsFromComments sets source: external and external_ref, and classifies severity from the review state (CHANGES_REQUESTED -> major, otherwise minor). Lowering requires a terminal disposition with a reason.
- 2026-08-30T07:13:33.163Z - ac-confirmed: AC10: The verifier cannot terminate an external finding: an external finding capped at refuted is rejected by the review gate, which requires answered-disagree plus a reply URL.
- 2026-08-30T07:13:33.466Z - ac-confirmed: AC11: postReplyPass refuses without --final; enforceReplyBrevity cuts to two sentences AND 600 characters, whole sentences first, then a word-boundary cut with the link. --max-sentences/--max-chars expose both from the CLI (src/commands/review-comments-cli.test.ts).
- 2026-08-30T07:13:33.730Z - ac-confirmed: AC12: The GitHub port rejects every resolve/hide/minimise/edit/delete path including the GraphQL resolveReviewThread endpoint (src/review/pr-comments.ts guardGitHubRequest); a resolve attempt fails at the port.
- 2026-08-30T07:13:34.109Z - ac-confirmed: AC13: Reply state is durable in .metaproject/reviews/pr-comments/<repo>__<n>.json; recordSeenComments plus the in-flight marker and findPostedReply make a restart mid-pass reply exactly once. Every collected comment carries one disposition or the gate fails.
- 2026-08-30T07:13:34.387Z - ac-confirmed: AC14: concreteModelDeclarations (src/gdskills/model-tier.ts:758) is the executable half; src/gdskills/model-tier.test.ts walks every real SKILL.md and fails on a model declared instead of a tier.
- 2026-08-30T07:13:34.629Z - ac-confirmed: AC15: rankDiscoveredModels ranks whatever the provider reports at runtime; when nothing is discoverable, tier_resolution falls back to session-fallback and every tier resolves to the session model — never a downgrade, never a dispatch failure.
- 2026-08-30T07:13:34.888Z - ac-confirmed: AC16: assignModelTier derives the tier from scope, attempt count, verifier method and severity, and the result plus tier_resolution is written into the dispatch (contracts/subagent-dispatch.schema.json). No model is asked to rate its own difficulty.
- 2026-08-30T07:13:35.141Z - ac-confirmed: AC17: src/gdskills/bundled/rules/core/model-selection.mdc rewritten: no provider model names, size words only, and the ask-before-changing-a-model mandate that made adaptive selection impossible is gone. Mirrored to .metaproject/rules/core/.
- 2026-08-30T07:13:35.397Z - ac-confirmed: AC18: review-orchestrator SKILL.md section 'One rule, applied to every outward surface' governs PR bodies, comments and replies; enforced in code for replies by enforceReplyBrevity, with the detail linked from the flow package.
- 2026-08-30T07:13:35.658Z - ac-confirmed: AC19: Both trees carry every skill and rule edit; diff -q on review-orchestrator SKILL.md is identical, the bundled-rule guard and the review-mirror guard pass in bun run test:guards (161 pass / 0 fail).
- 2026-08-30T07:13:35.981Z - ac-confirmed: AC20: bun run typecheck clean; bun test 5937 pass / 18 skip / 0 fail; bun run test:guards 161 pass / 0 fail; bun run check:doc-links 1130 links / 0 broken.
- 2026-08-30T07:14:27.771Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/413
- 2026-08-30T09:57:36.883Z - completing
- 2026-08-30T09:57:38.968Z - done: all gates passed
