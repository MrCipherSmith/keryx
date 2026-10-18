# Context

Collected deterministically by `keryx flow init` at 2026-10-16T11:39:18.647Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [2.081] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
2. [1.841] Theme switch repaints already-rendered chrome via old-slot value matching (lesson/accepted) - lessons/theme-switch-repaint.md
   `/theme` in the OpenTUI shell applied and persisted correctly on 0.2.66, but `applyTheme` (src/tui/shell-chrome.ts) only recolored the chrome's OWN surfaces (renderer background, sidebar border, docks, composer, `/`-menu). Every renderable painted EARLIER with `getTheme()` — transcript frames (user echoes, code-segment boxes, block bodies, side-worker boxes), tone-colored block headers (`theme.error`/`theme.tool`), dock/queue-dock buttons, sidebar panels — kept the old palette's hex in its `borderColor`/`backgroundColor`/`fg` props, so a dark→dark switch (groknight↔tokyonight) looked like "the theme did not apply". Fix: on every `applyTheme`, walk the renderable trees (transcript, docks, sidebarTop, menu, composer, header, footer) and rewrite any prop whose color equals an OLD theme slot hex to the NEW slot hex.
   claimType: lesson | confidence: high | version: 0.2.0
   scope: module:src/tui, entity:shell-chrome.ts
   provenance: source=manual link=unknown author=unknown confirmedBy=unknown
3. [1.78] gdctx-flag-allowlist-no-bundle-expansion (known-mistake/accepted) - known-mistakes/gdctx-flag-allowlist-no-bundle-expansion.md
   A per-flag string allowlist that doesn't expand POSIX-bundled short flags rejects the idiomatic form of a tool's own CLI habits (`-il` vs `-i -l`); expand-then-check, not check-then-reject, for any allowlisted boolean-flag set.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, ripgrep, flag-parsing, entity:buildRgCommand, RG_SAFE_FLAGS, RG_SAFE_VALUE_FLAGS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-3) author=unknown confirmedBy=Reproduced this session via `keryx ctx rg -il "todo" src`
4. [1.78] gdctx-redaction-ignores-trust-tag (known-mistake/accepted) - known-mistakes/gdctx-redaction-ignores-trust-tag.md
   A `SecuritySource` tag (`trusted-project`) can be threaded all the way to a redaction call and still have zero effect on the policy outcome if the resolver only branches on `category`. Verify a trust axis actually changes a decision before shipping the tag, not just that the tag is present in the type.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:security, redaction, policy-resolution, entity:resolveDecision, buildFinding, SecuritySource, policyFor, image-url policy
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-2) author=unknown confirmedBy=Reproduced this session via `keryx ctx read README.md --mode full`
5. [1.759] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review (constraint/accepted) - constraints/stale-installed-keryx-binary.md
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

### Case (vantage-frontend #7849 → #7908 → #7966)

