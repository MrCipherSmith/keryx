# Keryx Jev Rule-Conformance Reviewer — Implementation Plan
Version: 0.2.0

Companion to `PRD.md`. Phased as keryx flows, each phase sized to land as one or two
flows with its own acceptance criteria in the repository's own style (see
`.metaproject/flows/299-2026-09-23-a-completion-signature-an-agent-cannot-m/
acceptance-criteria.md` for the house format this mirrors: `- ACn: <single dense
sentence, testable, naming the file/behavior it pins>`).

**Rollout order, per operator direction:** the cheapest, most measurable uses of Jev
(Phase 1) and a reference-document conformance mode (Phase 2) now come before the
hunk-based rule-conformance mechanism (Phases 3-5) that this package originally led
with. Phase 0's client is a shared prerequisite for everything after it.

## Phase 0 — Jev client adapter (plumbing, no reviewer behavior yet)

Goal: one small, tested HTTP client for `POST /api/v1/systemone`, reusable by every
later phase in this plan and by the parallel `keryx-jev-router` work without either
blocking on the other merging first (see Open Question 2).

Draft acceptance criteria:

- AC1: `src/review/jev-client.ts` exports a function taking an injectable `fetch`
  (default `globalThis.fetch`) plus `{model, state, questions}` and returning the
  parsed `{answers, usage}` response, following the exact injected-fetch shape
  `fetchProviderBalance` already establishes (`src/commands/providers.balance.test.ts:8-50`)
  — no vendor SDK, no dependency on `ProviderPort`/`makeProvider`.
- AC2: The client reads its API key via the existing `OPENROUTER_API_KEY`/
  `openrouterKey` resolution path (`src/lib/shell-config.ts:28,253-254`) and refuses
  with a named, non-network error when absent — it never silently sends an
  unauthenticated request.
- AC3: The client estimates the combined `state`+`questions` token count before sending
  (reusing `estimateTokens`, `src/review/cost.ts:42-44`) and refuses a request over the
  64k budget with a named error identifying which side (state vs. questions) is over,
  rather than truncating either.
- AC4: `jev-1.13` and `jev-latest` are named exported constants; the default model is a
  single named constant referenced everywhere a call site needs one, never a literal
  string duplicated across files.
- AC5: Every test in this phase uses an injected fake `fetch` returning a canned
  `Response`; no test opens a real socket. Fixtures for a success response, a
  malformed-JSON response, a non-200 response, and a response missing `usage` each have
  their own test.
- AC6: CI is green on the branch and `keryx health run` passes.

Tasks:
- T1 (S): `jev-client.ts` — request building, response parsing, error taxonomy.
- T2 (S): token-budget pre-flight check using `estimateTokens`.
- T3 (S): credential resolution wired to `shell-config.ts`.
- T4 (M): fixtures + unit tests (success, malformed, non-200, missing-usage, over-budget).

## Phase 1 — Early wins (CI failure triage, reviewer dispatch, finding/comment conformance)

Goal: three narrow, advisory-only uses of the Phase 0 client that need no
rule-extraction machinery, each cheap to measure against data keryx already has.
Corresponds to PRD Requirements 20-23.

Draft acceptance criteria:

**CI failure triage (PRD Requirement 20):**

- AC1: A new, narrow port (following the live/fixture split `GitHubPort` already
  establishes — `createGhPort`/`createFixturePort`, `src/commands/review.ts:1120-1134`)
  fetches one failed job's log excerpt and this repository's recent run history for the
  same job name; no broader CI-API surface is added.
- AC2: Given a failed job's log excerpt and test name as `state`, a `choice` question
  (`criteria: ["flaky", "infra", "real-regression"]`) returns a probability per option.
  Output is advisory text (console or PR comment) naming the top option and its
  probability; it never triggers a rerun, a merge decision, or a status-check write.
- AC3: `keryx review ci-triage --run <id>` (or equivalent) prints the triage for a given
  failed run without requiring any other reviewer or a full round.
- AC4: A test proves no rerun/status-check/merge API call is made regardless of the
  triage output — the advisory path is the only path that exists.

**Reviewer-dispatch scoring (PRD Requirement 21):**

- AC5: Given a PR's diff summary (file list, insertion/deletion counts, not the full
  diff) as `state`, one `noul` question per bundled/project reviewer asks whether that
  reviewer is warranted.
