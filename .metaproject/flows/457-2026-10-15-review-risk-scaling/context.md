# Context

Collected deterministically by `keryx flow init` at 2026-10-15T21:34:18.351Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [2.124] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
2. [1.885] A fix round needs its own review: three consecutive rounds each introduced a blocker (lesson/accepted) - lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md
   On PR #215 (flow 127, project registry) three consecutive review-fix rounds each introduced a new blocker while closing the previous one. The defect was not in any single fix; it was in treating a fix as finished once it addressed the reported symptom.
   claimType: lesson | confidence: high | version: 0.5.0
   scope: module:core, entity:project-registry
   provenance: source=review rounds on PR #215 (flow 127), PR #216 (flow 128), PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/215 author=unknown confirmedBy=unknown
3. [1.843] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review (constraint/accepted) - constraints/stale-installed-keryx-binary.md
   `~/.local/bin/keryx` is an installed build, and its version lags the working tree. It is NOT the working tree. Every `keryx …` invocation — including `keryx review ingest`, which is how a managed review package is recorded — runs that build, so the review pipeline routinely does not exercise the code being reviewed.
   claimType: constraint | confidence: high | version: 0.1.0
   scope: module:review, memory, entity:managed-review-package
   provenance: source=fix-round review of PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/220 author=unknown confirmedBy=unknown
4. [1.8] Theme switch repaints already-rendered chrome via old-slot value matching (lesson/accepted) - lessons/theme-switch-repaint.md
   `/theme` in the OpenTUI shell applied and persisted correctly on 0.2.66, but `applyTheme` (src/tui/shell-chrome.ts) only recolored the chrome's OWN surfaces (renderer background, sidebar border, docks, composer, `/`-menu). Every renderable painted EARLIER with `getTheme()` — transcript frames (user echoes, code-segment boxes, block bodies, side-worker boxes), tone-colored block headers (`theme.error`/`theme.tool`), dock/queue-dock buttons, sidebar panels — kept the old palette's hex in its `borderColor`/`backgroundColor`/`fg` props, so a dark→dark switch (groknight↔tokyonight) looked like "the theme did not apply". Fix: on every `applyTheme`, walk the renderable trees (transcript, docks, sidebarTop, menu, composer, header, footer) and rewrite any prop whose color equals an OLD theme slot hex to the NEW slot hex.
   claimType: lesson | confidence: high | version: 0.2.0
   scope: module:src/tui, entity:shell-chrome.ts
   provenance: source=manual link=unknown author=unknown confirmedBy=unknown
5. [1.781] gdctx-redaction-ignores-trust-tag (known-mistake/accepted) - known-mistakes/gdctx-redaction-ignores-trust-tag.md
   A `SecuritySource` tag (`trusted-project`) can be threaded all the way to a redaction call and still have zero effect on the policy outcome if the resolver only branches on `category`. Verify a trust axis actually changes a decision before shipping the tag, not just that the tag is present in the type.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:security, redaction, policy-resolution, entity:resolveDecision, buildFinding, SecuritySource, policyFor, image-url policy
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-2) author=unknown confirmedBy=Reproduced this session via `keryx ctx read README.md --mode full`

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

### Design facts (read-only agent, 2026-10-16)
- gdgraph edges `{from,to,kind,specifier,importKind}` (src/gdgraph/types.ts:60-73): no imported names, no exports, re-exports are plain specifiers (build.ts:241-307,331-346). Optional tree-sitter SymbolNode/CallEdge (types.ts:95-123; extract.ts:340-369; symbol.ts:101-142) — no exported flag, name-collision-limited.
- Parsers available: Bun.Transpiler (scan() gives exports), web-tree-sitter ^0.22.6, typescript ^5.9.3. Plan: re-parse only hop-1 importers' import clauses.
- Changed exported symbols: `touchedExportedSymbols` (src/review/jev-risk.ts:148-162; misses `export {a,b}` and body edits), `symbolsTouched` (jev-rules.ts:777); hunks via `hunkRegionsFromDiff` (conform-state.ts:216), `buildReviewScope` (scope.ts:1022).
- jev-risk: `computeHunkRiskFacts` deterministic (jev-risk.ts:266-297, path classes :64-138); model part one call per hunk, `scoreHunk` max, threshold 0.7, `computeRiskRoutingHints` (:620-637); client in src/commands/review-jev-risk.ts (adapter, core-zone rule). jev-select `decideCandidates` (jev-select.ts:205-240), core never skipped (:64-69).
- Text search: no programmatic ctx rg; pattern = fixed-argv Bun.spawn rg with injectable runner (src/harness/tool/builtin/spill-search.ts:19-45). blast-radius.ts:88-90 notes string keys invisible.
- Depth plug-in: SliceEntry (slice.ts:16-29); `requiredSlices` (waves.ts:5-8) used by ledger.ts:352,439, retry-plan.ts:219, estimate.ts:43; round-level light/full coverage.ts:10-21,88-115; coverage credit by any reviewer (coverage-complete.ts:132-137); readiness item 2 readiness.ts:115-129; drop reasons BLAST_RADIUS_DROP_REASONS blast-radius.ts:172; chunks.ts:97,135,153.
- Eval: `keryx review compare-reference` (review.ts:538,804,3196-3202; compare-reference.ts:181-237, classes A-E, "reproduced N of M"); review-418/419/427 data dirs (diff, scope, required, slices, drivers, consolidated-report; canonical-findings.json only in 418); src/eval/corpus.ts precision/recall runner.

