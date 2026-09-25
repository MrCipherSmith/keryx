# Keryx Jev Rule-Conformance Reviewer — PRD
Version: 0.2.0

## Problem

keryx already runs a fan-out of specialized review skills (`src/gdskills/bundled/skills/review/**`,
cataloged with `category: "review"` in `src/gdskills/catalog.ts:10`) plus, per project,
locally-authored reviewers under `.metaproject/project-skills/review/**`
(`src/review/reviewers.ts:24` — `PROJECT_REVIEWER_MODULE = "review"`). Every one of
those reviewers is a full LLM pass: read the diff, read the rules, reason in prose,
write findings. That is the right tool for logic bugs and architecture judgement, and
the wrong, expensive tool for the large fraction of a rule set that is a flat yes/no
check — "does this hunk use a raw hue class", "is this MobX callback public when it
should be private", "did this touch `src/**/*.css` without going through the token
layer". Those checks are answered today by asking a general-purpose model to hold an
entire checklist in its head over an entire diff, once per reviewer, every round.

TypeSafe's Jev ("System One") is a structured-decision model built for exactly the
narrow half of that job and nothing else: given a `state` and a set of `questions`, it
returns a probability (`noul`) or a chosen option (`choice`) per question, in ~0.3s,
at $0.042 per million input tokens with free output
(https://openrouter.ai/docs/guides/community/typesafe-sdk,
https://openrouter.ai/provider/typesafe). It generates no text, cannot explain a
finding, and the vendor is explicit that it is not for code review, long documents, or
open-ended reasoning (https://www.ayautomate.com/blog/jev-typesafe-system-one-model).
That rules out "Jev as a reviewer" and points at "Jev as a triage layer in front of the
reviewers keryx already has": score every (changed hunk, rule) pair cheaply, and spend
the expensive reasoning only on the pairs Jev flags.

Separately, the operator has two bodies of already-written, mostly-atomic rules that
are not yet reachable from any automated conformance check:

- The operator's global skills-and-rules collection (`AGENTS.md`, per-topic `.mdc`
  rules, and a large `review-*`/`code-*` skill set) — the same shape keryx's own
  bundled `.mdc` rules already mirror (compare
  `.metaproject/rules/core/code-style-patterns.mdc:1-56`, frontmatter plus a bulleted
  "Review Flags" checklist, to that collection's own same-named rule file, same size
  class).
- A private external project (referred to here as "the external project"), which has
  roughly 8 domain-specific review skills, each with a path-glob Scope section and a
  checklist of mostly yes/no-phrasable bullets, plus a facade skill that composes
  keryx's generic review-orchestrator from the nearest `.metaproject` — but that
  project's current checkout has no `.metaproject/` yet, so the facade's own first step
  currently has nothing to find.

## Goal

Ship one more reviewer, alongside the existing fan-out, whose job is triage rather than
authorship: for every retained diff hunk and every applicable rule — sourced from
bundled review skills, from a project's own `.metaproject/project-skills/review/**`, or
from an external project's rule set imported the same way — ask Jev "does this hunk
violate this rule" (or "which of these named states applies"), and hand only the
flagged (hunk, rule) pairs to an existing strong-model pass for confirmation, evidence,
and a fix suggestion. Confirmed candidates enter the review package exactly like any
other reviewer's findings. Jev never writes a finding, an explanation, or a fix by
itself.

The operator has since asked for the rollout to start smaller: three narrow, cheaply
measurable triage tasks that need no rule-extraction machinery (CI failure triage,
reviewer-dispatch scoring, finding/comment verification — Requirements 20-23), then a
reference-document conformance mode that generalizes the same clause-extraction idea to
documents governing process rather than only code (Requirements 24-29), and only then
the full hunk-based rule-conformance mechanism above. `PLAN.md` is phased in that order.

## Non-goals (this version)

- Jev is not a standalone reviewer and never produces a `findings.json` entry directly.
  A `problem`/`impact`/`suggested_fix`/`evidence` quartet always comes from a
  confirmation pass, never from a `noul`/`choice` answer.
- No attempt to have Jev review whole files, whole diffs, or anything requiring
  cross-hunk reasoning — the vendor's own stated non-uses
  (https://www.ayautomate.com/blog/jev-typesafe-system-one-model) rule that out, and the
  64k-token state+questions budget rules it out mechanically for anything but a hunk.
- No new rule-authoring UI. Rules are written where rules already live — bundled skills,
  `.mdc` files under `.metaproject/rules/`, and project skills — never in a new format
  that duplicates them.
- No change to how the *existing* reviewers work. This is an additive reviewer in the
  same registry `src/review/reviewers.ts:227` already enumerates (`collectReviewers`),
  not a rewrite of `review-orchestrator` or `managed.ts`.
- Copying the external project's or the operator's global collection's rule text into
  the keryx repository. keryx is public; both sources are private. The mechanism keeps
  rule content in its own project's `project-skills` tree and loads it at run time
  (Requirement 12).
- Any of the three early wins (Requirements 20-23) or the reference-document mode
  (Requirements 24-29) taking an automatic action — a rerun, a merge, a status-check
  write, a `handled_comments` update, or a posted reply. Every one of them is advisory
  or feeds the same confirmation pass as the hunk-based mechanism; none of them closes
  a loop by itself.

## Users

- A keryx operator who wants a project's own style/architecture rules (theirs, or an
  imported set like the external project's) checked on every diff at near-zero
  marginal cost, with
  the expensive reviewers reserved for what Jev flags plus whatever they already cover.
- A team maintaining a large, mostly-mechanical checklist (a design-token/styling
  contract is the concrete example already in front of us) who today can only enforce
  it by asking a full LLM reviewer to hold the whole checklist in context every round.
- keryx's own review-orchestrator, which gains one more reviewer to dispatch and one
  more coverage row to report, on the same contract every other reviewer already meets.

## Research summary (with citations)

**Review package format.** A managed review round writes a manifest
(`ManagedReviewManifest`, `src/review/types.ts:78-138`) naming six artifacts —
`scope.md`, `coverage.md`, `report.md`, `findings.json`, `learning.md`, `decisions.md`
— plus optional `filter_stats`, `repairs`, `cost`, and `cross_family_review` blocks. A
worked example on disk:
`.metaproject/flows/299-2026-09-23-a-completion-signature-an-agent-cannot-m/reviews/2026-09-23-review-299-r02/manifest.json`,
whose `coverage` array is `[{reviewer, status, reason}]` (matches
`ReviewCoverageEntry`, `src/review/types.ts:72-76`) and whose sibling `findings.json`
holds `StructuredReviewFinding` records (`src/review/types.ts:351-442`) each with
`severity` (`blocker|major|minor|info`, `types.ts:140-141`), `confidence`
(`high|medium|low`, `types.ts:143-144`), and — required for `blocker`/`major` by
`reviewer-finding.schema.json:151-168` — a `class_scope` object naming every site of
the same shape and how the set was enumerated (`types.ts:146-149`,
`reviewer-finding.schema.json:124-148`).

**Verification is delete-only, and re-reading is explicitly rejected.**
`src/review/verification.ts:1-45` and `src/gdskills/bundled/skills/review/
review-verifier/SKILL.md:33-68` record why the pipeline replaced its old re-scoring
pass (`review-strict`) with one that can only remove a finding, never add or escalate
one, citing measured self-correction degradation (Huang et al., ICLR 2024,
arXiv:2310.01798; Self-Refine, arXiv:2303.17651) and why *execution* verification beats
reasoning (AnyPoC, arXiv:2604.11950; TestGen-LLM, arXiv:2402.09171). `VERIFICATION_METHODS`
(`execution|site-check|reasoning`, `types.ts:277`) and `REASONING_CAPPED_VERDICT`
(`types.ts:297`, reasoning alone can never reach `confirmed`) are the existing
discipline this reviewer must not weaken: Jev's probability score is reasoning-shaped
evidence at best and must never be written as a `confirmed` verdict.

**Reviewer registration already supports exactly this shape of extension.**
`src/review/reviewers.ts:227-266` (`collectReviewers`) enumerates two halves: bundled
reviewers read from `.metaproject/skills/gdskills/review/**`, and project reviewers read
from `.metaproject/project-skills/review/**` (`PROJECT_REVIEWER_MODULE = "review"`,
`reviewers.ts:24`). A project reviewer's path triggers come from `metadata.paths` or
from globs found in its description (`descriptionPathTriggers`, `reviewers.ts:175-189`),
its `stack_requires` scopes it by detected stack tags
(`extractStackRequiresField`/`parseStackRequires`, wired at `reviewers.ts:6,256`), and it
can carry a recorded `origin`/`originHash`/`drift` triple
(`OriginDrift = "none"|"clean"|"changed"|"missing"`, `reviewers.ts:26-35`,
`driftFor`, `reviewers.ts:199-218`) when it was imported from an external file — the
exact mechanism needed to import a private external project's skill as a keryx project
skill while detecting when that project's original has moved on.

**Deterministic hunk extraction already exists and is the right chunk boundary for
Jev.** `src/review/scope.ts:1-100` (`buildReviewScope`) is a pure, model-free function
that turns a diff into retained change blocks plus a `drops` list with one of eight
named reasons (`SCOPE_DROP_REASONS`, `scope.ts:77-87`) and a `granularity: "file"|
"block"` (`scope.ts:96-100`+). This is the same granularity a Jev question should be
asked about — a "hunk" in this PRD means one retained scope block.

**Stack-aware scoping already exists and generalizes to rule applicability.**
`src/review/stack.ts:51-93` (`detectProjectStack`) answers per-tag (`nestjs, react,
mobx, prisma, playwright, sql, http-server`) whether a repository's `package.json`
declares it, deliberately biased so an uncertain read forces every tag `true`
(`stack.ts:15-23`) rather than silently skipping a reviewer.

**Rule-to-file linkage already exists via a fixed convention.**
`src/gdskills/rule-references.ts:19-36` extracts backticked `.mdc` references
(`` `core/reviewing.mdc` `` style) out of a skill body and reports which of them have no
file under `.metaproject/rules/` (`unresolvedRuleReferences`) — the same convention this
PRD's rule cache keys off.

**Existing `.mdc` rules are already close to atomic, checkable claims.**
`.metaproject/rules/core/code-style-patterns.mdc:48-55` ("Review Flags") is a bulleted
list of concrete, mostly yes/no-phrasable statements about UI/API boundaries, store
conventions, and null-propagation guards. The same shape exists in the operator's
global skills-and-rules collection's own same-named rule file (same filename, same
size class) and in the external project's domain skills (see below) — none of the
three are a single paragraph of open-ended prose.

**The external project's structure, described generically (no rule text reproduced).**
The external project has no `.metaproject/` in its current checkout, but its facade
skill already names its intended composition: read the nearest
`.metaproject/index.md`, then keryx's generic `review-orchestrator/SKILL.md`
completely, and refuse with a named error if either is unavailable — i.e. its own
design already assumes it will run *inside* a keryx-managed project, not as a separate
product. Its rule set is roughly 8 domain-specific review skills, each with a Scope
section naming applicable path globs and a Checklist section organized into thematic
subheadings of concrete, mostly banned-pattern/required-pattern bullets — one domain
skill makes the shape visible: a design-token/class-string contract broken into named
sub-checks, each phrased close to a yes/no rule already. This is the structure this
PRD's rule extraction targets — roughly 8 domains, scope-gated, checklist-shaped — not
reproduced here.

**The operator's global skills-and-rules collection, described generically.** ~30
`.mdc` rule files (architecture, error handling, style, security, git, testing, and
workflow rules) and ~70 skill directories, a large fraction of them `review-*`/`code-*`
reviewers whose names match keryx's own bundled review skills one-for-one
(`review-architecture`, `review-backend`, `review-clean-code`, `review-core-boundaries`,
`review-flow-graph`, `review-frontend`, `review-highload`, `review-logic`, and others) —
i.e., keryx's bundled review skill set is this operator's own convention, already
imported once. This PRD treats that collection the same way it treats the external
project: a *source* of rule documents to extract from, never content to paste into
keryx's public tree.

**Cost/latency accounting conventions to reuse, not reinvent.** `ReviewRoundCost`
(`src/review/cost.ts:23-31`: `input_tokens`, `output_tokens`, `spent_usd`, every field
independently optional) and its `estimateTokens` heuristic (`cost.ts:42-44`, chars÷4)
are the existing shape for "what did this round cost"; `not recorded` vs `0` is a
load-bearing distinction throughout this module and `caps.ts` (e.g.
`DEFAULT_MAX_FINDINGS_PER_REVIEWER = 10`, per reviewer, blockers exempt,
`caps.ts:36-48`) — the Jev reviewer's own cost/coverage reporting must follow the same
rule: a stage that did not run reports `not recorded`, never `0`.

**OpenRouter is already a first-class provider; Jev's endpoint is a different shape on
the same host.** `src/commands/providers.ts:312-314` registers `openrouter` with
`baseUrl: "https://openrouter.ai/api"`; `src/lib/shell-config.ts:28,253-254` already
carries an `openrouterKey`/`OPENROUTER_API_KEY` credential path; the existing balance
check (`fetchProviderBalance`, tested at
`src/commands/providers.balance.test.ts:8-50`) shows the established pattern of an
injectable-`fetch`, non-SDK HTTP client keyed off the same credential. Jev's
`POST https://openrouter.ai/api/v1/systemone` is not the Chat Completions shape the
existing `OllamaProvider`-based compat engine speaks
(`src/harness/provider/make-provider.test.ts:143-155` shows `openrouter` constructed as
that compat engine today), so it needs its own small client, not a reuse of
`ProviderPort`/`makeProvider` — but it should reuse the same credential and the same
injected-fetch test discipline.

## Requirements

1. **Jev client module.** A new module (proposed: `src/review/jev-client.ts`) wraps
   `POST https://openrouter.ai/api/v1/systemone` with an injectable `fetch` parameter
   (default `globalThis.fetch`), following the exact shape `fetchProviderBalance`
   already established (`src/commands/providers.balance.test.ts:8-50`: a `typeof fetch`
   first argument, a `Response` returned from a fake in tests, no real network call in
   any test). It builds `{model, state, questions}` request bodies, enforces the 64k
   combined token budget for `state`+`questions` before sending (rejecting or
   re-batching oversized requests rather than sending them), and parses `{answers,
   usage}` responses. It reads the API key from the same `OPENROUTER_API_KEY`/
   `openrouterKey` path `src/lib/shell-config.ts:28` already resolves — no new
   credential type.
2. **Model selection.** The client accepts `jev-1.13` or `jev-latest` as configured
   model ids; the default is a named, documented constant, not a hardcoded literal
   duplicated at call sites.
3. **Hunk source.** The reviewer consumes the retained scope blocks `buildReviewScope`
   already produces (`src/review/scope.ts`), not a re-derived diff parse — one Jev
   question batch is scoped to one retained block (or a small group of blocks from the
   same file, batched only while the combined `state` stays under budget).
4. **Rule representation.** A rule is a normalized record:
   `{rule_id, statement, question_type: "noul"|"choice", criteria?: string[],
   severity_hint, applicability: {paths: string[], languages?: string[]},
   source: {kind: "bundled-skill"|"project-skill"|"metaproject-rule", path, origin?,
   origin_hash?}}`. `rule_id` is stable across extractions of the same source content
   (a content hash suffix, not a counter) so re-extracting an unchanged skill produces
   the identical id.
5. **Structured extraction (no model call).** A skill or `.mdc` rule file may declare
   its own machine-readable rules directly — a `rules:` frontmatter block or a fixed
   `## Rules` section, one list item per rule, each already carrying `statement` and
   optional `paths`/`languages`. When present, this is parsed deterministically with no
   model call, the same way `metadataList`/`descriptionPathTriggers`
   (`src/gdskills/reviewers.ts:144-189`) parse existing frontmatter today.
6. **One-off extraction (cached, drift-checked).** When a source document has no
   structured rules block — true of every `.mdc`/checklist-shaped skill surveyed in
   this PRD's research — a one-off strong-model extraction pass turns its bulleted
   checklist into the normalized rule records of Requirement 4, written to a cache file
   (proposed: `<skill-dir>/.jev-rules.json` for a project skill, or a project-level
   cache keyed by rule-file path for `.mdc` files) alongside a content hash of the
   source. The cache is re-extracted only when the hash no longer matches — the same
   `hashOriginContent`/`resolveOriginPath` pair `src/gdskills/project-skills.ts`
   already exposes, and the same `OriginDrift` states (`none|clean|changed|missing`,
   `src/review/reviewers.ts:26-35`) reported for a skill's own origin. A human command
   (`keryx review rules verify`, Requirement 14) reports drift; nothing is silently
   re-extracted and trusted in a review round without that check having run since the
   last change.
7. **Rule applicability filtering.** Before dispatch, a rule is matched against a hunk
   only when its `applicability.paths` globs match the hunk's file (falling back to the
   skill's own path triggers, `descriptionPathTriggers`/`metadata.paths`,
   `src/review/reviewers.ts:175-197`, when the rule itself declares none) and, when
   `stack_requires` is present on the source skill, only when `detectProjectStack`
   (`src/review/stack.ts:93`) reports that tag `true` — including the "uncertain means
   included" bias (`stack.ts:15-23`) unchanged.
