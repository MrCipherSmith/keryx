# Context

Collected deterministically by `keryx flow init` at 2026-11-24T20:53:09.112Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.993] A shell allowlist matched against the raw command string is not a security boundary (lesson/accepted) - lessons/allowlist-not-a-boundary.md
   A remembered glob pattern that is matched against a command string which is then handed to `/bin/sh -c` grants far more than it appears to. The pattern matches text; the shell re-interprets that text. Verified, not theorised: a live allowlist contained `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`, `sudo *`, and the exact string `rm -rf /` — each an arbitrary-execution grant that auto-approved with no prompt.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:src/lib, src/commands, src/tui, entity:shell-permissions, command-risk, approval gate
   provenance: source=flow 115 (shell approval hardening), stress reports in `.metaproject/data/stress/` link=docs/decisions/keryx-harness/ADR-0009-destructive-command-escalation.md author=unknown confirmedBy=unknown
2. [1.912] gdctx-stem-classifier-misreads-stdout (known-mistake/accepted) - known-mistakes/gdctx-stem-classifier-misreads-stdout.md
   A keyword-stem classifier applied to raw stdout regardless of exit code turns ordinary English ("refuse," "cannot," "crash") into a false tool-failure signal. Gate stem-matching on stderr or a non-zero exit code, not on the words alone.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, classification, output-analysis, entity:classifyLine, importantLines, compactLines, FAILURE_STEMS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-1) author=unknown confirmedBy=Reproduced this session via `keryx ctx run -- printf 'refuse this\n'`
3. [1.912] keryx-gdctx-gdgraph-routing-index-cost-not-measured-before-shipping (known-mistake/accepted) - known-mistakes/keryx-gdctx-routing-index-cost-not-measured-before-shipping.md
   A mandatory context-injection rule's per-read cost multiplies by every subsequent turn and every subagent dispatch. Measure the re-billed cost across a realistic turn count and subagent fan-out before setting a rule's default scope, not just its one-time size.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:context, orchestration, keryx-cli, subagent-dispatch, entity:hard-gate rule, transcript re-sending, subagent-context-assembly, orient-runtime
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-5) and docs/requirements/keryx-context-measurement/context-loading.md author=unknown confirmedBy=Measured in context-loading.md: 41,556→42,133 tokens across 4 turns with full index re-billing
4. [1.821] gdctx-flag-allowlist-no-bundle-expansion (known-mistake/accepted) - known-mistakes/gdctx-flag-allowlist-no-bundle-expansion.md
   A per-flag string allowlist that doesn't expand POSIX-bundled short flags rejects the idiomatic form of a tool's own CLI habits (`-il` vs `-i -l`); expand-then-check, not check-then-reject, for any allowlisted boolean-flag set.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, ripgrep, flag-parsing, entity:buildRgCommand, RG_SAFE_FLAGS, RG_SAFE_VALUE_FLAGS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-3) author=unknown confirmedBy=Reproduced this session via `keryx ctx rg -il "todo" src`
5. [1.749] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`

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

Collected by the orchestrator on 2026-11-25 (worktree `/Users/Goodea/goodea/keryx-wt/main-2026-11-25`,
branch `wt/main-2026-11-25`, cut from `origin/main` at `e423dbf9a`). The graph was not built in this
worktree yet; pointers below come from `keryx ctx rg` and direct reads.

### Where Run lives today (desktop web view)

- Two Run buttons, one sink:
  - shell code blocks in a message: `apps/desktop/src/components/Markdown.tsx:101` and `:182`
    (`isShellLang` + `runnableCommand`);
  - executed `execute` tool cards: `apps/desktop/src/session/Transcript.tsx:140-150`
    (`runnableToolCommand`) and the button at `:200-204`.
  - Both call `runInTerminal(command)` in `apps/desktop/src/panels/panelBus.ts:12-27`, which carries
    only the command string — no session id, no run id.
- `apps/desktop/src/panels/TerminalPanel.tsx:81-96` writes `${command}\r` into the active running tab
  (or a new shell tab). Fire and forget: no completion, no exit code, nothing back to the session.
- Host wrappers: `apps/desktop/src/platform/panels.ts` — `ptyOpen`, `ptyOpenRun(cwd, argv, title, …)`
  (a tab whose process is argv itself), `onPtyExit` (`panel://pty-exit {id, code}`, delivered whether
  or not the tab is on screen), `ptyAttach`, `ptyWrite`, `ptyClose`.
