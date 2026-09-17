# Context

Collected deterministically by `keryx flow init` at 2026-09-16T10:47:30.398Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.782] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
2. [1.727] A shell allowlist matched against the raw command string is not a security boundary (lesson/accepted) - lessons/allowlist-not-a-boundary.md
   A remembered glob pattern that is matched against a command string which is then handed to `/bin/sh -c` grants far more than it appears to. The pattern matches text; the shell re-interprets that text. Verified, not theorised: a live allowlist contained `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`, `sudo *`, and the exact string `rm -rf /` — each an arbitrary-execution grant that auto-approved with no prompt.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:src/lib, src/commands, src/tui, entity:shell-permissions, command-risk, approval gate
   provenance: source=flow 115 (shell approval hardening), stress reports in `.metaproject/data/stress/` link=docs/decisions/keryx-harness/ADR-0009-destructive-command-escalation.md author=unknown confirmedBy=unknown
3. [1.698] A fix round needs its own review: three consecutive rounds each introduced a blocker (lesson/accepted) - lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md
   On PR #215 (flow 127, project registry) three consecutive review-fix rounds each introduced a new blocker while closing the previous one. The defect was not in any single fix; it was in treating a fix as finished once it addressed the reported symptom.
   claimType: lesson | confidence: high | version: 0.5.0
   scope: module:core, entity:project-registry
   provenance: source=review rounds on PR #215 (flow 127), PR #216 (flow 128), PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/215 author=unknown confirmedBy=unknown
4. [1.648] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review (constraint/accepted) - constraints/stale-installed-keryx-binary.md
   `~/.local/bin/keryx` is an installed build, and its version lags the working tree. It is NOT the working tree. Every `keryx …` invocation — including `keryx review ingest`, which is how a managed review package is recorded — runs that build, so the review pipeline routinely does not exercise the code being reviewed.
   claimType: constraint | confidence: high | version: 0.1.0
   scope: module:review, memory, entity:managed-review-package
   provenance: source=fix-round review of PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/220 author=unknown confirmedBy=unknown
5. [1.645] Theme switch repaints already-rendered chrome via old-slot value matching (lesson/accepted) - lessons/theme-switch-repaint.md
   `/theme` in the OpenTUI shell applied and persisted correctly on 0.2.66, but `applyTheme` (src/tui/shell-chrome.ts) only recolored the chrome's OWN surfaces (renderer background, sidebar border, docks, composer, `/`-menu). Every renderable painted EARLIER with `getTheme()` — transcript frames (user echoes, code-segment boxes, block bodies, side-worker boxes), tone-colored block headers (`theme.error`/`theme.tool`), dock/queue-dock buttons, sidebar panels — kept the old palette's hex in its `borderColor`/`backgroundColor`/`fg` props, so a dark→dark switch (groknight↔tokyonight) looked like "the theme did not apply". Fix: on every `applyTheme`, walk the renderable trees (transcript, docks, sidebarTop, menu, composer, header, footer) and rewrite any prop whose color equals an OLD theme slot hex to the NEW slot hex.
   claimType: lesson | confidence: high | version: 0.2.0
   scope: module:src/tui, entity:shell-chrome.ts
   provenance: source=manual link=unknown author=unknown confirmedBy=unknown

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

Source of truth: `docs/requirements/keryx-background-task-execution/` v1.1.0 —
specification §6 (integration points) and §6.1 (completion delivery), brainstorm
D-09 (hold), D-10 (message shape and placement), D-11 (wake cap), D-06/F9 (no
recurring reminder). Predecessor: flow 263 (P0), shipped in 0.2.108.

### Code facts, verified on this branch (main @ 93805ac0)

- **The registry has no delivery bookkeeping.** Searched
  `background-job-registry.ts` for `observed|drainUndelivered|notif|deliver`:
  the only hits are comments about the `exit` event. P1 adds the state.
- **`KillReason` has five members** (`model`, `operator`, `idle`, `output-cap`,
  `session-exit`); the package's schema also lists `hold-timeout`, which P1 adds.
- **Round-boundary flush point:** `src/commands/agent.ts:1714-1723` already
  pushes `role: "user"` messages after the whole batch — the same contiguity
  rule the notification must obey, documented at `:1529-1543` with the observed
  provider rejection behind it.
- **Text-only finish:** `agent.ts:1407-1438`; the turn ends at the `return {}`
  on `:1438`. That is the `hold` attachment point.
- **Injection points:** `AgentDeps` at `agent.ts:158` (`unattended?` `:212`,
  `sweepBackgroundJobs?` `:267`, `jobRegistry?` `:278`),
  `RunAgentTurnOptions` at `:281` (`slateSession?` `:294`, `skipCloseTrigger?`
  `:308`) — `completionDelivery` joins the first, `origin` the second.
- **`REPEATABLE_TOOL_NAMES`** is `agent.ts:435`, currently `shell_job_output`
  only.
- **readline single line consumer:** `shell.ts:963-969` (`iterator` +
  `readLine`), deliberately one consumer so an approval read cannot race the
  main loop — the wake races here. One-shot `--print` lines:
  `shell.ts:2373-2379`.
- **TUI dispatch:** `runLine` at `tui-shell.ts:4422`; the settle handlers that
  drain `mainQueue` at `:5161` and `:5263`; `foregroundOperation.begin()` at
  `:4987` and `:5180`.
- **Providers ignore `provenance`.** No adapter under `src/harness/provider/`
  reads the field, so the banner — not the metadata — is what the model sees.

### Lessons applied

- Full `bun test` needs `--timeout 30000`; the default 5 s produces load flakes.
- `keryx test analyze` before pushing, or the pre-push gate fails on a stale
  testing context.
- Dispatched subagents stalled four times during P0: dispatch narrow slices
  under a transcript watchdog, and take the work over after a second stall.
- `keryx flow complete` and `keryx review complete` must be run from a script
  file — the worktree guard refuses a Bash command carrying that bare verb.
