# Keryx Jev Rule-Conformance Reviewer — Implementation Plan
Version: 0.1.0

Companion to `PRD.md`. Phased as keryx flows, each phase sized to land as one or two
flows with its own acceptance criteria in the repository's own style (see
`.metaproject/flows/299-2026-09-23-a-completion-signature-an-agent-cannot-m/
acceptance-criteria.md` for the house format this mirrors: `- ACn: <single dense
sentence, testable, naming the file/behavior it pins>`).

## Phase 0 — Jev client adapter (plumbing, no reviewer behavior yet)

Goal: one small, tested HTTP client for `POST /api/v1/systemone`, reusable by this
package and by the parallel `keryx-jev-router` work without either blocking on the
other merging first (see Open Question 2).

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

## Phase 1 — Rule extraction and the rule cache

Goal: turn a skill/`.mdc` document into the normalized rule records PRD Requirement 4
describes, with structured extraction preferred and one-off model extraction as the
documented fallback, both drift-checked.

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
- AC5: Applying this extraction to the three real checklist-shaped rule documents named
  in `PRD.md`'s research section (a keryx `.mdc` rule, at least one project-skill-shaped
  checklist) as a fixture case, without reproducing their content in the keryx
  repository — the fixture used in tests is written specifically for this repository,
  not copied from the operator's global skills-and-rules collection or the external
  project.
- AC6: CI is green on the branch and `keryx health run` passes.

Tasks:
- T1 (M): structured (`rules:`/`## Rules`) parser.
- T2 (L): one-off extraction prompt + cache writer, using the confirmation-pass model
  tier (see Phase 3's model choice, Open Question 1).
- T3 (S): `keryx review rules verify` command + drift reporting.
- T4 (M): fixtures + tests, entirely local content (no external project text).

## Phase 2 — Hunk × rule dispatch and candidate generation

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

## Phase 3 — Confirmation pass and pipeline ingestion

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
  starts).
- T2 (M): drop-reason recording + `filter_stats.jev_triage` schema addition.
- T3 (S): ingest wiring (reviewer name, `ReviewFindingsSource` shape).
- T4 (M): end-to-end test: fixed diff + fixed `/systemone` fixture + fixed confirmation
  fixture -> asserted `findings.json` entry, no real network or real model call.

## Phase 4 — Registration, opt-in setting, and CLI/TUI surface

Goal: make the reviewer dispatchable by `review-orchestrator`, privacy-gated, and
visible.

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
  this project"`, and the reviewer never dispatches a network call in that state.
- AC4: A sidebar panel (`src/tui/jev-rules-sidebar.ts`) shows rules loaded (by source),
  hunks scored, candidates by severity, and enabled/disabled state for the current
  project, following the existing panel conventions in `src/tui/ops-sidebar.ts`.
- AC5: A modal (`src/tui/jev-rules-modal.ts`) lists every flagged (hunk, rule) pair with
  its score, confirmation status, and a jump to `file:line`, following the existing
  modal conventions in `src/tui/wizard-modal.ts`/`src/tui/help-modal.ts`.
- AC6: `keryx review rules`'s `--json` output and the TUI modal read the same
  underlying data shape — no second, divergent candidate representation.
- AC7: CI is green on the branch and `keryx health run` passes.

Tasks:
- T1 (M): bundled SKILL.md + catalog entry + length-ceiling registration.
- T2 (S): project-config opt-in flag + coverage-reason wiring.
- T3 (M): sidebar panel.
- T4 (L): drill-down modal.
- T5 (S): CLI/TUI data-shape unification.
- T6 (M): tests for opt-in gating (enabled/disabled/absent-config), sidebar and modal
  rendering against fixed candidate data.

## Phase 5 — Evaluation against historical review packages

Goal: replace every cost/latency/precision/recall estimate in this package with a
measured number.

Draft acceptance criteria:

- AC1: A replay harness runs this reviewer's triage (Phase 2) against the diffs behind
  a sample of `.metaproject/flows/*/reviews/*/findings.json` packages, restricted to
  findings whose `class_scope`/`file`/`line` map onto a rule this reviewer's loaded set
  can express, and reports recall as a real percentage.
