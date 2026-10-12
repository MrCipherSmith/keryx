# Context

Collected deterministically by `keryx flow init` at 2026-10-12T14:30:13.179Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.849] A fix round needs its own review: three consecutive rounds each introduced a blocker (lesson/accepted) - lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md
   On PR #215 (flow 127, project registry) three consecutive review-fix rounds each introduced a new blocker while closing the previous one. The defect was not in any single fix; it was in treating a fix as finished once it addressed the reported symptom.
   claimType: lesson | confidence: high | version: 0.5.0
   scope: module:core, entity:project-registry
   provenance: source=review rounds on PR #215 (flow 127), PR #216 (flow 128), PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/215 author=unknown confirmedBy=unknown
2. [1.819] Theme switch repaints already-rendered chrome via old-slot value matching (lesson/accepted) - lessons/theme-switch-repaint.md
   `/theme` in the OpenTUI shell applied and persisted correctly on 0.2.66, but `applyTheme` (src/tui/shell-chrome.ts) only recolored the chrome's OWN surfaces (renderer background, sidebar border, docks, composer, `/`-menu). Every renderable painted EARLIER with `getTheme()` — transcript frames (user echoes, code-segment boxes, block bodies, side-worker boxes), tone-colored block headers (`theme.error`/`theme.tool`), dock/queue-dock buttons, sidebar panels — kept the old palette's hex in its `borderColor`/`backgroundColor`/`fg` props, so a dark→dark switch (groknight↔tokyonight) looked like "the theme did not apply". Fix: on every `applyTheme`, walk the renderable trees (transcript, docks, sidebarTop, menu, composer, header, footer) and rewrite any prop whose color equals an OLD theme slot hex to the NEW slot hex.
   claimType: lesson | confidence: high | version: 0.2.0
   scope: module:src/tui, entity:shell-chrome.ts
   provenance: source=manual link=unknown author=unknown confirmedBy=unknown
3. [1.78] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
4. [1.706] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review (constraint/accepted) - constraints/stale-installed-keryx-binary.md
   `~/.local/bin/keryx` is an installed build, and its version lags the working tree. It is NOT the working tree. Every `keryx …` invocation — including `keryx review ingest`, which is how a managed review package is recorded — runs that build, so the review pipeline routinely does not exercise the code being reviewed.
   claimType: constraint | confidence: high | version: 0.1.0
   scope: module:review, memory, entity:managed-review-package
   provenance: source=fix-round review of PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/220 author=unknown confirmedBy=unknown
5. [1.67] gdctx-flag-allowlist-no-bundle-expansion (known-mistake/accepted) - known-mistakes/gdctx-flag-allowlist-no-bundle-expansion.md
   A per-flag string allowlist that doesn't expand POSIX-bundled short flags rejects the idiomatic form of a tool's own CLI habits (`-il` vs `-i -l`); expand-then-check, not check-then-reject, for any allowlisted boolean-flag set.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, ripgrep, flag-parsing, entity:buildRgCommand, RG_SAFE_FLAGS, RG_SAFE_VALUE_FLAGS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-3) author=unknown confirmedBy=Reproduced this session via `keryx ctx rg -il "todo" src`

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

Anonymous diagnosis of the flow 428 live rerun (private bench: no names, no content).
Run: mode all, 18 reviewers, session tier `standard`, openai-codex/gpt-6.1-sol, max_findings 30,
mutation 0 killed / 2 survived, 1 major + 8 minor findings, severity audit 9 checked / 0 changed,
blast radius capped at 40 of 793 candidate files, layout reviewer BLOCKED (needs real-browser measurements).
Reference comparison: 4 of 19 reproduced, class A = 0, 12 class B, 3 class C; `review complete` refused.

| # | Hypothesis | Kind | Evidence |
|---|------------|------|----------|
| H1 | 8 reviewers retired as `not-run` after two results that "covered no new slice" | product | The 8 wrote `slices` as `{id, status, coverage}` objects, the 10 accepted wrote id strings. `retry-plan` reads `slices` through `asStrings` (src/review/retry-plan.ts) and drops objects. `reviewer-finding.schema.json` has no `slices` property, so nothing told them the shape. |
| H2 | 18 of 18 reviewers have unresolved rule anchors | driver / contract | `ledger build` reads the top-level `definition` of `drivers/<reviewer>.json` (src/commands/review-ledger.ts); the shell wrote the dispatch payload with a `skill_path` and no `definition`. The key is not documented in the orchestrator skill. |
| H3 | `raw/verifier-depth.txt` has no parsable `REVIEW_RESULT`; raw stays unreconciled; m2, m8, m12 (class C) lost | process / product | The file is a JSON `{summary, claims}` verification payload filed in the reviewer raw directory. The ledger requires a `REVIEW_RESULT` in every raw file and has no "not a reviewer reply" outcome. |
| H4 | 12 reference items class B (role ran, nothing matched) | model / tier / tools | 18 reviewers returned 11 findings; each states a read-only static review with no tests or probes; tier `standard`; regression reviewer saw 40 of 793 files; layout reviewer blocked. Not fixable by a contract change — a lever (tier, cap, probes) for the operator, proposed in AC6, not changed here. |

Not yet counted (T1): how many of the 15 missed items each cause explains; H1 and H3 explain class A/C
losses but only part of B. The attribution table is the first task, before any depth lever.