8. **Batching within the 64k budget.** The dispatcher packs (hunk, rule) pairs into
   `/systemone` requests such that `state` (the hunk text plus minimal file context)
   plus every packed `questions` entry's `instructions`/`criteria` stays under the 64k
   token ceiling, using the existing `estimateTokens` heuristic
   (`src/review/cost.ts:42-44`) for the pre-flight estimate and splitting into multiple
   requests rather than truncating a rule's criteria or a hunk's content.
9. **Candidate, not finding.** A `noul` answer at or above a configurable threshold
   (default documented and overridable per project) — or a `choice` answer selecting a
   non-`none`/non-`compliant` option — produces a *candidate*:
   `{file, hunk range, rule_id, probability|choice, source skill}`. A candidate is never
   written into `findings.json` and never satisfies `reviewer-finding.schema.json`'s
   required fields (`problem`, `impact`, `suggested_fix`, `evidence`) on its own.
10. **Confirmation pass produces the real finding.** Every candidate is handed to an
    existing strong-model pass — either a dedicated small explainer prompt or the
    domain reviewer skill the rule came from, re-dispatched scoped to just that one
    hunk and rule (left as Open Question 1 in PLAN.md; both are compatible with this
    requirement) — which either (a) confirms the violation and emits a
    `StructuredReviewFinding`-shaped record satisfying `reviewer-finding.schema.json`
    in full, including `class_scope` when `severity` is `blocker`/`major`
    (`reviewer-finding.schema.json:151-168`), or (b) declines, in which case the
    candidate is recorded as dropped with a reason, never silently discarded — the same
    discipline `filter_stats.not_measured`/`dropped_*` already applies
    (`src/review/types.ts:94-110`, manifest example at
    `.metaproject/flows/299-.../reviews/2026-09-23-review-299-r02/manifest.json:26-55`).