### Harness audit (read-only agent, 2026-10-16) — rows to fix
1 Claude Code: raw/ + drivers + ledger rules only under "Shell host" (SKILL.md:78-94; ledger.ts:406) → nobody writes raw/, complete refuses.
2 Claude Code: global ~/.claude/skills/review-orchestrator is v1.6.0 vs bundled 1.11.0; missing verifier/regression/layout/pr-contract/jev-* skills.
3 Codex/others: Preflight 1 BLOCKS without spawn tool (SKILL.md:18,27-28); autonomous only takes PR URLs (autonomous-profile.ts:47-53).
4 keryx shell/autonomous: children get no shell_exec (spawn-subagent-tool.ts:1663-1677) → verifier capped at unverifiable; testing reviewer cannot run suites.
5 Autonomous prompt runs `required --mode all` without --scope/--package (autonomous-profile.ts:93) → always full.
6 isAttendedRun true for every non-autonomous run (coverage.ts:344-379; SKILL.md:1128 vs SKILL.detail.md:761).
7 TTY gates fine but `chunks estimate --mode automatic` and `publish --yes` are ungated bypasses (review.ts:4182-4236; review-chunks.ts:108-111; chunks-estimate.ts:128).
8 mutationWaiver.operatorQuote / override.operatorQuote / --operator-quote are agent-writable (coverage.ts:372-375; SKILL.md:1113; review.ts:3144).
9 `comments reply --final` posts with no gate (review.ts:1744-1800).
10 Item 10 unobservable outside keryx shell (orchestrator-log.ts:158-162; readiness.ts:254).
11 Shared .metaproject/data/review/raw leaks old rounds into verdict --raw / retry-plan (SKILL.md:94,104; verdict.ts:105-118; review-slice.ts:168-172).
12 Wave ceiling 60000 sized for keryx 5-min deadline applies to Agent subagents too (dispatch-check.ts:144-150).
13 Shell step 4 lacks review_wave {pass:"round"} and timeout_ms guidance (SKILL.md:94 vs :822; wave-key.ts:39).
14 Parent sees 16000 chars of child output (spawn-subagent-tool.ts:178,483-487,2265-2267) → parse raw file, never tool output.
15 Autonomous opens up to 5 rounds on same head; 6-per-wave vs skill 10 (autonomous-profile.ts:20,92).
16 Trigger flow-next review: spawn_subagent excluded (trigger/unattended.ts:48-54) → always BLOCKED.
17 plan_set/AskUserQuestion host-specific names, no mapping (SKILL.md:38,76,980).
Stale text: detail:652 "nine items" (10); detail:433 `--all (default)`; SKILL.md:1575 `gh pr review`; :1066 legacy reviewers in --all; readiness.ts:273 repair names only terminal --waive; SKILL.md:86 header vs :88; :1593 red flag vs :1113; review-verifier SKILL.md:105 "keryx is a Bun project"; detail:761 vs SKILL.md:1128; SKILL.md:1197 skill path root.

### Eval PRs (ground truth)
- #424 base 990bd146 head 913a69df (round head 2907d530): .metaproject/reviews/2026-08-31-ingest-424/ — 1 blocker, 12 major.
- #939 base 79a18ba0 head ede409d5; truth = fixes in #988 (`gh pr view 988`) + flows/417 journal (4 defect groups).
- #940 base 628d6e5e head 489d410f: .metaproject/data/review-418/ canonical-findings.json (3 major, 10 minor).
- #1005 base c586a3e2 head 847795c1 (823 KB): .metaproject/reviews/2026-10-13-pr-1005-round{1,2,3}-*/ — 6 major total.

### Owner decisions (2026-10-16)
Fix everything found; re-audit across harnesses; eval on 3-4 keryx PRs with real subagent rounds; release by morning; merge permission granted (merge on green CI).
