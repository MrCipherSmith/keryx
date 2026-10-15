# Context

Collected deterministically by `keryx flow init` at 2026-10-15T11:21:49.428Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [2.104] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
2. [1.907] A fix round needs its own review: three consecutive rounds each introduced a blocker (lesson/accepted) - lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md
   On PR #215 (flow 127, project registry) three consecutive review-fix rounds each introduced a new blocker while closing the previous one. The defect was not in any single fix; it was in treating a fix as finished once it addressed the reported symptom.
   claimType: lesson | confidence: high | version: 0.5.0
   scope: module:core, entity:project-registry
   provenance: source=review rounds on PR #215 (flow 127), PR #216 (flow 128), PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/215 author=unknown confirmedBy=unknown
3. [1.782] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review (constraint/accepted) - constraints/stale-installed-keryx-binary.md
   `~/.local/bin/keryx` is an installed build, and its version lags the working tree. It is NOT the working tree. Every `keryx …` invocation — including `keryx review ingest`, which is how a managed review package is recorded — runs that build, so the review pipeline routinely does not exercise the code being reviewed.
   claimType: constraint | confidence: high | version: 0.1.0
   scope: module:review, memory, entity:managed-review-package
   provenance: source=fix-round review of PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/220 author=unknown confirmedBy=unknown
4. [1.759] Theme switch repaints already-rendered chrome via old-slot value matching (lesson/accepted) - lessons/theme-switch-repaint.md
   `/theme` in the OpenTUI shell applied and persisted correctly on 0.2.66, but `applyTheme` (src/tui/shell-chrome.ts) only recolored the chrome's OWN surfaces (renderer background, sidebar border, docks, composer, `/`-menu). Every renderable painted EARLIER with `getTheme()` — transcript frames (user echoes, code-segment boxes, block bodies, side-worker boxes), tone-colored block headers (`theme.error`/`theme.tool`), dock/queue-dock buttons, sidebar panels — kept the old palette's hex in its `borderColor`/`backgroundColor`/`fg` props, so a dark→dark switch (groknight↔tokyonight) looked like "the theme did not apply". Fix: on every `applyTheme`, walk the renderable trees (transcript, docks, sidebarTop, menu, composer, header, footer) and rewrite any prop whose color equals an OLD theme slot hex to the NEW slot hex.
   claimType: lesson | confidence: high | version: 0.2.0
   scope: module:src/tui, entity:shell-chrome.ts
   provenance: source=manual link=unknown author=unknown confirmedBy=unknown
5. [1.699] gdctx-flag-allowlist-no-bundle-expansion (known-mistake/accepted) - known-mistakes/gdctx-flag-allowlist-no-bundle-expansion.md
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

Source: post-mortem "Почему ревью идут так долго: PR #7927 и #7931" (owner upload,
2026-10-15), verified against main 2cf8c94a5 by three read-only agents.

### Verified on main

| Area | Fact | Anchor |
|---|---|---|
| mutate | scratch = `mkdtemp(tmpdir()/keryx-mutate-)`, copy via `cp` + `node_modules` symlink | src/review/mutate.ts:122-129, :146 |
| mutate | baseline keeps only `{exitCode,timedOut,ms}`; red/timeout throws without output; timeout 300 s | mutate.ts:100-107, :145, :150-152; CLI review.ts:3072 |
| mutation gate | `mutationErrors` refuses when `pendingMutants>0` and attended, unless `dispatch.mutationWaiver` | src/review/coverage.ts:182-199 |
| reviewer set | `requiredReviewers` = stack-filtered inventory + `BUNDLED_PATH_GATES` + mode diff (`derivedFromFiles`) + blast-radius/pr-context; no line counts | coverage.ts:36-70, :119; runRequired review.ts:3037, flags :532 |
| round need | `classifyRoundNeed` yes/no, not wired to CLI | src/review/round-need.ts:103-112 |
| tier | `review tier` picks a model tier, not depth; `review lightweight` = report-only | review.ts:668, :810 |
| results | raw reviewer outputs in package `raw/`; latest raw per reviewer decides | src/commands/review-ledger.ts:30-33, :65, :94-108 |
| retry | `retry-plan` never reads the filesystem; caller passes `--result/--covered/--state`; `--next-wave` from manifest | src/review/retry-plan.ts:190-193, :254-268; review-slice.ts:26, :287 |
| spawn | child deadline = min(5 min reservation, `KERYX_SUBAGENT_TIMEOUT_MS`); late result ignored; slate deleted | src/harness/tool/builtin/spawn-subagent-tool.ts:332, :408-471, :1944-1949, :2170-2215 |
| dispatch-check | checks schema, `pr_context`, slices, size; not `skill_path`/`context_doc` | src/review/dispatch-check.ts:70-139; schema review-orchestrator/reviewer-input.schema.json |
| help | `REVIEW_SUBCOMMAND_HELP` map; missing start/ingest/required/mutate/blast-radius/complete/status | review.ts:4298-4319; test src/commands/review-help.test.ts |
| start | `refreshCreatedPackageLayers` awaited, graph built in detached worktree, no timeout | review.ts:826-885; src/review/layers.ts:440-457 |
| status | `runStatus` prints coverage/parity, no findings, no interim verdict | review.ts:3832; readiness :640 |
| skill | verifier "AFTER all others" :1067/:1119; one role one launch :1111; depth floor SKILL.detail.md:457-472; host text :88-94 contradicts | src/gdskills/bundled/skills/review/review-orchestrator/ |
| skill tests | length ceiling 1615 lines (skill-length-ceilings.ts:174); bundled ↔ installed parity test; preflight/iron-laws/wave tests | src/gdskills/*.test.ts |

### Not reproduced on main (out of scope)

`blast-radius --json` stdout (status → stderr, review.ts:3573-3638); `layers block` rewrites
only absent/stale/`--force` (review-layers.ts:77-83); ingest accepts fileless findings
(types.ts:413) and records verifier verdicts, reasoning-only capped to `unverifiable`
(types.ts:317); graph label is `graph@<sha7> = head|differs` (layers-view.ts:19-26).

### Owner decisions (2026-10-15)

- One flow for all five work areas.
- Fast path: light round only OUTSIDE the risk class (≤5 files, ≤300 changed lines, no
  path-gate hit, not `--all`/gating); risky PRs keep the full set.
- Delivery for the live check: npm patch release after merge.
- Owner: MrCipherSmith. Live check by the owner in vantage-frontend, answer in 2-3 days.