- AC6: A reviewer with a matching deterministic trigger — `metadata.paths`/description
  glob, or a `stack_requires` tag (`descriptionPathTriggers`/`extractStackRequiresField`,
  `src/review/reviewers.ts:175-197,256`) — is dispatched regardless of its Jev score;
  this mechanism can only ADD a reviewer with no such trigger (`pathsSource: "none"`,
  `src/review/reviewers.ts:50`). A test asserts a low Jev score never produces a
  `skipped` coverage entry for a path/stack-forced reviewer.
- AC7: `keryx review dispatch-preview <diff-or-ref> --json` prints the per-reviewer
  score and which reviewers would actually run (trigger-forced ∪ Jev-added), before a
  full round dispatches anything.

**Finding and comment conformance (PRD Requirement 22-23):**

- AC8: For each finding collected in a round, three Jev questions (hunk-support
  `noul`, per-other-finding duplicate `noul`, severity `choice`) produce annotations
  attached to the finding, never a mutation of `problem`/`impact`/`severity`/etc.; the
  annotations never reach `review-verifier`'s `confirmed`/`refuted` vocabulary
  (`src/review/verification.ts`) and never bypass it.
- AC9: For each entry in `unansweredComments` over `PrCommentState.handled_comments`
  (`src/review/pr-comments.ts:1492`), a `noul` question against `{comment text, new
  commit's diff}` produces a probability that the comment is addressed, surfaced only
  as a suggestion in the author's per-finding response step. No code path writes
  `handled_comments` or posts a reply from this score alone — `keryx review comments
  reply` is unchanged.
- AC10: CI is green on the branch and `keryx health run` passes.

Tasks:
- T1 (M): CI run/log-fetch port (live + fixture), scoped to one job's log and job-name
  history.
- T2 (S): CI triage `choice` dispatch + advisory-only output, `ci-triage` CLI.
- T3 (S): no-side-effect test (rerun/status/merge APIs never called).
- T4 (M): diff-summary builder (file list + insert/delete counts, no full diff) for
  dispatch scoring.
- T5 (M): per-reviewer `noul` dispatch scoring + trigger-forced union logic +
  `dispatch-preview` CLI.
- T6 (S): trigger-forced-never-skipped test.
- T7 (M): finding-conformance three-question batch + annotation attachment (no mutation).
- T8 (M): comment-addressed `noul` scoring wired to `unansweredComments`, surfaced in
  `comments reply`'s suggestion output only.
- T9 (M): fixtures + tests for all of the above against Phase 0's fake-fetch client and
  `createFixturePort`, no real network or `gh` call.

## Phase 2 — Reference-document conformance mode

Goal: generalize clause extraction to documents governing process — a PR's own scope
and description, a review report's conformance to a reviewer contract, and code/test
hunks against sibling style/testing documents. Corresponds to PRD Requirements 24-29.

Draft acceptance criteria:

- AC1: A reference document (a rule file, a skill, or a project skill) is extracted
  into normalized clauses (Phase 3's Requirement-4 shape, extended) each tagged
  `state_kind: "pr" | "report" | "hunk"` and `checkable: boolean` (+ `reason` when
  `false`). Extraction reuses the structured/one-off split of Phase 3 — nothing new is
  invented for parsing.
- AC2: A `checkable: false` clause (a live/manual action with no gatherable state —
  e.g. "verified on a live instance") is kept in the normalized set, reported as
  `not_checkable` in every conformance report, and never dispatched to Jev. A report
  that omits the checkable/not-checkable split fails this AC.
- AC3: `pr`-kind clauses are checked against state gathered through the existing
  `GitHubPort` abstraction (`resolvePort`/`createGhPort`/`createFixturePort`,
  `src/commands/review.ts:1120-1134`) — title, body split into named sections, and diff
  stats with `src/review/scope.ts`'s drop-reason taxonomy
  (`lockfile|generated|vendored|snapshot|minified`, `scope.ts:77-87`) reused to exclude
  mechanical bulk from a size-budget clause.
- AC4: `report`-kind clauses are checked against an existing review package's own
  `report.md`/`findings.json` (`ManagedReviewManifest`/`StructuredReviewFinding`,
  `src/review/types.ts:78-138,351-442`) — no new artifact format is introduced to
  support this.
- AC5: `hunk`-kind clauses reuse `buildReviewScope`'s blocks unchanged (Phase 4's
  mechanism, pulled forward for this kind only) — this AC does not require Phase 4 to
  be complete, only its hunk-extraction primitive.
