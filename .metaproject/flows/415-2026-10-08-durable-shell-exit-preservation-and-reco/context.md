# Context

Collected deterministically by `keryx flow init` at 2026-10-08T10:47:13.895Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.687] gdctx-flag-allowlist-no-bundle-expansion (known-mistake/accepted) - known-mistakes/gdctx-flag-allowlist-no-bundle-expansion.md
   A per-flag string allowlist that doesn't expand POSIX-bundled short flags rejects the idiomatic form of a tool's own CLI habits (`-il` vs `-i -l`); expand-then-check, not check-then-reject, for any allowlisted boolean-flag set.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, ripgrep, flag-parsing, entity:buildRgCommand, RG_SAFE_FLAGS, RG_SAFE_VALUE_FLAGS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-3) author=unknown confirmedBy=Reproduced this session via `keryx ctx rg -il "todo" src`
2. [1.687] gdctx-stem-classifier-misreads-stdout (known-mistake/accepted) - known-mistakes/gdctx-stem-classifier-misreads-stdout.md
   A keyword-stem classifier applied to raw stdout regardless of exit code turns ordinary English ("refuse," "cannot," "crash") into a false tool-failure signal. Gate stem-matching on stderr or a non-zero exit code, not on the words alone.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, classification, output-analysis, entity:classifyLine, importantLines, compactLines, FAILURE_STEMS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-1) author=unknown confirmedBy=Reproduced this session via `keryx ctx run -- printf 'refuse this\n'`
3. [1.62] Theme switch repaints already-rendered chrome via old-slot value matching (lesson/accepted) - lessons/theme-switch-repaint.md
   `/theme` in the OpenTUI shell applied and persisted correctly on 0.2.66, but `applyTheme` (src/tui/shell-chrome.ts) only recolored the chrome's OWN surfaces (renderer background, sidebar border, docks, composer, `/`-menu). Every renderable painted EARLIER with `getTheme()` — transcript frames (user echoes, code-segment boxes, block bodies, side-worker boxes), tone-colored block headers (`theme.error`/`theme.tool`), dock/queue-dock buttons, sidebar panels — kept the old palette's hex in its `borderColor`/`backgroundColor`/`fg` props, so a dark→dark switch (groknight↔tokyonight) looked like "the theme did not apply". Fix: on every `applyTheme`, walk the renderable trees (transcript, docks, sidebarTop, menu, composer, header, footer) and rewrite any prop whose color equals an OLD theme slot hex to the NEW slot hex.
   claimType: lesson | confidence: high | version: 0.2.0
   scope: module:src/tui, entity:shell-chrome.ts
   provenance: source=manual link=unknown author=unknown confirmedBy=unknown
4. [1.615] A shell allowlist matched against the raw command string is not a security boundary (lesson/accepted) - lessons/allowlist-not-a-boundary.md
   A remembered glob pattern that is matched against a command string which is then handed to `/bin/sh -c` grants far more than it appears to. The pattern matches text; the shell re-interprets that text. Verified, not theorised: a live allowlist contained `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`, `sudo *`, and the exact string `rm -rf /` — each an arbitrary-execution grant that auto-approved with no prompt.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:src/lib, src/commands, src/tui, entity:shell-permissions, command-risk, approval gate
   provenance: source=flow 115 (shell approval hardening), stress reports in `.metaproject/data/stress/` link=docs/decisions/keryx-harness/ADR-0009-destructive-command-escalation.md author=unknown confirmedBy=unknown
5. [1.598] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-10-06T09:19:55.947Z)
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

Audit scope: research/part2-data working-tree source, not installed 0.3.78/current main. Graph predates HEAD; source checks are authoritative. Related-memory hits above are mostly unrelated; wiki results did not prove automatic exit dispatch.

