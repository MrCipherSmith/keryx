# Context

Collected deterministically by `keryx flow init` at 2026-09-23T21:26:28.759Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.684] A shell allowlist matched against the raw command string is not a security boundary (lesson/accepted) - lessons/allowlist-not-a-boundary.md
   A remembered glob pattern that is matched against a command string which is then handed to `/bin/sh -c` grants far more than it appears to. The pattern matches text; the shell re-interprets that text. Verified, not theorised: a live allowlist contained `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`, `sudo *`, and the exact string `rm -rf /` — each an arbitrary-execution grant that auto-approved with no prompt.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:src/lib, src/commands, src/tui, entity:shell-permissions, command-risk, approval gate
   provenance: source=flow 115 (shell approval hardening), stress reports in `.metaproject/data/stress/` link=docs/decisions/keryx-harness/ADR-0009-destructive-command-escalation.md author=unknown confirmedBy=unknown
2. [1.577] Flow ids are allocated per clone, not per checkout (constraint/accepted) - constraints/flow-ids-allocated-per-clone.md
   `flow init` reserves its number in the git common directory, so every linked worktree of one clone shares the id space. A number, once handed out, is never reused — not even after the flow directory is deleted or renumbered.
   claimType: constraint | confidence: high | version: 1.0.0
   scope: module:tasks, entity:flow
   provenance: source=flow 116 (fix duplicate flow ids) link=.metaproject/flows/116-2026-07-22-fix-duplicate-flow-ids-nextflowid-races- author=unknown confirmedBy=unknown
3. [1.571] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
4. [1.571] Theme switch repaints already-rendered chrome via old-slot value matching (lesson/accepted) - lessons/theme-switch-repaint.md
   `/theme` in the OpenTUI shell applied and persisted correctly on 0.2.66, but `applyTheme` (src/tui/shell-chrome.ts) only recolored the chrome's OWN surfaces (renderer background, sidebar border, docks, composer, `/`-menu). Every renderable painted EARLIER with `getTheme()` — transcript frames (user echoes, code-segment boxes, block bodies, side-worker boxes), tone-colored block headers (`theme.error`/`theme.tool`), dock/queue-dock buttons, sidebar panels — kept the old palette's hex in its `borderColor`/`backgroundColor`/`fg` props, so a dark→dark switch (groknight↔tokyonight) looked like "the theme did not apply". Fix: on every `applyTheme`, walk the renderable trees (transcript, docks, sidebarTop, menu, composer, header, footer) and rewrite any prop whose color equals an OLD theme slot hex to the NEW slot hex.
   claimType: lesson | confidence: high | version: 0.2.0
   scope: module:src/tui, entity:shell-chrome.ts
   provenance: source=manual link=unknown author=unknown confirmedBy=unknown
5. [1.526] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review (constraint/accepted) - constraints/stale-installed-keryx-binary.md
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

Verified by the orchestrator on 2026-09-24 in this worktree (local CLI 0.2.161; installed `keryx` is 0.2.154 and stale — use `bun ./src/cli.ts` for the code under change):

- GDCTX-1: `src/ctx/lines.ts` `FAILURE_STEMS`/`classifyLine`/`rankByVerdict`/`importantLines`/`compactLines`; callers in `src/commands/ctx.ts` `importantSection` (two call sites: ~851 test summary, ~1160 `summarizeCommandOutput`) and `compactLines` (~1147, ~1271). `runCommand` (~640) keeps `stdout`/`stderr`/`exitCode` separately and builds a merged `raw`.
- GDCTX-2: `src/commands/ctx.ts:317` passes `source: "trusted-project"` to `redactRaw`; `src/security/resolve.ts` (`policyFor` 37-51, `buildFinding`, `resolveDecision` ~184) never branches on source; `IMAGE_URL` detector in `src/security/detect/exfil.ts`.
- GDCTX-3: `buildRgCommand` `src/commands/ctx.ts:932`; `RG_SAFE_FLAGS` 875, `RG_SAFE_VALUE_FLAGS` after it.
- Hook: `src/ctx/hook-classify.ts` `GIT_ROUTABLE = /^(diff|log|show)$/` (~76). Note flow 321 (W5-a) concurrently reworks `src/ctx/runtimes.ts`/`orient-runtimes.ts`, not this file.
- Freshness: `src/gdgraph/staleness.ts` `checkGraphStaleness`; `printStaleNote` in `src/commands/gdgraph.ts` (~577-593).
- Benchmark: `fixtures/benchmark/keryx/gdctx-fact-preservation.json` (3 captured dogfood inputs; not loaded by any test; preservation is 18/18, 110/327, 108/155 — lossy by design, a compression benchmark, not a golden). Generator `scripts/benchmark/run-gdctx-oracle.ts` rewrites the file wholesale. `extractFacts` in `src/metrics/oracle-runner.ts:598`.
- CI: `test:core` in package.json covers `src/ctx/ src/commands/ src/gdgraph/ src/security/ src/metrics/ src/lib/ src/memory/`.
- GDCTX-5: already shipped — `renderIndexGateMarkdown` in `src/lib/templates.ts:381`, live `.metaproject/index.md` = 1,470 bytes (~368 tokens) and matches the template; existing test only bounds it at <2000 chars (`src/lib/templates.test.ts:155`). Remaining: enforce ≤400 tokens and pin the live file to the template.
- The ctx PreToolUse hook blocks heredoc `cat > file` writes; use the Write tool or an escape marker.