- AC6: `keryx review conform --ref <doc> [--pr <n> | --report <path> | --diff <ref>]
  [--explain] [--json]` selects clause kinds from what was supplied and prints, per
  clause: kind, checkable/not-checkable, and (when checkable) the Jev answer plus,
  with `--explain`, the confirmation-pass explanation citing the clause id.
- AC7: A flagged `pr`/`report`-kind clause is handed to the same confirmation pass as
  Requirement 10/27 and reported to the author/operator (PR comment or console); it is
  never forced into `findings.json`'s per-hunk shape, since it has no `file`/`line` to
  anchor to. A flagged `hunk`-kind clause follows the ordinary Requirement 11 ingest
  path.
- AC8: Every fixture and test in this phase uses invented clause text — no clause
  extracted from a real reference document's wording appears in a committed fixture,
  test name, or comment.
- AC9: CI is green on the branch and `keryx health run` passes.

Tasks:
- T1 (M): clause schema extension (`state_kind`, `checkable`, `reason`) over Phase 3's
  rule record.
- T2 (M): `pr`-kind state gathering (`GitHubPort` title/body/sections/diff-stats +
  mechanical-bulk exclusion).
- T3 (S): `report`-kind state gathering (read existing `report.md`/`findings.json`).
- T4 (S): `hunk`-kind wiring to `buildReviewScope` (shared with Phase 4).
- T5 (M): `keryx review conform` CLI, all three `--pr`/`--report`/`--diff` modes.
- T6 (M): confirmation-pass wiring for `pr`/`report`-kind flags (author/operator report,
  not `findings.json`).
- T7 (M): fixtures with invented clause text + tests for extraction, checkable/
  not-checkable reporting, and each state-gathering path against `createFixturePort`
  and local fixture files — no real network, no real `gh` call, no real reference
  document content.

## Phase 3 — Rule extraction and the rule cache

Goal: turn a skill/`.mdc` document into the normalized rule records PRD Requirement 4
describes, with structured extraction preferred and one-off model extraction as the
documented fallback, both drift-checked. This is the foundation Phase 2's clause schema
extends and Phase 4/5 dispatch against.

Draft acceptance criteria:

- AC1: A `rules:` frontmatter block or fixed `## Rules` section in a skill/`.mdc` file
  is parsed into normalized rule records with no model call, following the same
  frontmatter-parsing conventions `metadataList`/`descriptionPathTriggers`
  (`src/gdskills/reviewers.ts:144-197`) already use for other frontmatter fields.
- AC2: `keryx review rules extract <path>` runs the one-off strong-model extraction on
  a source with no structured rules block, writes a cache file recording the extracted
  rules plus the source's content hash (reusing `hashOriginContent`/`resolveOriginPath`,
  `src/gdskills/project-skills.ts`), and is idempotent — re-running against an unchanged
  source reproduces byte-identical `rule_id`s.
- AC3: `keryx review rules verify` reports drift for every cached extraction using the
  same `OriginDrift` states already defined (`none|clean|changed|missing`,
  `src/review/reviewers.ts:26-35`), rendered in the same style
  `renderReviewerInventoryMarkdown` already uses for a skill's own origin drift
  (`src/review/reviewers.ts:268-340`) — a stale cache is visible in this report, never
  silently trusted by a review round.
- AC4: A rule extracted from a project skill or `.mdc` file that declares
  `metadata.paths` or `stack_requires` carries that applicability onto every rule
  extracted from it, unless the extraction itself narrows a specific rule further.
- AC5: Applying this extraction to checklist-shaped rule documents written specifically
  as fixtures for this repository (not reproduced from the operator's global
  skills-and-rules collection or the external project named in `PRD.md`'s research
  section) as a fixture case.
- AC6: CI is green on the branch and `keryx health run` passes.