- Finding (final review of #7435): "Playback slider pinned LTR — `MultiLayerPlaybackSlider.tsx:150` and `PlaybackHeader.tsx:101` hard-code `dir="ltr"`, so the timeline does not mirror in RTL." Filed as an issue item, implemented in #7908, extracted to #7966, reviewed twice (implementation only), approved, then refuted by the owner on platform practice (Material: do not mirror media controls/progress; Apple HIG: video controls and timeline indicators do not flip) and closed.
- Intent signals present in the code and ignored: explicit `dir="ltr"` override; a lint exemption noted as a "physical-LTR scroll/pixel island"; `MediaPlaybackControls.tsx:81` also forces `dir="ltr"`. The fix's reviewer filed that sibling as a follow-up instead of as evidence against the premise.
- The finding travelled through a follow-up ISSUE, not a review round: a premise check only inside `review ingest` would not have caught the implementation step.

### Where the gap is (0.3.120)

- Shared laws: canonical block `review-orchestrator/SKILL.md` "### Shared laws (every reviewer)" (~1318), copied into every reviewer, enforced by `src/gdskills/review-skills-iron-laws.test.ts` (derived from the canonical block; EXEMPT map 45-56). Laws: no reproducible path → info; never the theoretical; one per class. No intent/practice law.
- `review-layout/SKILL.md:116-124` RTL section lists only what flips.
- `review-verifier/SKILL.md:127` confirmed = procedure reproduced the defect; the verifier is delete-only (`src/review/verification.ts:173`).

### Wiring map for a new delete-only judge (mirror the verifier)

- types: `src/review/types.ts` verification vocab 287-379, finding `verification?` 479, managed input 594-604, package counts 784-787.
- merge: `src/review/verification.ts` (claims 143, merge 173, self-verification rejection, scope.md render 578-605).
- ingest: `src/commands/review.ts` flags 331/333, managed input 1049, reader 3586, counts 1128, help 4784/4865/5256; `src/commands/automatic-review.ts:203` CREATE_PATH_FLAGS; `src/review/managed.ts` merge 306, dedupe 349, persist 1540, scope blocks 2429.
- verdict `src/review/verdict.ts` classify 115-131, `VERIFICATIONS_FILE` 23; readiness `src/review/readiness.ts` verifierCheck 171, registry 318; flow gate `src/flow/review-gate.ts` 1221/1511-1578, dispositions 590-686.
- dedupe `src/review/dedupe.ts` severityRule; coverage `NOT_ROSTER` `src/review/coverage.ts:72`; operator decisions `src/review/operator-decisions.ts:17`, `src/commands/review-operator.ts:124`, `src/commands/operator-confirm-review.ts:565`; tier `src/gdskills/model-tier.ts:1337`; routing `src/commands/routing-corpus.ts:399,725,901`; catalog `src/gdskills/catalog.ts:282`; manifest `src/gdskills/bundled/install-manifest.json:474`; ceilings `src/gdskills/skill-length-ceilings.ts` (orchestrator at its 1582 ceiling — offset any new text; ceilings are only lowered).
- count tests: `src/gdskills/bundled-eval.test.ts:119` (79), `src/commands/skills.bundled-verify.test.ts:40-52` (79); exempt lists in the iron-laws and class-scope tests.
- fix-loop consumers: flow-orchestrator SKILL.md 412/447/690, task-implementer `input-contract.schema.json:140` `fix_context.review_feedback`, job-orchestrator, review-pr-feedback, feature-dev.

### Contract (all lanes build to this)

Premise claims file, `--premises <file|->` on `keryx review ingest` (beside `--verifications`):

```json
{ "judge": "review-premise", "model": "<id>",
  "premises": [ {
    "finding_id": "LY-003",
    "verdict": "upheld | downgraded | challenged | owner-decision",
    "severity": "minor",
    "intent_signals": [ { "ref": "src/x.tsx:150 | <sha>", "says": "explicit dir=ltr override" } ],
    "practice_sources": [ { "name": "Material Design — Bidirectionality", "says": "media controls do not mirror" } ],
    "reasoning": "…",
    "question": "…",
    "options": ["uphold — mirror the timeline", "dismiss — keep LTR, as platforms do"]
  } ] }
```

- `severity` only with `downgraded`, strictly lower than the finding's. `question` with `challenged`/`owner-decision`; `options` (≥2) with `owner-decision`.
- Delete-only: never adds a finding, never raises severity, never edits finding text. A judge equal to the finding's reporter is rejected (`self-judgement`). `challenged` needs ≥1 intent_signal or practice_source. An unknown finding id is rejected. Rejections are listed in scope.md like discarded verification claims.
- Stored at `research-evidence/premises.json`; a `premise` field on each finding record; counts in scope.md.
- Runs after dedupe over canonical findings of severity ≥ minor; external (PR-comment) findings may be challenged — they become questions, never auto-dismissed. Carried findings in a delta round keep their premise.
- Effect: `challenged`/`owner-decision` findings are **held** — not counted as open blocker/major, not passed in `fix_context.review_feedback`, listed in the verdict as "awaiting operator: <ids>". Readiness and the flow review gate fail while a held finding has no operator decision.
- Operator decision kind `premise-question`: `keryx review decide-premise --package <dir> --finding <id> --answer uphold|dismiss --reason "<why>"` (terminal; card `review_decide_premise` in keryx shell, like `review_override_reviewers`). `uphold` returns the finding to kept at its original severity; `dismiss` records `dismissed-incorrect` with the operator's reason as evidence.
- `downgraded` makes the judge's severity canonical (dedupe and verdict use it).
- Tier: `review-premise` runs on the deep tier (`model_tier: deep`); `keryx review tier` gives it deep.
- Standalone use (no review round): `keryx review premise-check --finding-file <json>` is NOT added; a fix-loop orchestrator whose input is a follow-up issue or an external finding dispatches `review-premise` directly with the finding text and code refs, and asks the operator on `challenged`/`owner-decision` before implementing.
