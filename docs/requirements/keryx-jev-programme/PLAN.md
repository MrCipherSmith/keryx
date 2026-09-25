# Jev programme — working plan (2026-09-25)

Status: living plan. It covers every Jev-related flow that is in flight or
queued, with the files each one touches and how. The design sources are
[`keryx-jev-router`](../keryx-jev-router/) and
[`keryx-jev-review`](../keryx-jev-review/).

## Principles every flow follows

- **Facts first, Jev second.** keryx computes everything it can
  deterministically: diff facts, named files and symbols, exit codes, test
  counts, git history. Jev (TypeSafe System One on OpenRouter) only answers
  typed questions: `noul`, a probability, or `choice`, one option.
- **keryx writes the prose.** Jev returns no text. Every finding, notice or
  report line is synthesised by keryx from the facts plus Jev's answer.
  Reviewer findings follow `reviewer-finding.schema.json` and go through the
  orchestrator's normal quality gate, dedup and Wave C verification.
- **Additional, never replacing.** Jev reviewers are added to the existing
  reviewers. They never take one's place, and every verdict is labelled
  ADVISORY.
- **Opt-in per project.** Keys live under `review.jev.*` in
  `.metaproject/tasks.config.json`. The gate is checked before any network
  call.
- **Privacy.** Everything sent to Jev passes through `redactSensitiveText`,
  and only through the `src/security/service.ts` facade because the import
  ratchet is at its cap. Caches live under `.metaproject/data/<feature>/`,
  are gitignored and are written with mode 0600. No private document text is
  ever committed; fixtures are invented.
- **Zones.** Core modules (`src/review/*`, `src/flow/*`) define
  question/answer shapes and never import the client-zone Jev client. Only
  adapters (`src/commands/*`, `src/tui/*`) call
  `src/harness/decision/jev-client.ts`.
- **Budgets and honesty.** Every fan-out has a call cap, and truncation is
  always reported. Every measured number is published with n and an
  interval, and small n is labelled anecdotal.
- **TUI for every feature.** Each feature gets a slash command or modal tab,
  a sidebar row where it makes sense, and an entry in `HELP_GROUPS` plus
  `docs/docs/commands-by-task.md`.

## Done (on `main`)

| Flow | PR | What | Main files |
|---|---|---|---|
| 305 | #704 | Routing table, `/routing` | `src/harness/routing/{table,config,trust}.ts`, `src/commands/routing.ts`, `src/tui/routing-inspector.ts` |
| 306/307 | #705, #710, #713 | CI triage with deterministic signals, eval set | `src/review/ci-triage.ts`, `src/review/ci-port.ts`, `src/commands/review.ts`, `src/tui/ci-triage-*` |
| 308 | #711 | `keryx review conform` against a reference document | `src/review/conform-*.ts`, `src/tui/conform-*` |
| 309 | #712 | Live provider catalog and balance | `src/harness/provider-catalog*.ts`, `src/commands/providers.ts` |
| 326 | #717 | conform: one verdict per clause, hunk budget | `src/review/conform-jev.ts`, `conform-report.ts`, `src/tui/conform-*` |
| 331 | #721 | Benchmark with and without Jev | `bench/jev-review/**`, `docs/report/jev-review-benchmark-2026-09-25/` |

## In review

### 327 — model profiles and derived routing (PR #718)
- **Files.**
  - New: `src/harness/routing/model-profile.ts`, `src/harness/routing/derive-default-table.ts`, `src/commands/curated-model-lists.ts`.
  - Edited: `table.ts` (derived layer), `src/commands/routing.ts` (`profile list|set`), `src/commands/providers.ts` (profile refresh from the same `/models` body), `src/harness/provider-catalog.ts`, `src/tui/routing-inspector.ts`, `src/lib/shell-config.ts` (the `auth.json` lock), both copies of `model-selection.mdc`.
- **How.**
  - Profiles are stored in their own `model-profiles.json` (mode 0600, file-locked), migrated once out of `auth.json`.
  - Ranking goes by family size, then by version within the family. Dotted and hyphenated versions both count, so `opus-5.5` ranks above `opus-4.7` and `4-8` is read as 4.8.
  - The derived table is anchored on the session model:
    - planning and review get the strongest model not weaker than the session model;
    - subagents, docs and unattended get one step down, e.g. Sonnet;
    - quick gets the smallest model class.
  - Non-chat and `:free` models are never derived.
- **Remaining.** The round-3 fixes: hyphenated versions, the `auth.json` lock, `imagen`.

### 328 — `keryx flow check-ac` (PR #723)
- **Files.**
  - New: `src/flow/check-ac.ts` (core, re-exported via `src/flow/service.ts`), `src/commands/flow-check-ac.ts`.
  - Edited: `src/commands/flow.ts` (advisory at `implemented`/`complete`), `src/commands/review.ts` (attaches `ac-check.md` at ingest), `src/tui/flow-inspector.ts` and `inspector-sources.ts` (AC tab), `/ac`.
- **How.**
  - Not-checkable criteria are decided without a model.
  - For each criterion, keryx checks which named files, symbols, flags and paths appear in the diff or the tree; then it asks one Jev `noul`.
  - The cache key is the criteria checksum plus a hash of the diff.

