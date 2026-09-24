# Context

Collected deterministically by `keryx flow init` at 2026-09-23T21:26:30.807Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.857] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
2. [1.792] A shell allowlist matched against the raw command string is not a security boundary (lesson/accepted) - lessons/allowlist-not-a-boundary.md
   A remembered glob pattern that is matched against a command string which is then handed to `/bin/sh -c` grants far more than it appears to. The pattern matches text; the shell re-interprets that text. Verified, not theorised: a live allowlist contained `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`, `sudo *`, and the exact string `rm -rf /` — each an arbitrary-execution grant that auto-approved with no prompt.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:src/lib, src/commands, src/tui, entity:shell-permissions, command-risk, approval gate
   provenance: source=flow 115 (shell approval hardening), stress reports in `.metaproject/data/stress/` link=docs/decisions/keryx-harness/ADR-0009-destructive-command-escalation.md author=unknown confirmedBy=unknown
3. [1.776] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review (constraint/accepted) - constraints/stale-installed-keryx-binary.md
   `~/.local/bin/keryx` is an installed build, and its version lags the working tree. It is NOT the working tree. Every `keryx …` invocation — including `keryx review ingest`, which is how a managed review package is recorded — runs that build, so the review pipeline routinely does not exercise the code being reviewed.
   claimType: constraint | confidence: high | version: 0.1.0
   scope: module:review, memory, entity:managed-review-package
   provenance: source=fix-round review of PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/220 author=unknown confirmedBy=unknown
4. [1.741] A fix round needs its own review: three consecutive rounds each introduced a blocker (lesson/accepted) - lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md
   On PR #215 (flow 127, project registry) three consecutive review-fix rounds each introduced a new blocker while closing the previous one. The defect was not in any single fix; it was in treating a fix as finished once it addressed the reported symptom.
   claimType: lesson | confidence: high | version: 0.5.0
   scope: module:core, entity:project-registry
   provenance: source=review rounds on PR #215 (flow 127), PR #216 (flow 128), PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/215 author=unknown confirmedBy=unknown
5. [1.72] Flow ids are allocated per clone, not per checkout (constraint/accepted) - constraints/flow-ids-allocated-per-clone.md
   `flow init` reserves its number in the git common directory, so every linked worktree of one clone shares the id space. A number, once handed out, is never reused — not even after the flow directory is deleted or renumbered.
   claimType: constraint | confidence: high | version: 1.0.0
   scope: module:tasks, entity:flow
   provenance: source=flow 116 (fix duplicate flow ids) link=.metaproject/flows/116-2026-07-22-fix-duplicate-flow-ids-nextflowid-races- author=unknown confirmedBy=unknown

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

Collected by the flow orchestrator (2026-09-23).

### Current registries (what W5-a replaces)

- `src/ctx/runtimes.ts` — `CtxRuntime`, `CTX_RUNTIMES` (claude, codex, cursor,
  windsurf verified; antigravity, opencode experimental), `UNSUPPORTED_RUNTIMES`
  (zed), sentinel `ctx-agent-hooks`, walker `managedGroupsFor` /
  `hasRunnableGuard` / `hasStalePreToolUseMatcher` / `describeExistingGuard`,
  `mergeIntoHookArray` with legacy-array -> `unmigratedHooks` migration,
  `refusalAction` / `allowAction` (also used by `src/commands/security.ts`),
  hook-side payload parsers used by `keryx ctx hook` (`src/ctx/hook.ts`).
- `src/ctx/orient-runtimes.ts` — `OrientRuntime`, `ORIENT_RUNTIMES` (claude,
  codex, cursor), `UNSUPPORTED_ORIENT` (windsurf, zed, opencode, antigravity),
  sentinel `ctx-orient-hooks`, its own lenient `hasManaged` walker.
- `src/security/agent-hooks/runtimes.ts` — `RuntimeHook`, `RUNTIME_HOOKS`
  (claude event-keyed; cursor, windsurf, generic-mcp flat under
  `securityHooks`), sentinel `security-agent-hooks`, `dropLegacyEntries`,
  `.some`-over-managed validator (hostile-entry fix).

### Installers (three read/write loops today)

- `src/ctx/hook-install.ts` (`installRuntimeHook` / `uninstallRuntimeHook`) ←
  `src/commands/ctx.ts` `handleInstallHook` / `handleUninstallHook`.
- `src/security/agent-hooks.ts` (`installRuntimeHooks` / `uninstallRuntimeHooks`,
  `installSecurityAgentHooks` for init/update) ← `src/commands/security.ts`
  `handleHooks`, `src/commands/init.ts`, `src/commands/update.ts`.
- `src/commands/orient.ts` (`installOne` / `uninstallOne`, private).

### Settings files and the surfaces targeting them

| file | surfaces |
|---|---|
| `.claude/settings.json` | ctx-guard (PreToolUse), orient (UserPromptSubmit), security check-input (UserPromptSubmit), security check-output (PreToolUse Write\|Edit) |
| `.codex/hooks.json` | ctx-guard (PreToolUse), orient (UserPromptSubmit) |
| `.cursor/hooks.json` | ctx-guard (hooks.beforeShellExecution), orient (hooks.sessionStart), security (securityHooks[]) |
| `.windsurf/hooks.json` | ctx-guard (hooks.pre_run_command), security (securityHooks[]) |
| `.agents/hooks.json` | ctx-guard (keryx-ctx-guard.PreToolUse) |
| `.opencode/plugin/keryx-ctx-guard.js` | ctx-guard (JS plugin, non-JSON) |
| `.mcp/security-hooks.json` | security (securityHooks[]) |

### Constraints found

- `src/lib/import-zones.ts` `ZONE_TABLE`: a new top-level `src/` segment must be
  classified or `unclassifiedSegments()` fails; `integrations` -> core.
- `import-policy.live.test.ts` ratchets `client-imports-core-internal`; keep
  commands importing the existing modules (no new adapter->core edges).
- Tests pin `_keryxManaged` exact arrays (hook-install.test.ts lines 66-142,
  orient-runtimes.test.ts 59-100, agent-hooks.test.ts 53/112): sentinel order
  and "pre-existing sentinel without entries is left alone" must be preserved.
- Memory: installed `keryx` on PATH is stale — use `bun ./src/cli.ts` for the
  code under change. gdgraph/gdctx answers on this repo are known unreliable
  (user memory), so impacted files were enumerated with `keryx ctx rg` import
  searches rather than `gdgraph affected`.
