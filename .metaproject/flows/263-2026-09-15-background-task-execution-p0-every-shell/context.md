# Context

Collected deterministically by `keryx flow init` at 2026-09-15T18:39:15.979Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.878] A shell allowlist matched against the raw command string is not a security boundary (lesson/accepted) - lessons/allowlist-not-a-boundary.md
   A remembered glob pattern that is matched against a command string which is then handed to `/bin/sh -c` grants far more than it appears to. The pattern matches text; the shell re-interprets that text. Verified, not theorised: a live allowlist contained `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`, `sudo *`, and the exact string `rm -rf /` — each an arbitrary-execution grant that auto-approved with no prompt.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:src/lib, src/commands, src/tui, entity:shell-permissions, command-risk, approval gate
   provenance: source=flow 115 (shell approval hardening), stress reports in `.metaproject/data/stress/` link=docs/decisions/keryx-harness/ADR-0009-destructive-command-escalation.md author=unknown confirmedBy=unknown
2. [1.863] Theme switch repaints already-rendered chrome via old-slot value matching (lesson/accepted) - lessons/theme-switch-repaint.md
   `/theme` in the OpenTUI shell applied and persisted correctly on 0.2.66, but `applyTheme` (src/tui/shell-chrome.ts) only recolored the chrome's OWN surfaces (renderer background, sidebar border, docks, composer, `/`-menu). Every renderable painted EARLIER with `getTheme()` — transcript frames (user echoes, code-segment boxes, block bodies, side-worker boxes), tone-colored block headers (`theme.error`/`theme.tool`), dock/queue-dock buttons, sidebar panels — kept the old palette's hex in its `borderColor`/`backgroundColor`/`fg` props, so a dark→dark switch (groknight↔tokyonight) looked like "the theme did not apply". Fix: on every `applyTheme`, walk the renderable trees (transcript, docks, sidebarTop, menu, composer, header, footer) and rewrite any prop whose color equals an OLD theme slot hex to the NEW slot hex.
   claimType: lesson | confidence: high | version: 0.2.0
   scope: module:src/tui, entity:shell-chrome.ts
   provenance: source=manual link=unknown author=unknown confirmedBy=unknown
3. [1.733] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
4. [1.709] OpenTUI: alignSelf on a transcript box collapses its intrinsic height (lesson/accepted) - lessons/tui-alignself-height-collapse.md
   In a `@opentui/core` ScrollBox column, a child `BoxRenderable` carrying `alignSelf: "flex-start"` stops measuring its intrinsic HEIGHT: it collapses to the viewport height, squeezes its children, and makes the ScrollBox under-report `scrollHeight`. Hug content with `maxWidth` instead.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:tui, entity:transcript-blocks, shell-chrome
   provenance: source=flow 115 link=.metaproject/flows/115-2026-07-21-tui-dim-collapsible-thought-blocks-fix-a author=unknown confirmedBy=unknown
5. [1.691] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review (constraint/accepted) - constraints/stale-installed-keryx-binary.md
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

Source of truth: `docs/requirements/keryx-background-task-execution/` v1.1.0 —
specification §3–§8, brainstorm D-09…D-18 (owner-accepted 2026-09-15), schemas
`shell-task.schema.json` / `shell-task-event.schema.json`.

### Code facts (verified 2026-09-15)

- `shell_exec`: `src/harness/tool/builtin/shell-exec-tool.ts` — sync runner
  `makeCommandRunner` (`:83-194`, wall-clock deadline `:103-127`,
  `DEFAULT_SHELL_TIMEOUT_MS` `:46`, resolver `:56-66`), tool `:208-253`,
  `background` branch `:238-250`, description `:216-224`.
- Registry: `src/harness/tool/builtin/background-job-registry.ts` — handle
  abstraction `:22-38`, `BackgroundJobInfo` `:41-49`, caps `:52`/`:88`/`:102`,
  tail `:111`, events `:114-117`, `realSpawner` (detached, `-pid` kill)
  `:171-249`, `createJobRegistry` `:251-474`, `shell_job_output` `:477`,
  `shell_job_kill` `:508`.
- Consumers of statuses/events: `src/tui/background-job-session.ts:29,97-131`,
  `src/tui/job-bridge.ts`, `src/tui/background-job-inspector.ts`.
- Blast radius (`keryx gdgraph affected`, graph rebuilt in this worktree):
  agent.ts, interactive-agent-tools.ts, shell.ts, shell-exec-tool.ts, TUI
  background-job-{session,inspector}.ts, job-bridge.ts and their tests.
- Wiring: `buildInteractiveAgentTools` (`src/commands/interactive-agent-tools.ts:182-183`)
  is the only `shellExecTool` construction; production call sites pass a
  registry at `src/commands/shell.ts:2212` (TUI, `onEvent: emitBackgroundJob`)
  and `:2510` (readline, registry created at `:2453`).
- Schema validator supports `"integer"` (`src/contracts/validator.ts:39`).
- Scripts: `typecheck` = `tsc --noEmit`, `test` = `bun test`.
- Existing test fakes: `neverExitingSpawner` / injected `CommandRunner`
  (`shell-exec-background.test.ts:28-36`); real process-group test lives in
  `background-job-registry.test.ts`.

### Lessons applied

- Full `bun test` has load-induced 5 s timeout flakes → use `--timeout 30000`.
- Stale `data/testing/context.*` fails the pre-push gate → `keryx test analyze`.
- Prompt text that still advises `background:true` would contradict the new tool.