- Analog to copy: `/delegate` terminal runs — `apps/desktop/src/session/delegateTerminals.ts` maps a run
  tab's exit to a state (exit 0 → done, N → failed "exit N", signal, "closed" when the tab closed while
  running). Spec: `docs/requirements/keryx-desktop-client/specification.md` §4.4 (line ~704, D-13) and
  §3.9.5a (line ~403, D-14).

### Host (Tauri, Rust)

- `apps/desktop/src-tauri/src/pty.rs`: ring buffer, `mark()` (:224), `has_exited()` (:232),
  `wait_settled` (:238), `plain_text` (:123, strips escapes, applies CR), the user's shell from the
  login environment, `/bin/zsh` otherwise (~:377), program spawn for `pty_open_run` (~:358).
- `apps/desktop/src-tauri/src/panels.rs`: `open_tab` (:57) and the run-tab opener (~:95) that emits
  `panel://pty-exit`.
- `apps/desktop/src-tauri/src/panel_mcp.rs:321-366`: the agent's own `terminal_run` / `terminal_read`
  tools (agent tabs only, wait for quiet output, no exit code) and `tail_lines`. Not changed by this flow.

### keryx ACP server (shell profile)

- The desktop advertises `initialize.clientCapabilities._meta.keryx.terminal: true` in the app
  (`apps/desktop/src/session/useAcpSession.ts:644`); server side `clientRunsTerminal`
  (`src/acp/shell-delegate.ts:59`).
- `/delegate` result path to copy: `src/acp/server.ts:2269-2313` (`handOffDelegateResult`,
  `appendDelegateNotes`: user-role note, `provenance: "harness"`, `injected: true`, persisted, queued in
  `pendingDelegateNotes` while a turn runs and flushed at turn end `:2803-2807`), note format
  `src/acp/delegate-turn-hook.ts:295-329` (`delegateResultNote` with a nonce envelope, `redactSensitiveText`,
  `capResultText`; `parseDelegateNote` for replay). That path deliberately starts **no** turn — this
  flow's result must start one.
- Extension table and per-profile list: `src/acp/profile.ts:32-141` (`KERYX_ACP_EXTENSION_METHODS`,
  `acpProfileExtensions`).
- The client starts turns: `apps/desktop/src/session/commandRunner.ts:38-39,147` (`startTurn` effect) and
  `useAcpSession.ts:919` (`startTurn: (target, t) => sendPrompt(t, target)`). The server refuses a second
  prompt while a turn runs (busy guard), so waiting for idle is the client's job.
- Replay of a stored note as a card: `apps/desktop/src/session/reducer.ts:287-289` (`_meta.keryx.delegateResult`
  on a replayed user chunk) and `:514-515`, `:636`.
- System instruction: `src/commands/agent.ts:2004` `buildAgentSystemInstruction(orient, ctx)`, called from
  `src/acp/server.ts:2569` with `{providerId, modelId, toolNames}`; sentences are gated with `offered(name)`.
  MCP server `instructions` (the panel's) do **not** reach the model — guidance must go here.
- Untrusted-content floor: `src/acp/session-mcp.ts:69-99,249-258` (first-party panel tools exempt except
  `floorTools`), `src/commands/agent.ts:153-155,246,305` (the floor suspends auto-approval grants).

### Lessons and constraints from memory

- `desktop-client-m2a`: installing a new desktop build needs the owner's OK to quit the running Keryx;
  local-only test noise — `searchable-sources` (scans `src-tauri/target`), a flaky `shellenv` Rust test
  under load, `GIT_TEMPLATE_DIR=/var/empty` breaking git-hook tests.
- `keryx-tooling-caveats`: run flow/review/skills commands as `bun ./src/cli.ts …` in a worktree.
- `desktop-merge-now-release-later`: desktop fixes merge to main on green CI; release only on the owner's ask.
- `git-concurrency.mdc`: no `git stash`, explicit pathspecs, `git -C <worktree>`.

### Owner decisions (2026-11-25, question tool)

1. Run opens its **own tab** per command (not shell integration in an existing tab).
2. When the command ends, the **agent continues on its own** (a follow-up turn), not a note only.
3. Driven through `flow-orchestrator`.
