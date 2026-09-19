# Context

Collected deterministically by `keryx flow init` at 2026-09-19T13:06:03.917Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.826] A shell allowlist matched against the raw command string is not a security boundary (lesson/accepted) - lessons/allowlist-not-a-boundary.md
   A remembered glob pattern that is matched against a command string which is then handed to `/bin/sh -c` grants far more than it appears to. The pattern matches text; the shell re-interprets that text. Verified, not theorised: a live allowlist contained `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`, `sudo *`, and the exact string `rm -rf /` — each an arbitrary-execution grant that auto-approved with no prompt.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:src/lib, src/commands, src/tui, entity:shell-permissions, command-risk, approval gate
   provenance: source=flow 115 (shell approval hardening), stress reports in `.metaproject/data/stress/` link=docs/decisions/keryx-harness/ADR-0009-destructive-command-escalation.md author=unknown confirmedBy=unknown
2. [1.792] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
3. [1.735] Flow ids are allocated per clone, not per checkout (constraint/accepted) - constraints/flow-ids-allocated-per-clone.md
   `flow init` reserves its number in the git common directory, so every linked worktree of one clone shares the id space. A number, once handed out, is never reused — not even after the flow directory is deleted or renumbered.
   claimType: constraint | confidence: high | version: 1.0.0
   scope: module:tasks, entity:flow
   provenance: source=flow 116 (fix duplicate flow ids) link=.metaproject/flows/116-2026-07-22-fix-duplicate-flow-ids-nextflowid-races- author=unknown confirmedBy=unknown
4. [1.733] OpenTUI: alignSelf on a transcript box collapses its intrinsic height (lesson/accepted) - lessons/tui-alignself-height-collapse.md
   In a `@opentui/core` ScrollBox column, a child `BoxRenderable` carrying `alignSelf: "flex-start"` stops measuring its intrinsic HEIGHT: it collapses to the viewport height, squeezes its children, and makes the ScrollBox under-report `scrollHeight`. Hug content with `maxWidth` instead.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:tui, entity:transcript-blocks, shell-chrome
   provenance: source=flow 115 link=.metaproject/flows/115-2026-07-21-tui-dim-collapsible-thought-blocks-fix-a author=unknown confirmedBy=unknown
5. [1.665] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review (constraint/accepted) - constraints/stale-installed-keryx-binary.md
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

Source: context-collector dispatch `271-context` (2026-09-19). Status was
`DONE_WITH_CONCERNS`; the concerns are folded into plan.md Risks.

### Spec

- `docs/requirements/keryx-agent-bus/specification.md` §3.1, §6.1, §6.2 and §10
  (AC1, AC2, AC3a, AC20, AC22).
- `decisions.md` D-07 and D-09.
- `schemas/session-lease.schema.json`.

### Store (`src/session/store.ts`)

- `OpenSessionOptions` :64-72.
- `openSession` :888-953. It resolves `-r` at :927, `-c` at :938 and a new
  session at :945.
- `latestSession` :582, `listSessions` :558, `findSession` :586.
- `forkSession` :835 and `exportSessionMarkdown` :956 only read their source.
- `store.callers.test.ts` :33-39 and :103-127 require every `openSession(` call
  to sit inside `try {`.
- `config-dir.{writers,readers}.test.ts` flag any file that names `sessionDir(`
  and also does raw fs writes. `store.ts` is exempt (writers test :124). Keep
  the lease fs I/O in `lib/fs.ts`.
- `store.test.ts` calls `openSession` and then `openSession({continueLast})` in
  the same process and expects the same session back, at five sites
  (:84/100, :113/132, :183/192, :218/228, :242/260). This is why the lease must
  be opt-in.

### fs primitives (`src/lib/fs.ts`)

- All lock helpers are async: `withFileLock` :49, `isLockHeld` :114,
  `removeStaleLock` :129, `readLockOwner` :143, `ownsLock` :154.
- `processIsAlive` :158 (sync, private) and `isAlreadyExistsError` :125 can be
  reused as they are.
- `os.hostname()` is not used anywhere yet.

### Readline (`src/commands/shell.ts`)

- Flags: `-c` :2146, `-r` :2148-2155 (it peeks at the next argument), the
  conflict check :2191, help :2276-2296.
- Sessions are opened at :239-270 (`runShell`) and :1440-1474 (`runAgentRepl`).
  Both `catch` blocks fall back to a new session at :265 and :1466.
- `/new` is at :384 and :1625.
- Bare `-r` falls back to `latestSession` at :2925 and :2952.
- The SIGINT/SIGTERM handler `closeAndExit` (:2702-2718) calls `process.exit`.
- The chat TUI resolves bare `-r` early at :2602-2605.

### TUI (`src/tui/tui-shell.ts`)

- Startup opens: :4141, :4170, :4178, :4188, :4235. The `catch` at :4226 falls
  back to a new session.
- `applyOpened` :4097-4114. The picker is `showComposerChoice` :4149.
- The Session Switcher is `pickSessionInTui` :2687.
- `/resume` goes to `resumeSessionInteractive` :4330-4363. On error it keeps
  the current session.
- `/new` goes to `startNewSession` :4314-4328.
- Exit paths: `/exit` :5423, menu exit :5217, `onDestroy` :2915-2948 (Ctrl+C),
  and the outer `finally` :6197.
- The TUI registers no SIGTERM handler.

### Sessions CLI and docs

- Table in `src/commands/sessions.ts` :39-56, help :169-183. There is no list
  test; `sessions.fork.test.ts` isolates with `KERYX_DATA_DIR`.
- `docs/docs/cli-reference.md`: shell :100-121 (flag table :113-114), sessions
  :125-143.
- `shell` and `sessions` are not in the command registry (coverage test
  :32-34), and no test checks flag coverage.

### Test templates

- `shell-startup-exit.test.ts` :44-46 and `shell-pty-launch.smoke.test.ts`
  :188-191 start subprocesses isolated through `HOME`/`XDG_DATA_HOME`.
- `shell-launch.test.ts` :181-186 injects `launchAgent` and `launchChat`.