Tasks:
- T1 (M): structured (`rules:`/`## Rules`) parser.
- T2 (L): one-off extraction prompt + cache writer, using the confirmation-pass model
  tier (see Phase 5's model choice, Open Question 1).
- T3 (S): `keryx review rules verify` command + drift reporting.
- T4 (M): fixtures + tests, entirely local content (no external project text).

## Phase 4 — Hunk × rule dispatch and candidate generation

Goal: given a diff and a loaded rule set, produce candidates — no findings yet.

Draft acceptance criteria:

- AC1: The dispatcher consumes `buildReviewScope`'s retained blocks
  (`src/review/scope.ts`) directly — it does not re-parse the diff — and filters rules
  per hunk using path-glob applicability (Requirement 7) plus `detectProjectStack`
  (`src/review/stack.ts:93`) with the existing "uncertain means included" bias
  unchanged.
- AC2: (hunk, rule) pairs are packed into `/systemone` requests such that no request
  exceeds the 64k `state`+`questions` budget (Phase 0 AC3's pre-flight check reused
  here), splitting into multiple requests rather than dropping a pair.
- AC3: A `noul` answer at or above a configurable threshold, or a `choice` answer
  selecting a non-baseline option, produces a candidate record
  (`{file, range, rule_id, score, source}`); nothing below threshold is retained even
  transiently in the output the confirmation pass reads.
- AC4: `keryx review rules <diff-or-ref> --json` prints the candidate list without
  requiring the confirmation pass or a full review round to run.
- AC5: A round with zero applicable rules for the changed paths reports zero candidates
  and a coverage reason of `"no applicable rules for this diff"`, distinguished in the
  output from `"jev review not enabled for this project"` (Requirement 15).
- AC6: CI is green on the branch and `keryx health run` passes.

Tasks:
- T1 (M): applicability filter (paths + stack tags).
- T2 (M): budget-aware batcher.
- T3 (S): threshold/choice-to-candidate logic, default threshold as a named constant.
- T4 (S): `review rules` CLI (triage-only mode).
- T5 (M): tests against Phase 0's fake-fetch client — fixed `/systemone` responses,
  asserted candidate output, no real network.

## Phase 5 — Confirmation pass and pipeline ingestion

Goal: turn a candidate into a real, schema-valid finding, or record why it was
dropped, and feed the result through the existing ingest/verification path unchanged.

Draft acceptance criteria:

- AC1: Every candidate is resolved to exactly one outcome: a
  `StructuredReviewFinding`-shaped record satisfying `reviewer-finding.schema.json` in
  full (including `class_scope` when severity is `blocker`/`major`,
  `reviewer-finding.schema.json:151-168`), or a recorded drop with a reason — never
  silence.
- AC2: Confirmed findings pass into `keryx review ingest` as an ordinary
  `ReviewFindingsSource` (`src/review/types.ts:710-718`) with `reviewer` set to this
  reviewer's catalog name; no new ingest code path is added for them.
- AC3: This reviewer's findings go through `review-verifier` (Wave C) exactly like
  every other reviewer's — no code path lets a Jev-sourced finding skip
  `src/review/verification.ts`'s merge or reach `confirmed` off reasoning alone
  (`REASONING_CAPPED_VERDICT`, `src/review/types.ts:297`).
- AC4: The round's `filter_stats` gains a `jev_triage` stage reporting
  hunk×rule pairs scored, candidates flagged, and candidates confirmed vs. dropped,
  using `not_measured` (never `0`) when the stage did not run
  (`src/review/types.ts:94-110` pattern).
- AC5: `keryx review rules <diff-or-ref> --explain --json` runs triage and confirmation
  together and prints schema-valid findings without requiring a full managed-review
  round.
- AC6: CI is green on the branch and `keryx health run` passes.

Tasks:
- T1 (L): confirmation-pass integration (dedicated explainer prompt or re-dispatch of
  the source reviewer skill — Open Question 1 must be answered before this task
  starts). Shared with Phase 2 AC7 and Phase 1 AC8's use of the same pass.
- T2 (M): drop-reason recording + `filter_stats.jev_triage` schema addition.
- T3 (S): ingest wiring (reviewer name, `ReviewFindingsSource` shape).
- T4 (M): end-to-end test: fixed diff + fixed `/systemone` fixture + fixed confirmation
  fixture -> asserted `findings.json` entry, no real network or real model call.

## Phase 6 — Registration, opt-in setting, and CLI/TUI surface

Goal: make the reviewer (and the Phase 1/2 additions) dispatchable, privacy-gated, and
visible, under one coherent surface.

Draft acceptance criteria:

- AC1: The reviewer ships as `src/gdskills/bundled/skills/review/<name>/SKILL.md`,
  cataloged in `src/gdskills/catalog.ts` with `category: "review"`, and appears in
  `collectReviewers`'s `bundled` list (`src/review/reviewers.ts:229-233`) once
  installed.
- AC2: The SKILL.md itself states the honest limits from PRD Requirement 19 (no
  explanations from Jev, 64k budget, every finding authored by the confirmation pass)
  in its own body, not only in this documentation package.
- AC3: `review.jev.enabled` (or equivalent) is read from project config
  (`.metaproject/tasks.config.json`, mirroring the `gates.confirmation` opt-in shape);
  absent or `false` reports coverage `skipped` with reason `"jev review not enabled for
  this project"`, and the reviewer never dispatches a network call in that state. The
  Phase 1 early wins and the Phase 2 reference-document mode are gated by the same
  single opt-in flag by default (Open Question 8 covers whether they need their own).
- AC4: A sidebar panel (`src/tui/jev-rules-sidebar.ts`) shows rules loaded (by source),
  hunks scored, candidates by severity, and enabled/disabled state for the current
  project, following the existing panel conventions in `src/tui/ops-sidebar.ts`.
- AC5: A modal (`src/tui/jev-rules-modal.ts`) lists every flagged (hunk, rule) pair with
  its score, confirmation status, and a jump to `file:line`, following the existing
  modal conventions in `src/tui/wizard-modal.ts`/`src/tui/help-modal.ts`.
- AC6: The same sidebar/modal surface gains a reference-document conformance view
  (PRD Requirement 29): clause counts by kind and checkable/not-checkable, the last
  PR's/report's/diff's conformance, and drill-down into flagged clauses.
- AC7: `keryx review rules`'s and `keryx review conform`'s `--json` output and the TUI
  modal read the same underlying data shapes — no second, divergent representation per
  surface.
- AC8: CI is green on the branch and `keryx health run` passes.

Tasks:
- T1 (M): bundled SKILL.md + catalog entry + length-ceiling registration.
- T2 (S): project-config opt-in flag + coverage-reason wiring.
- T3 (M): sidebar panel (rule-conformance view).
- T4 (L): drill-down modal (rule-conformance view).
- T5 (M): reference-document conformance view (sidebar + modal extension).
- T6 (S): CLI/TUI data-shape unification across `review rules` and `review conform`.
- T7 (M): tests for opt-in gating (enabled/disabled/absent-config), all three views
  rendering against fixed candidate/clause data.

## Phase 7 — Evaluation against historical data

Goal: replace every cost/latency/precision/recall estimate across all three tracks
(early wins, reference-document mode, hunk-based rule conformance) with a measured
number.

Draft acceptance criteria:

- AC1: A replay harness runs the hunk-based reviewer's triage (Phase 4) against the
  diffs behind a sample of `.metaproject/flows/*/reviews/*/findings.json` packages,
  restricted to findings whose `class_scope`/`file`/`line` map onto a rule this
  reviewer's loaded set can express, and reports recall as a real percentage.
- AC2: Precision is reported for the same sample *with the bias named*
  (`src/review/types.ts:520-524`'s "findings.json records only the survivors of an
  unlogged triage" is paraphrased in the report itself, not omitted) — presented as an
  upper bound on true precision, not as a validated rate.
- AC3: CI failure triage (Phase 1) is replayed against this repository's own CI run
  history — pairs of {failed run, immediate rerun on the same commit that passed} as
  `flaky` ground truth, and {failed run, fixed by a later commit on the same PR} as
  `real-regression` ground truth — and reports a confusion matrix, not a single
  accuracy number, since the two classes need different evidence.
- AC4: Reviewer-dispatch scoring (Phase 1) is replayed against a sample of past PRs'
  actual reviewer coverage rows, reporting how often a Jev-added reviewer (one with no
  path/stack trigger) would have found something, versus how often it would have run
  for nothing — the cost/benefit this feature exists to improve.
- AC5: Reference-document mode (Phase 2) is evaluated two ways, since keryx's own
  historical review packages likely contain few or no known doctrine violations to
  serve as positive examples: (a) a consistency check against the historical corpus,
  expecting a low false-positive rate on reports that are believed compliant, and (b) a
  synthetic mutation test — starting from a compliant report/PR fixture and breaking one
  clause at a time (removing a lane, dropping evidence from one finding, merging two
  concerns into one PR body) — verifying each single-clause mutation is caught. (b) is
  the primary signal until real violations accumulate.
- AC6: A real cost figure (`spent_usd`, `input_tokens`) and a real latency figure (P50/
  P95 across the sample) replace `PRD.md`'s estimates for a typical PR, across all three
  tracks, recorded the same way `ReviewRoundCost` records any other round's spend
  (`src/review/cost.ts:23-31`).
- AC7: The default candidate threshold (Open Question 4) is set from this measurement,
  recorded as a decision with the recall/precision trade-off it was chosen at, not left
  at Phase 4's placeholder value without re-examination.
- AC8: A worked import of one private external project's checklist-shaped rule set, run
  locally, with no rule content committed to keryx — extract, cache, triage, confirm —
  demonstrated end-to-end, closing PRD Requirement 12/18.
- AC9: CI is green on the branch and `keryx health run` passes.

Tasks:
- T1 (M): replay harness over `.metaproject/flows/*/reviews/*/findings.json`.
- T2 (S): recall/precision report generator, with the corpus-bias caveat built into the
  template, not added by hand each run.
- T3 (M): CI-history replay harness (flaky/real-regression ground-truth pairing) + a
  confusion-matrix report.
- T4 (M): reviewer-dispatch replay against past coverage rows.
- T5 (L): reference-document synthetic mutation harness (compliant fixture -> one
  clause broken at a time -> expect it caught) plus the historical-corpus consistency
  check.
- T6 (S): cost/latency measurement wiring (reuse `ReviewRoundCost`), across all tracks.
- T7 (M): threshold-selection writeup + config default update.
- T8 (M): a worked import of one private external project's checklist-shaped rule set,
  run locally, with no rule content committed to keryx, documented without reproducing
  its rule text.

## Test strategy (applies across all phases)

- **No real network in any test.** Every `/systemone` call in a test goes through an
  injected `fetch` returning a canned `Response`, exactly the pattern already
  established for provider balance checks (`src/commands/providers.balance.test.ts:8-50`)
  and provider construction (`src/harness/provider/make-provider.test.ts:143-155`,
  env-injected credentials, no live call).
- **No real `gh`/GitHub API call in any test.** Every `GitHubPort` use in a test goes
  through `createFixturePort` (`src/commands/review.ts:1120-1134`) with fixture JSON
  files, the same offline-rehearsal path `keryx review comments collect --fixtures`
  already supports — this covers Phase 1's dispatch/comment/CI-triage state gathering
  and Phase 2's `pr`-kind state gathering alike.
- **Fixtures, not live extraction, in CI.** The one-off strong-model extraction
  (Phase 3) and the confirmation pass (Phase 5) are exercised in tests against fixed
  input/output fixture pairs, not a live model call — consistent with
  `keryx-provider-breadth`'s own precedent of `.SYNTHETIC.`-labeled fixtures with
  provenance recorded in a `manifest.json` when a live call was unavailable
  (`docs/requirements/keryx-provider-breadth/README.md:41-54`).
- **Schema validation is the acceptance bar for Phase 5's output**, not a hand-rolled
  shape check: every fixture-driven test asserts the produced finding against
  `reviewer-finding.schema.json`, the same schema every other reviewer's output is held
  to.
- **Reference-document fixtures use invented clause text only** (Phase 2 AC8) — no test
  name, fixture file, or assertion string may contain wording lifted from a real
  reference document.
- **Drift and opt-in gating are tested as refusals, not just happy paths** — Phase 3's
  `verify` command and Phase 6's opt-in flag each need a test proving the *disabled*/
  *stale* state produces no network call and the correct named reason string.
- **Advisory-only paths are tested as absence of a side effect, not just presence of the
  right text.** Phase 1's CI-triage and comment-conformance ACs each require a test that
  asserts no rerun/status/merge/`handled_comments`/reply call happened, in addition to
  asserting the advisory text is correct.

## Open questions for the operator

1. **Who performs the confirmation/explanation pass (PRD Requirement 10)?** A dedicated
   small explainer prompt shared across all rules, or re-dispatching the same domain
   reviewer skill the rule came from, scoped to just the flagged hunk and rule? The
   latter reuses existing reviewer quality and phrasing; the former is cheaper and
   simpler to test. This decision gates Phase 5 T1 and is now also used by Phase 1 AC8
   and Phase 2 AC7.
2. **Where does the shared Jev/System-One client live, relative to the parallel
   `keryx-jev-router` package?** Both need a client for the same endpoint. This plan
   proposes `src/review/jev-client.ts` as a starting location but does not assume
   ownership — if `keryx-jev-router` lands first with its own client, Phase 0 should
   consume that module instead of duplicating it. This is the "decision port" the two
   packages share; flag it for whoever lands second to check before writing a second
   HTTP layer.
3. **Does a Jev-confirmed finding count toward `cross_family_review`
   (`src/review/cross-family.ts`) as an independent family?** Jev is a structured-decision
   model, not a text-generating LLM from any existing "family" the cross-family check
   already reasons about. Left unanswered, `cross_family_review` should treat a
   Jev-sourced finding as informational only, never as satisfying a cross-family
   requirement by itself — confirm or override this default before Phase 5 ships.
4. **What is the default candidate threshold?** No historical prior exists before
   Phase 7 runs. Phase 4 needs a shipped default before Phase 7 can even run a replay;
   propose starting at a conservative value (favoring recall) and letting Phase 7 AC7
   correct it, but the initial number is a guess the operator should bless or override.
5. **Should a project's own extracted rule cache be committed to the repository, or
   kept as derived state under `.metaproject/data/`?** Committing makes the extraction
   result reviewable in a diff (matching this project's general preference for visible,
   auditable artifacts); keeping it as derived state matches how other generated
   `.metaproject/data/gdctx` artifacts are treated today. Affects Phase 3 T2's file
   layout, and now also Phase 2's clause cache.
6. **What is the reviewer's catalog name?** Proposed candidates:
   `review-rule-conformance`, `review-jev-conformance`, `jev-conformance`. Affects every
   file path in Phase 6.
7. **Does importing an external project's rule set require that project to run `keryx
   init` first (a full metaproject bootstrap), or should a lighter one-shot `keryx
   skills import --from <path>` work without one?** The private external project's own
   facade skill already assumes a `.metaproject/` will exist when it runs, but none
   exists in the checkout surveyed for this PRD — worth confirming whether that is a
   pending bootstrap step already planned for that project, or something this feature
   needs to make optional.
8. **Do the Phase 1 early wins and the Phase 2 reference-document mode need their own
   opt-in flags, separate from `review.jev.enabled`?** CI failure triage and
   reviewer-dispatch scoring send less code to OpenRouter than full hunk triage (a log
   excerpt and a diff summary, not hunk bodies), and an operator might want one without
   the other. Phase 6 AC3 proposes one shared flag as the default; splitting it into
   `review.jev.ci_triage`, `review.jev.dispatch`, `review.jev.conform`, etc. is a real
   option if the operator wants finer-grained privacy control.
9. **Does CI failure triage's advisory output belong on the PR (a posted comment) or
   only in the terminal/CLI output for Phase 1?** Posting to the PR makes it visible to
   everyone without opening a terminal, but is also the first of these three early wins
   that would write anything to GitHub. Proposed default for Phase 1: console/CLI only,
   with a PR comment as an explicit follow-up once the classifier's accuracy is measured
   (Phase 7 AC3).
10. **For reference-document mode, who resolves a sibling document a reference document
    cites (a style-patterns file, a testing-conventions file) when it lives outside that
    project's own `project-skills` tree?** The `hunk`-kind mechanism (Phase 2 AC5)
    assumes the sibling document is itself extractable the same way as any other rule
    source (Phase 3); a reference document that cites a file keryx has no read access to
    (e.g. a path outside the project skill's origin) needs a named refusal rather than a
    silent skip — worth deciding the exact refusal shape before Phase 2 T1 locks in the
    clause schema.