- src/tui/shell-exit.ts: command exit awaits Slate close and cleanup, not SAC dispatch/final history flush.
- src/tui/tui-shell.ts: onDestroy cancels work, releases bus/lease, fires optional SessionEnd without awaiting and ignores hook errors; outer finally lacks explicit wrap-up/Slate preservation.
- src/commands/shell.ts: makeSignalShutdown releases bus/lease before job/MCP close and process.exit, without history/Slate/wrap-up input. SIGHUP integration needs implementation-time inventory.
- src/session/slate-lifecycle.ts: closeSlateSession archives Slate and sets opened=false; no proposal dispatch.
- src/sac/machine-wrap-up.ts: runWrapUp returns empty groups for zero Seeds; real Seeds can resolve/create workspace or yield unbound artifacts; live writeSlate during binding matters for immutable replay.
- src/sac/session-wrap-up.ts: trusted evidence producer reads archive, Slate Seeds/Course and diff with redaction; not an interactive exit trigger.
- src/tui/tui-shell.ts and src/commands/shell.ts: ongoing history checkpoints exist, with 300-ms assistant-delta throttle. Readline swallows checkpoint exceptions; final flush can be skipped after a throwing turn. Do not claim all in-flight history is unpersisted.
- src/session/store.ts: persistHistory writes context/archive/transcript then summary sequentially; individual atomic writes are not a multi-file transaction. Existing one-shot process-termination/flow-done dispatch elsewhere does not prove interactive coverage.
- Independent read-only investigation sub:f4f5a28b-a5cc-4156-8ab3-2de1618b3717 reported DONE_WITH_CONCERNS, supporting checkpoint/outbox and identifying existing catch-up/Review surfaces; automatic archived-Seed replay not established.
- Related test candidates: shell-exit, store, slate-lifecycle, machine-wrap-up, catch-up and shell signal/PTY suites. No implementation tests run in this research step; revalidate main before implementation.

## Current-main revalidation for approval

- Fetched origin/main at 2026-10-08T11:08:55Z: `6bf403944003c42fc6312ffd011e504426307382` (combined 0.3.79 documentation, #925). Detached audit checkout: `.git/flow415-main-audit/20261008T110843Z/tree`; fetch manifest in its parent. Working branch/head remained research/part2-data / `7ffa36d9494a1f20d1c7fa99b8574aebd7b7964e`.
- References below are relative to that pinned checkout and supersede broad older working-tree assertions. This is static evidence, not executed exit/fault acceptance.
- `src/commands/shell.ts:3536-3590`: signal shutdown has cleanup/bus/lease inputs, not history/Slate/dispatch; bus and lease release precede asynchronous cleanup. `:4247` registers SIGTERM. `:2499-2512` shows existing checkpointing and a 300-ms delta timer; not all in-flight state is unpersisted.
- `src/tui/tui-shell.ts:3916-3988`: renderer destruction cancels work, releases bus/lease and fires optional SessionEnd without awaiting. Done waits for job sweep, not checkpoint/outbox. `src/tui/shell-exit.ts:75` command exit awaits Slate close/cleanup/release without final history flush or wrap-up dispatch.
- Correction: not all SessionEnd hooks are unawaited. `src/commands/shell.ts:4567-4577` normal readline REPL finally awaits its optional hook and catches errors. This remains optional, not the mandatory local preservation contract; signal shutdown is a separate path.
- `src/session/slate-lifecycle.ts` archives Slate on close; `src/session/store.ts` persistHistory still writes context/archive/transcript/summary separately. These paths do not establish a unified generation commit.
- `src/sac/machine-wrap-up.ts:801` returns empty groups for zero Seeds. Real Seeds resolve/create under existing policy or produce guarded unbound artifacts; best-effort binding writes live Slate. Replay must not write reopened/successor Slate.
- `src/sac/session-wrap-up.ts` evidence uses session archive, live Slate and working-tree diff: immutable intent alone is insufficient unless evidence generation also uses the pinned snapshot.
- `src/sac/catch-up.ts:261-335` classifies existing blocked/unbound/failure/unknown evidence and excludes live locks. This does not prove automatic archived-Seed delivery or exactly-once insertion; reuse the recovery surface with explicit implementation/tests.
- `src/commands/harness.ts:621` has one-shot process-termination runWrapUp. No corresponding interactive dispatch was found in the inspected shell files; preserve existing one-shot behavior.

Approval boundaries: no freeze/start, AC confirmation, owner assignment, production edit, commit/push or release. Revalidate main again at implementation start if it advances.