- AC2: Precision is reported for the same sample *with the bias named*
  (`src/review/types.ts:520-524`'s "findings.json records only the survivors of an
  unlogged triage" is quoted or paraphrased in the report itself, not omitted) — it is
  presented as an upper bound on true precision, not as a validated rate.
- AC3: A real cost figure (`spent_usd`, `input_tokens`) and a real latency figure (P50/
  P95 across the sample) replace `PRD.md`'s estimate for "a typical PR", recorded the
  same way `ReviewRoundCost` records any other round's spend
  (`src/review/cost.ts:23-31`).
- AC4: The default candidate threshold (Open Question 4) is set from this measurement,
  recorded as a decision with the recall/precision trade-off it was chosen at, not left
  at Phase 2's placeholder value without re-examination.
- AC5: A worked import of one private external project's checklist-shaped rule set, run
  locally, with no rule content committed to keryx — extract, cache, triage, confirm —
  demonstrated end-to-end, closing PRD Requirement 12/18.
- AC6: CI is green on the branch and `keryx health run` passes.

Tasks:
- T1 (M): replay harness over `.metaproject/flows/*/reviews/*/findings.json`.
- T2 (S): recall/precision report generator, with the corpus-bias caveat built into the
  template, not added by hand each run.
- T3 (S): cost/latency measurement wiring (reuse `ReviewRoundCost`).
- T4 (M): threshold-selection writeup + config default update.
- T5 (M): a worked import of one private external project's checklist-shaped rule set,
  run locally, with no rule content committed to keryx, documented without reproducing
  its rule text.

## Test strategy (applies across all phases)

- **No real network in any test.** Every `/systemone` call in a test goes through an
  injected `fetch` returning a canned `Response`, exactly the pattern already
  established for provider balance checks (`src/commands/providers.balance.test.ts:8-50`)
  and provider construction (`src/harness/provider/make-provider.test.ts:143-155`,
  env-injected credentials, no live call).
- **Fixtures, not live extraction, in CI.** The one-off strong-model extraction
  (Phase 1) and the confirmation pass (Phase 3) are exercised in tests against fixed
  input/output fixture pairs, not a live model call — consistent with
  `keryx-provider-breadth`'s own precedent of `.SYNTHETIC.`-labeled fixtures with
  provenance recorded in a `manifest.json` when a live call was unavailable
  (`docs/requirements/keryx-provider-breadth/README.md:41-54`).
- **Schema validation is the acceptance bar for Phase 3's output**, not a hand-rolled
  shape check: every fixture-driven test asserts the produced finding against
  `reviewer-finding.schema.json`, the same schema every other reviewer's output is held
  to.
- **Drift and opt-in gating are tested as refusals, not just happy paths** — Phase 1's
  `verify` command and Phase 4's opt-in flag each need a test proving the *disabled*/
  *stale* state produces no network call and the correct named reason string.

## Open questions for the operator

1. **Who performs the confirmation/explanation pass (PRD Requirement 10)?** A dedicated
   small explainer prompt shared across all rules, or re-dispatching the same domain
   reviewer skill the rule came from, scoped to just the flagged hunk and rule? The
   latter reuses existing reviewer quality and phrasing; the former is cheaper and
   simpler to test. This decision gates Phase 3 T1.
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
   requirement by itself — confirm or override this default before Phase 3 ships.
4. **What is the default candidate threshold?** No historical prior exists before
   Phase 5 runs. Phase 2 needs a shipped default before Phase 5 can even run a replay;
   propose starting at a conservative value (favoring recall) and letting Phase 5 AC4
   correct it, but the initial number is a guess the operator should bless or override.
5. **Should a project's own extracted rule cache be committed to the repository, or
   kept as derived state under `.metaproject/data/`?** Committing makes the extraction
   result reviewable in a diff (matching this project's general preference for visible,
   auditable artifacts); keeping it as derived state matches how other generated
   `.metaproject/data/gdctx` artifacts are treated today. Affects Phase 1 T2's file
   layout.
6. **What is the reviewer's catalog name?** Proposed candidates:
   `review-rule-conformance`, `review-jev-conformance`, `jev-conformance`. Affects every
   file path in Phase 4.
7. **Does importing an external project's rule set require that project to run `keryx
   init` first (a full metaproject bootstrap), or should a lighter one-shot `keryx
   skills import --from <path>` work without one?** The private external project's own
   facade skill already assumes a `.metaproject/` will exist when it runs, but none
   exists in the checkout surveyed for this PRD — worth confirming whether that is a
   pending bootstrap step already planned for that project, or something this feature
   needs to make optional.
