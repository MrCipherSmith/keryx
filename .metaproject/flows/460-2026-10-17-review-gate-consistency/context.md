# Context

Collected deterministically by `keryx flow init` at 2026-10-17T03:45:41.984Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.806] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
2. [1.659] gdctx-redaction-ignores-trust-tag (known-mistake/accepted) - known-mistakes/gdctx-redaction-ignores-trust-tag.md
   A `SecuritySource` tag (`trusted-project`) can be threaded all the way to a redaction call and still have zero effect on the policy outcome if the resolver only branches on `category`. Verify a trust axis actually changes a decision before shipping the tag, not just that the tag is present in the type.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:security, redaction, policy-resolution, entity:resolveDecision, buildFinding, SecuritySource, policyFor, image-url policy
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-2) author=unknown confirmedBy=Reproduced this session via `keryx ctx read README.md --mode full`
3. [1.659] keryx-gdctx-gdgraph-routing-index-cost-not-measured-before-shipping (known-mistake/accepted) - known-mistakes/keryx-gdctx-routing-index-cost-not-measured-before-shipping.md
   A mandatory context-injection rule's per-read cost multiplies by every subsequent turn and every subagent dispatch. Measure the re-billed cost across a realistic turn count and subagent fan-out before setting a rule's default scope, not just its one-time size.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:context, orchestration, keryx-cli, subagent-dispatch, entity:hard-gate rule, transcript re-sending, subagent-context-assembly, orient-runtime
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-5) and docs/requirements/keryx-context-measurement/context-loading.md author=unknown confirmedBy=Measured in context-loading.md: 41,556→42,133 tokens across 4 turns with full index re-billing
4. [1.595] Theme switch repaints already-rendered chrome via old-slot value matching (lesson/accepted) - lessons/theme-switch-repaint.md
   `/theme` in the OpenTUI shell applied and persisted correctly on 0.2.66, but `applyTheme` (src/tui/shell-chrome.ts) only recolored the chrome's OWN surfaces (renderer background, sidebar border, docks, composer, `/`-menu). Every renderable painted EARLIER with `getTheme()` — transcript frames (user echoes, code-segment boxes, block bodies, side-worker boxes), tone-colored block headers (`theme.error`/`theme.tool`), dock/queue-dock buttons, sidebar panels — kept the old palette's hex in its `borderColor`/`backgroundColor`/`fg` props, so a dark→dark switch (groknight↔tokyonight) looked like "the theme did not apply". Fix: on every `applyTheme`, walk the renderable trees (transcript, docks, sidebarTop, menu, composer, header, footer) and rewrite any prop whose color equals an OLD theme slot hex to the NEW slot hex.
   claimType: lesson | confidence: high | version: 0.2.0
   scope: module:src/tui, entity:shell-chrome.ts
   provenance: source=manual link=unknown author=unknown confirmedBy=unknown
5. [1.591] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review (constraint/accepted) - constraints/stale-installed-keryx-binary.md
   `~/.local/bin/keryx` is an installed build, and its version lags the working tree. It is NOT the working tree. Every `keryx …` invocation — including `keryx review ingest`, which is how a managed review package is recorded — runs that build, so the review pipeline routinely does not exercise the code being reviewed.
   claimType: constraint | confidence: high | version: 0.1.0
   scope: module:review, memory, entity:managed-review-package
   provenance: source=fix-round review of PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/220 author=unknown confirmedBy=unknown

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

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

### Root causes (code reading at 0.3.120, bb0423cab; flow 459 changed only premise code in these files)

Source report: /Users/Goodea/.claude/uploads/6e21c062-ce7d-4325-ac7a-f18aff8997ec/90e502aa-pr-7975-process-XXXXXX.md

A (confirmed) readiness READY vs complete refusing:
1. coverage.ts effectiveDepth (~495-509): a light dispatch with packageDir always recomputes the diff from git; packageDiffStats (477-483) runs `git diff ${target.ref}...${target.head}` — for a PR target ref is the PR URL/number (review.ts:1025/1046) → git fails → "diff could not be resolved" → full 11 set. target.base ignored; prior-round.ts:315 resolveBase does it right.
2. git cwd = projectRootOfPackage(pkg) (coverage.ts:704-711) = dir holding .metaproject (output/review-pr-7975), pathspec "." relative to it. requiredReviewers(root) reads inventory there; `review required` uses process.cwd() (review.ts:3326).
3. readiness reviewersCheck (readiness.ts:149-174) / ledgerCheck (219-225) never call coverageErrors; ledger.ts:694 comment wrong.
Fix: packageDiffStats uses target.base for pr (fallback resolveBase); git at `git rev-parse --show-toplevel` of packageDir; readiness runs coverageErrors with research.ts:56-64 options. Tests: coverage.test PR package light 2 files → []; nested package; readiness fails item 3 when complete would refuse.

B (confirmed) reviewer-override ignored: coverage.ts:612-618 consults decisions only when dispatch.override set or mode diff; card/override-reviewers write only operator-decisions.json; ledger never writes override. Subject/head match fine. Fix: reviewerSetErrors accepts missing reviewers when confirmedDecision(pkg,"reviewer-override",operatorDecisionSubject(...)) exists. Test: complete-coverage-gate.test.

C (confirmed) nudge → other PR: agent.ts:3483-3505 holdReviewGate → completion-gate.ts:46-93 findReviewGateState(process.cwd(), since): scans only reviewsRoot(cwd), newest open review-flow by mtime (71), only ingest packages filtered by since (66); active-review pointer (active-review.ts:77-89) not consulted. Fix: prefer pointer / packages started this session; skip review-flow packages with mtime < since. Test: completion-gate.test.

E (confirmed) empty child: spawn-subagent-tool.ts:2259-2266 placeholder "(subagent produced no text)", status from finishReason only (2299, 2328-2329). Fix: placeholder & nothing submitted → isError. Ledger already treats empty raw as not-run (ledger.ts:376-378,435,458-459).
D (hypothesis) scopeComplete true: ledger.ts:487 DONE without `slices` claims all assigned slices; 520 no manifest → complete. Fix: require explicit slices when a manifest exists; a reply declaring an unreadable input is incomplete. Children unable to read pr_context: dispatch-check.ts:58,117-125 checks relative to parent cwd; child cwd spawn-subagent-tool.ts:789-812; dot-dir skipping — unproven.
F (confirmed) ledger.ts:532 notRun light mutation unconditional — read research-evidence/mutation-*.json. managed.ts:270/1179-1192 normalizeCoverage defaults ["review-orchestrator"], ignores research.dispatch.runs (manifest 272). Readiness item 6 (227-235) misses omission.
Also from report: parent-agent errors (not keryx) — payload model as object, routing dupes; dispatch-check should validate.

### G/H context (flow 459 review of PR #1043)

- G: `keryx review ingest --report` refused round 1 with a list of findings whose quote "does not appear in the file" or "matches at least 2 places" (the locator refuses to guess an anchor). One bad quote refuses the whole round, so no round is recorded and `review plan` finds no previous round (rounds 2-5 had to be run by hand). Locator: search `the quote does not appear in the file` in src/review.
- H: drivers/results record the reviewer model (flow 458) but no token use. keryx shell spawn_subagent knows usage; Claude Code's Agent result reports subagent tokens to the parent.
- I: flows 458 (PR #1041, 0.3.120) and 459 (PR #1043, 0.3.121) are merged and released; AC confirmations, `flow implemented`, `flow complete` not yet run.

