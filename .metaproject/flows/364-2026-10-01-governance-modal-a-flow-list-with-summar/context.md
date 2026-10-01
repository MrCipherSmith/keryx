# Context

Collected deterministically by `keryx flow init` at 2026-10-01T07:20:34.050Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.975] Flow ids are allocated per clone, not per checkout (constraint/accepted) - constraints/flow-ids-allocated-per-clone.md
   `flow init` reserves its number in the git common directory, so every linked worktree of one clone shares the id space. A number, once handed out, is never reused — not even after the flow directory is deleted or renumbered.
   claimType: constraint | confidence: high | version: 1.0.0
   scope: module:tasks, entity:flow
   provenance: source=flow 116 (fix duplicate flow ids) link=.metaproject/flows/116-2026-07-22-fix-duplicate-flow-ids-nextflowid-races- author=unknown confirmedBy=unknown
2. [1.905] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
3. [1.815] gdctx-flag-allowlist-no-bundle-expansion (known-mistake/accepted) - known-mistakes/gdctx-flag-allowlist-no-bundle-expansion.md
   A per-flag string allowlist that doesn't expand POSIX-bundled short flags rejects the idiomatic form of a tool's own CLI habits (`-il` vs `-i -l`); expand-then-check, not check-then-reject, for any allowlisted boolean-flag set.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, ripgrep, flag-parsing, entity:buildRgCommand, RG_SAFE_FLAGS, RG_SAFE_VALUE_FLAGS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-3) author=unknown confirmedBy=Reproduced this session via `keryx ctx rg -il "todo" src`
4. [1.815] gdctx-redaction-ignores-trust-tag (known-mistake/accepted) - known-mistakes/gdctx-redaction-ignores-trust-tag.md
   A `SecuritySource` tag (`trusted-project`) can be threaded all the way to a redaction call and still have zero effect on the policy outcome if the resolver only branches on `category`. Verify a trust axis actually changes a decision before shipping the tag, not just that the tag is present in the type.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:security, redaction, policy-resolution, entity:resolveDecision, buildFinding, SecuritySource, policyFor, image-url policy
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-2) author=unknown confirmedBy=Reproduced this session via `keryx ctx read README.md --mode full`
5. [1.786] A fix round needs its own review: three consecutive rounds each introduced a blocker (lesson/accepted) - lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md
   On PR #215 (flow 127, project registry) three consecutive review-fix rounds each introduced a new blocker while closing the previous one. The defect was not in any single fix; it was in treating a fix as finished once it addressed the reported symptom.
   claimType: lesson | confidence: high | version: 0.5.0
   scope: module:core, entity:project-registry
   provenance: source=review rounds on PR #215 (flow 127), PR #216 (flow 128), PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/215 author=unknown confirmedBy=unknown

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-09-29T17:13:55.539Z)
- refresh: `keryx health run`

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security
- mcp

## Agent Findings

Analysis on 2026-10-01. Implement on a branch cut from `origin/main`: the checkout this was written in
(`chore/flow-363-complete`) is 77 commits behind, and `main` already has two things this flow builds on.

**The modal today.** `src/tui/governance-inspector.ts` opens one tab (`report`) holding the stored
`latest.md` (`renderGovernanceMarkdown`), wrapped and scrolled; keys ↑/↓ j/k, PgUp/PgDn, `r` re-run,
esc. The runner (`src/tui/governance-panel.ts`, `createGovernanceRunner`) calls `buildGovernanceReport`
plus `writeGovernanceArtifacts` in-process with the CLI's default filters and never goes through the
model's JobRegistry; a UI click must never cost a model turn. Keep that for check and close too.

**Precedent for a list with an action.** `/flows` (`src/tui/flow-inspector.ts`, `presentFlows`) has a
selectable flow list, `[`/`]` to switch, a `c` key that runs `flow check-ac` and paints "Checking…"
while it runs. Reuse `clampScroll`, `windowLines`, `scrollToReveal`, `wrapLines` and the modal host.

**The stated effect already has a home on main.** Since 0.3.31 (#794) `flow init` scaffolds
`## Outcome criteria` in `description.md` with the hint line `OUTCOME_HINT`, and
`src/flow/description-intent.ts` exports `sectionOf`, `statementFrom`, `flowStatementFrom` (Problem,
then Expected outcome), re-exported through `src/flow/service.ts`. The governance aggregator must reach
these through the service facade (import policy, rule 2). An untouched hint is not an effect.

**Governance on main** added `acceptance: FlowAcceptance` to `FlowGovernance` and
`renderAcceptanceLine`, and made the reader tolerate a stored report without it. Follow the same
additive pattern for `effect` and `summary` (`GOVERNANCE_SCHEMA_VERSION` stays 1).

**The check needs a non-mutating gate evaluation.** `FlowService.complete` (`src/flow/service.ts`)
transitions to `completing` first, evaluates gates (acceptance-criteria, pull-request or main-merge,
base-branch, tasks, owner, review, health, security, confirmation), always appends to
`completionAttempts`, and on any fail returns the flow to `in-progress`. Running it as a "check" would
record a failed attempt and move the flow. Extract the gate evaluation into one function both paths call;
the check must not spend the confirmation token (`confirmationGate` only checks it, the spend is on the
passing path) and must not write the review gate's records, if it writes any (verify).

**Merge state is fetched but dropped.** `src/flow/tracker/github.ts` already runs
`gh pr view <url> --json isDraft,state,headRefOid,baseRefName`; `TrackerAdapter.prStatus`
(`src/flow/types.ts`) does not return `state`. Add an optional `state` field there (optional for the
same reason `headSha` and `baseRefName` are). The pull-request gate itself checks only "exists, checks
green", not merged; the close button adds "merged" on top, as the user asked, without changing the gate.

**Close.** `flow complete` takes `--signed-by`, falls back to `KERYX_ACTOR`, then the git identity
(`derived`). From the modal, call the service with the same fallbacks the CLI uses; do not invent a
`stated` identity. A flow with `--require-confirmation` needs a token from `keryx flow confirm`, which by
design runs outside the agent's tool roster; the modal does not mint one.