11. **Ingests through the existing pipeline, unchanged.** Confirmed findings are passed
    into `keryx review ingest` as an ordinary `ReviewFindingsSource`
    (`src/review/types.ts:710-718`) with `reviewer` set to this reviewer's name. They go
    through the same verification pass (`review-verifier`, Wave C) as every other
    reviewer's findings — Jev's probability is never itself recorded as a `confirmed`
    verdict (`REASONING_CAPPED_VERDICT`, `src/review/types.ts:297`) and never bypasses
    `src/review/verification.ts`'s delete-only merge.
12. **Rules stay in their own project; keryx loads them at run time.** A rule sourced
    from an external project (a private external project's own domain review skills, or
    any other project's own checklist skills) is registered as a keryx project skill
    under that
    project's own `.metaproject/project-skills/review/**`
    (`PROJECT_REVIEWER_MODULE`, `src/review/reviewers.ts:24`) using the existing
    `keryx skills create <target> --module review --name <name> --origin <file>`
    path (`src/review/reviewers.ts:289`), which records `origin`/`origin_hash` for
    drift detection. No rule text, file content, or internal names from an external
    project are copied into the keryx repository itself; the keryx side of this feature
    only ever reads a project-skill path at run time.
13. **Bundled reviewer registration.** This reviewer ships as one bundled reviewer
    (`src/gdskills/bundled/skills/review/<name>/`, category `"review"`, cataloged in
    `src/gdskills/catalog.ts:10,30` the same way every other bundled reviewer is), and
    is subject to the same length-ceiling discipline as every other skill
    (`src/gdskills/skill-length-ceilings.ts:77`, default 500 lines unless a recorded
    ceiling exists). It appears in `collectReviewers`'s `bundled` list
    (`src/review/reviewers.ts:229-233`) once installed and is dispatchable by
    `review-orchestrator` on the same terms as any other reviewer.
14. **CLI surface.** `keryx review rules <diff-or-ref> [--skills <glob>]
    [--project-skills] [--threshold <0..1>] [--explain] [--json]` runs the triage
    (and, with `--explain`, the confirmation pass) standalone, for inspection before a
    full review round. `keryx review rules extract <skill-or-rule-path>` runs
    Requirement 6's one-off extraction and writes/updates the cache. `keryx review
    rules verify` reports drift across every cached extraction (Requirement 6),
    following the same reporting shape `renderReviewerInventoryMarkdown`
    (`src/review/reviewers.ts:268-340`) already uses for origin drift.
15. **Opt-in, per project, and named as a privacy decision.** Code hunks leave the
    machine to OpenRouter/TypeSafe. This reviewer is disabled by default and enabled
    per project via an explicit setting (proposed:
    `.metaproject/tasks.config.json`'s `review.jev.enabled: true`, mirroring the
    existing opt-in shape of `gates.confirmation`,
    `.metaproject/flows/299-.../acceptance-criteria.md` AC2), never enabled by the mere
    presence of an `OPENROUTER_API_KEY`. `review-orchestrator` reports this reviewer's
    coverage as `skipped` with reason `"jev review not enabled for this project"` when
    the setting is absent, matching `ReviewCoverageEntry`
    (`src/review/types.ts:72-76`).
16. **Cost and stage accounting follow the existing "not recorded ≠ 0" rule.** The
    reviewer's contribution to a round's `ReviewRoundCost`
    (`src/review/cost.ts:23-31`) and to a new `jev_triage` stage of `filter_stats`
    reports `not_measured` when the stage did not run and a real count when it did —
    never a bare `0` standing in for "did not run" (same discipline as
    `src/review/caps.ts:14-27` and the `not_measured` array already on
    `ManagedReviewManifest.filter_stats`, `src/review/types.ts:94-110`).
17. **TUI visibility.** A sidebar panel (proposed: `src/tui/jev-rules-sidebar.ts`,
    following the existing shape of `src/tui/ops-sidebar.ts`/
    `src/tui/schedules-sidebar.ts`) shows: rules loaded (bundled + project, by source),
    hunks scored this round, candidates flagged by severity, and whether the reviewer
    is enabled for this project. A modal (proposed:
    `src/tui/jev-rules-modal.ts`, following `src/tui/wizard-modal.ts`/
    `src/tui/help-modal.ts`) drills down into every flagged (hunk, rule) pair with its
    probability/choice, its confirmation status (candidate / confirmed / dropped), and
    a jump to `file:line`.
18. **Evaluation plan uses keryx's own review history as ground truth.** Precision and
    recall are measured by replaying this reviewer against the diffs backing
    `.metaproject/flows/*/reviews/*/findings.json` (worked example:
    `.metaproject/flows/299-2026-09-23-a-completion-signature-an-agent-cannot-m/
    reviews/2026-09-23-review-299-r02/findings.json`) restricted to findings whose
    `class_scope`/`file`/`line` map onto an existing rule's applicability. Recall is
    reported as the primary metric; precision measured against this corpus is named as
    an upper bound, not a true rate, because `findings.json` records only the survivors
    of an unlogged historical triage (`src/review/types.ts:520-524` documents this bias
    directly), so a Jev candidate that a human would have dismissed and that was never
    recorded as `refuted` cannot be scored as a false positive from this corpus alone.
19. **Honest limits are stated in the reviewer's own SKILL.md and in its coverage
    output**, not only in this document: Jev never explains a finding, never reviews
    holistically, is bounded to 64k tokens of state+questions per request, and every
    finding it contributes was authored by the confirmation pass, not by Jev.

## Additional requirements: early wins, then a reference-document mode

The operator has approved the direction and asked for the rollout order to change:
front-load the cheapest, most measurable uses of Jev — three narrow triage tasks that
need no rule-extraction machinery at all — ahead of the hunk-based rule-conformance
mechanism in Requirements 1-19, and add a second mode that generalizes rule extraction
to documents that govern process, not only code. `PLAN.md` reflects the new phase
order (Phase 1 early wins, Phase 2 reference-document mode, Phase 3+ the hunk-based
mechanism above). Requirements 20-23 below are the early wins; Requirements 24-29 are
the reference-document mode. Both reuse the Jev client (Requirement 1) and the
candidate/confirmation-pass split (Requirements 9-10) — nothing here introduces a
second way for a `noul`/`choice` answer to become an authored artifact.

20. **Early win: CI failure triage (advisory only).** Given a failed CI job's log
    excerpt and the failing test's name as `state`, a `choice` question with
    `criteria: ["flaky", "infra", "real-regression"]` asks Jev to pick one, with the
    per-option probability recorded. The output is advisory text only — "this looks
    flaky, consider a rerun" or "this looks like a real regression in `<file>`" printed
    to the console/PR — and never triggers a rerun, a merge decision, or a status-check
    write by itself. keryx has no existing CI-run-history reader; this requirement adds
    one narrow read path (a new port following the live/fixture split `GitHubPort`
    already establishes, `src/commands/review.ts:1120-1134` — `createGhPort`/
    `createFixturePort`) scoped to fetching one failed job's log and this repository's
    recent run history for the same job name, nothing broader.
21. **Early win: reviewer-dispatch scoring is additive, never subtractive.** Given a
    PR's diff summary (file list, insertion/deletion counts — not the full diff) as
    `state`, one `noul` question per bundled/project reviewer asks Jev whether that
    reviewer is warranted. A reviewer already dispatched by an existing deterministic
    trigger — a matching `metadata.paths`/description glob, or a `stack_requires` tag
    (`descriptionPathTriggers`/`extractStackRequiresField`,
    `src/review/reviewers.ts:175-197,256`) — is dispatched regardless of what Jev
    answers: this requirement can only ADD a reviewer to the round that no path/stack
    rule already forces, for the case where a reviewer's own trigger is absent
    (`pathsSource: "none"`, `src/review/reviewers.ts:50`, today meaning "dispatched on
    every round"). No test may assert a case where a path-forced reviewer's coverage
    entry is `skipped` because of a low Jev score.
22. **Early win: finding conformance (support, duplication, severity tier).** For each
    finding an existing reviewer produced, before it is written to `findings.json`,
    three Jev questions run against `state = {the cited hunk, the finding's problem
    text}`: a `noul` question ("is this finding supported by the cited hunk"), a second
    `noul` question against each other finding already collected this round ("is this a
    duplicate of finding `<id>`"), and a `choice` question
    (`criteria: ["blocker","major","minor","info"]`) for severity. Every answer is
    recorded as an annotation alongside the finding, never as a mutation of it — this
    is additional signal for the human or the confirmation pass, not a second
    verification pipeline. It does not replace or bypass `review-verifier`
    (`src/review/verification.ts`) and never reaches a `confirmed`/`refuted` verdict by
    itself, on the same rule Requirement 11 already states.
23. **Early win: does the new commit address this comment?** For each unanswered human
    PR comment (`unansweredComments` over `PrCommentState.handled_comments`,
    `src/review/pr-comments.ts:1492`) collected by `keryx review comments collect`
    (`src/commands/review.ts:984-1039`), a `noul` question with `state = {the comment
    text, the new commit's diff}` asks whether the comment is now addressed. A
    high-probability answer is surfaced as a suggestion in the author's per-finding
    response step — never as an automatic write to `handled_comments` or an automatic
    reply; `keryx review comments reply` keeps deciding, and posting, exactly as it
    does today.

24. **Reference-document mode: three state kinds.** A reference document (a rule file,
    a skill, or a project skill) governs three different kinds of state, and a clause
    extracted from it (Requirements 4-6's mechanism, extended) is tagged
    `state_kind: "pr" | "report" | "hunk"`: (1) `pr` — the PR's own description,
    metadata, and size against a stated budget; (2) `report` — whether one of keryx's
    OWN reviewers' output follows the document's stated reporting contract (which
    fields a finding must carry, how findings are grouped and ordered); (3) `hunk` — code and test hunks checked against the sibling
    code-level documents the reference document points to (style patterns, testing
    conventions such as behaviour-level assertions and no vacuous tests), using the
    exact same hunk×rule mechanism as Requirements 7-9. A `hunk`-kind clause is not a
    new mechanism; it is an ordinary Requirement-4 rule whose source happens to be
    reached by following the reference document's own citations to sibling documents.
    Illustrative examples only (invented for this document, not quoted from any real
    file): a `pr`-kind clause might read "the PR body has a Rollback plan section"; a `report`-kind clause might read "every finding lists a reproduction step"; a `hunk`-kind clause might read "a new test asserts on a return
    value or an observable side effect, not solely on a mock having been called."
25. **Reference-document mode: state gathering per clause kind.** `pr`-kind clauses are
    checked against state gathered through the existing `GitHubPort` abstraction
    (`resolvePort`/`createGhPort`/`createFixturePort`, `src/commands/review.ts:
    1120-1134`) — PR title, body (split into named sections the same way the document
    names them), and diff stats, with `src/review/scope.ts`'s existing drop-reason
    taxonomy (`lockfile|generated|vendored|snapshot|minified`, `scope.ts:77-87`) reused
    to exclude mechanical bulk from a size-budget clause the same way the pre-filter
    already excludes it from review. `report`-kind clauses are checked against an
    existing review package's own `report.md`/`findings.json`
    (`ManagedReviewManifest`/`StructuredReviewFinding`, `src/review/types.ts:78-138,
    351-442`) — no new artifact format, this mode reads what the pipeline already
    writes. `hunk`-kind clauses reuse Requirement 3's `buildReviewScope` blocks
    unchanged.
26. **Reference-document mode: a clause Jev cannot check is recorded, not dropped.** A
    clause phrased as a live/manual action with no gatherable state to check it against
    — "verified against a running pipeline instance," "ownership of the change is
    confirmed by a named maintainer" —
    is tagged `checkable: false` with a one-line `reason` at extraction time
    (Requirement 6's extraction pass), kept in the normalized clause set, reported in
    coverage as `not_checkable` (never silently omitted, never counted as `0`
    violations — same "not recorded ≠ 0" discipline as Requirement 16), and never
    dispatched to Jev. A reference document's conformance report always states how many
    of its clauses were checkable versus not.
27. **Reference-document mode: confirmation pass, same shape as Requirement 10.** Every
    flagged clause (a `pr`/`report`-kind low-conformance answer, or a `hunk`-kind
    candidate) is handed to the same confirmation pass as Requirement 10, which cites
    the clause id in its explanation. `hunk`-kind confirmed findings enter
    `findings.json` exactly as Requirement 11 describes; `pr`/`report`-kind confirmed
    findings are reported to the author/operator (PR comment or console) and are not
    forced into `findings.json`'s per-hunk shape, since a PR-body or report-lane
    violation has no `file`/`line` to anchor to.
28. **Reference-document mode: CLI surface.** `keryx review conform --ref <doc>
    [--pr <n> | --report <path> | --diff <ref>] [--explain] [--json]` selects which
    clause kinds run from what was supplied: `--pr` runs `pr`-kind (and, combined with
    a diff, `hunk`-kind) clauses against that pull request via `GitHubPort`; `--report`
    runs `report`-kind clauses against an existing review package's report/findings
    files; `--diff` alone runs `hunk`-kind clauses only. Output reports, per clause:
    kind, checkable/not-checkable, and (when checkable) the Jev answer and, with
    `--explain`, the confirmation-pass result.
29. **Reference-document mode: TUI conformance view.** A view (extending the sidebar/
    modal of Requirement 17) shows, per loaded reference document: clause counts by
    kind and by checkable/not-checkable, the last PR's `pr`-kind conformance, the last
    review package's `report`-kind conformance, and the current diff's `hunk`-kind
    conformance, with drill-down into every flagged clause and its confirmation-pass
    explanation.

## Success criteria

- A project with `review.jev.enabled: true` and at least one applicable rule (bundled
  or project-skill) sees this reviewer's coverage row as `run`, not `skipped`, on a
  round touching files its rules apply to.
- Every finding this reviewer contributes to a `findings.json` validates against
  `reviewer-finding.schema.json` exactly like every other reviewer's findings, with no
  schema relaxation.
- Recall on the historical-corpus replay (Requirement 18) is reported as a real number,
  not "not measured" — this is the bar Phase 5 of `PLAN.md` exists to clear before the
  feature is called done.
- A project can import an external project's rule set (a private external project's, or
  any team's own checklist skills) as a keryx project skill and see it participate in a
  Jev triage round without keryx's own repository gaining a single line of that
  project's rule text.
- CI failure triage (Requirement 20) never reruns a job or writes a status check by
  itself — its output is console/PR-comment advisory text only, and this is asserted by
  a test, not just stated.
- Reviewer-dispatch scoring (Requirement 21) has zero test cases where a reviewer with a
  matching path/stack trigger is skipped because of a low Jev score.
- A reference document's conformance report (Requirement 26) always states a
  checkable/not-checkable split — a report that omits this split is a bug, not a
  formatting choice.

## Risks / honest limits

- **Jev is not a code reviewer.** Every requirement above exists to keep this true in
  the implementation: no requirement lets a `noul`/`choice` answer become a finding
  without a confirmation pass in between.
- **Extraction quality is the load-bearing risk.** A poorly extracted rule (an
  ambiguous `statement`, a wrong `applicability` glob) produces either silent
  under-coverage or noisy candidates that waste the confirmation pass's budget.
  Requirement 6's drift-checked cache and Requirement 14's `verify` command exist so
  this is visible and correctable, not silent.
- **Threshold tuning has no historical prior yet.** Requirement 18's evaluation is the
  mechanism to set a real default; until then any shipped default is a documented
  guess, not a measured one (Open Question 4, PLAN.md).
- **Cost/latency estimates in PLAN.md are estimates, not measurements**, exactly as
  `src/review/cost.ts`'s own header insists a stage that has not run must say so — they
  will be replaced by real `spent_usd`/`input_tokens` figures once Phase 5 runs against
  real projects.
- **Shared surface with the parallel `keryx-jev-router` package.** Both packages need a
  client for `POST /api/v1/systemone`. This PRD proposes the shape (Requirement 1) but
  does not claim ownership of a single shared module — see PLAN.md's Open Questions for
  the decision this needs from the operator.
- **CI failure triage has no historical prior of its own to launch with.** keryx has no
  existing CI-run-history reader (Requirement 20 adds the first narrow one), so a
  flaky/infra/real-regression classifier ships with no measured accuracy on this
  repository's own history until PLAN.md's evaluation phase runs it against real reruns.
- **Reference-document mode is the least mechanical of everything in this PRD.**
  Deciding whether a PR body names an out-of-scope list, or whether a report's lanes are
  in the right order, is closer to the kind of judgement Jev's vendor says it is not
  built for than a styling checklist bullet is. Requirement 26's checkable/not-checkable
  split and Requirement 27's confirmation pass exist specifically because this mode is
  more likely to need a human or a strong model to have the last word, not less.