### 329 — shell turn guard (PR #720)
- **Files.**
  - New: `src/review/turn-guard.ts`, `src/tui/turn-guard-source.ts`, `src/tui/turn-guard-inspector.ts`.
  - Edited: `src/tui/tui-shell.ts` (turn-end hook, sidebar row, `/guard`), `src/commands/shell.ts` (`--guard`), `src/lib/shell-config.ts`.
- **How.**
  - Facts come from the turn's tool calls.
  - Deterministic contradictions are raised only for real failures: a tool error, or a failed build, test, install or typecheck command.
  - Otherwise Jev gets two `noul` questions: was the request done, and does the reply contradict the facts.
  - The guard runs after the turn and never blocks.

### 330 — `review-jev-rules` reviewer (PR #722)
- **Files.**
  - New: `src/review/jev-rules*.ts`, `src/commands/review-jev-rules.ts`, `src/tui/jev-rules-command.ts`, and the skill `review-jev-rules/SKILL.md` (bundled and installed copies).
  - Edited: `review-orchestrator/SKILL.md` and `SKILL.detail.md` (Wave B, CLI engine), `src/review/reviewers.ts` (`engine: jev`).
- **How.** Every applicable (hunk, rule clause) pair gets one `noul`.
- **Current work.** Only clauses that conform's cached tagging marks as `hunk`-kind are used, and process rule files are filtered out. The live run is being repeated to compare precision before and after; the first run was about 10%.

## In implementation

### 332 — functional review: `review-jev-risk`, `review-jev-scenarios`
- **Files.** New `src/review/jev-risk*.ts`, `src/review/jev-scenarios*.ts`, `src/commands/review-jev-*.ts`, two reviewer skills, and TUI `/risk` and `/scenarios`.
- **Risk map.** Each hunk gets path-class facts, then one `noul` per risk dimension. The top hunks become `info`/`minor` findings and are passed as dispatch hints to the security and highload reviewers.
- **Scenarios.** Scenarios come from gdwiki/PRD, linked to code through gdgraph. Scenarios whose links the diff touches get one `noul` each. The output is a checklist of what to try by hand.

### 333 — review hygiene: `review-jev-docs`, `review-jev-comments`
- **Files.** New `src/review/jev-docs*.ts`, `src/review/jev-comments*.ts`, `src/commands/review-jev-*.ts`, two reviewer skills, and TUI `/staledocs` and `/opencomments`. There is an additive advisory-label hook in the comments reply path.
- **Stale docs.** Doc sections linked to changed code that the diff does not edit get one `noul` each. A renamed or removed CLI flag that is still mentioned in the docs is flagged without Jev.
- **Open comments.** Each open PR comment gets a `choice` of `resolved-by-fix`, `still-open`, `not-actionable` or `needs-escalation`. Facts come from the comment ledger and from later commits at the commented location. There are no GitHub writes.

## Queued (in this order)

1. **`review-jev-contract`**, the second orchestrator reviewer.
   - Files: new `src/review/jev-contract*.ts` built on flow 328's `src/flow/check-ac.ts`; the orchestrator SKILL (Stage 1 gate plus Wave B entry).
   - How: claims in the PR description and frozen acceptance criteria are checked against the diff. It replaces the orchestrator's by-eye Stage 1 "description vs diff" comparison with a scored one; the LLM step stays as a fallback.
2. **Jev in the orchestrator's own pipeline.**
   - Files: `src/review/` (new `jev-severity.ts`, `jev-dedup.ts`), the orchestrator SKILL (Quality Gate), `src/review/verification.ts` (ordering only).
   - How:
     - Severity calibration asks one `noul` per blocker or major finding: does it name a trigger and an observable outcome? The result is annotated, never used to demote automatically.
     - Duplicate merge asks one `noul` per candidate pair that shares a file or region. Merges are shown, never silent.
     - The verifier queue is ordered by Jev's plausibility of evidence given quote.
3. **Routing classifier**, router Flow C. It comes after 327.
   - Files: `src/harness/routing/classify.ts` (new), the shell dispatch path in `src/tui/tui-shell.ts` / `src/commands/agent.ts`.
   - How: one Jev `choice` over the routing categories per shell request, with the main model as a fallback when Jev is not connected. The chosen category and model are shown on the turn.
4. **Model guidance for Claude Code and Codex CLI.**
   - Files: the metaproject generators for `CLAUDE.md`/`AGENTS.md` (found via `keryx ctx rg "keryx:index"`), the subagent frontmatter templates in `src/gdskills/bundled/**`.
   - How: generate a "model choice" section from the routing table, and set the Claude Code subagent `model:` from each skill's `model_tier` (opus, sonnet or haiku).
5. **Real task cost.**
   - Files: usage records (`src/harness/**` usage/cost), `src/harness/routing/derive-default-table.ts`.
   - How: record the actual tokens and cost per (model, category). Derivation prefers the lower measured cost per task once n is large enough; until then the step rule decides.
6. **Small follow-ups.**
   - conform `--explain`: extract `buildExplainCandidates` into `src/review/conform-jev.ts` so the test covers `runConform`'s own wiring.
   - Share the TUI conform per-clause loop with the CLI helper.

## Release

When 327–333 are merged: `CHANGELOG.md`, `package.json` version, flow records and PR comment ledgers go into one release PR. Then the tag and npm publish, a global install, and a live smoke run of every Jev command plus `bench/jev-review` with `--live`. The article notes are kept outside the repository.
