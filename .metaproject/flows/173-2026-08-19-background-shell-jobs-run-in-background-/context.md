# Context

Collected deterministically by `keryx flow init` at 2026-08-19T08:04:19.248Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`
- [accepted/lesson] OpenTUI: alignSelf on a transcript box collapses its intrinsic height - `.metaproject/memory/lessons/tui-alignself-height-collapse.md`
- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`
- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`
- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`

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

### Prior art (research fork, WebSearch/WebFetch, ~1200-word report — full text in this
conversation's transcript, not re-pasted here)

- **Claude Code**: `run_in_background:true` on Bash + `BashOutput(shell_id)`
  (incremental new-output-only, not full dump) + `KillShell(shell_id)`. Same
  approval gate as any Bash call. Auto-kills all jobs on session exit. 5GB
  output cap auto-kills a runaway job. **Open, currently-unfixed bug**
  (issues #11190/#11716/#13249): the harness injects a "job still running"
  reminder into every turn while a job is tracked, and lifecycle-state
  tracking is broken enough that finished/killed jobs keep generating
  reminders indefinitely (reports of 50+ wasted responses). This is the
  reason this flow does NOT copy the recurring-reminder mechanism — see
  `description.md`'s "Resolved design tension".
- **Codex CLI**: `exec_command` + `session_id`; output only visible via
  explicit `write_stdin` poll, no push (`wake_on_output` is an open,
  unshipped proposal — issue #32188/#29865). Sandboxed `pgrep` fails, so
  Codex often cannot see/kill its own background children (#8656) — a
  process-VISIBILITY bug, same root cause class as the next one.
- **opencode**: no built-in backgrounding; real open hangs from a background
  child inheriting stdout/stderr FDs so the parent tool call never returns
  (#20902, #22012, #29294) — a process-OWNERSHIP bug (losing track of the
  process group, not just the direct PID). This is exactly why this flow
  requires kill-by-process-group as a hard requirement, not a nice-to-have.
- **Gemini CLI**: `is_background:true`/trailing `&` → returns immediately
  with a PID and nothing else; no poll/kill tool, fire-and-forget, model
  must self-manage the PID via a later `kill <pid>` call. Weakest API shape
  surveyed — ruled out during the discussion in favor of Claude-Code-style
  companion tools.
- **aider**: no backgrounding; foreground/synchronous only.
- **Cline** (VS Code extension): removed foreground terminal mode entirely
  in v3.80 — every command runs as background exec via a plain
  `child_process`, specifically to kill a class of zombie-process bugs the
  old shell-integration mode had. Reacts to new output as an event, not
  poll-on-demand.
- **Job-control prior art** (tmux/screen, `&`/`jobs`/`fg`/`kill %1`,
  `systemd-run --user` + `journalctl -f`, supervisord): the four-verb
  primitive (start-detached / list / attach-or-tail / kill) this flow's
  `shell_exec(background)` + `shell_job_output` + `shell_job_kill` maps onto.

### Existing keryx architecture this flow reuses (read directly from source,
this worktree, before writing the plan)

- `src/harness/tool/builtin/shell-exec-tool.ts` — `CommandRunner`,
  `Bun.spawn`, incremental pipe reads (`readInto`), SIGTERM→SIGKILL deadline
  pattern, sandbox wrapping (`wrapWithSandbox`/`detectSandboxLauncher`),
  `MAX_OUTPUT_BYTES = 20_000`. The background runner is an ADDITIVE sibling
  path in this file/module, not a rewrite.
- `src/commands/agent.ts` — `risk: "read"` vs `"shell"` tool-call budget
  split (small non-read pool vs large read pool); `shell_job_output`/
  `shell_job_kill` must be classified `read` so polling doesn't eat the
  scarce non-read budget.
- `src/tui/subagent-bridge.ts` / `subagent-session.ts` /
  `subagent-inspector.ts` (flow 162) — the exact structural template for the
  new job-bridge/job-session/job-inspector trio; see `description.md` for
  the file-for-file mapping. `subagent-inspector.test.ts`'s
  "paintSubagentSidebar rows fire onOpen on mouse down" is the existing test
  pattern to mirror for the new sidebar rows.
- `.metaproject/memory/lessons/allowlist-not-a-boundary.md` (surfaced by
  `flow init`): a remembered command-string pattern matched against text
  handed to `/bin/sh -c` is not a real security boundary — relevant because
  the background path must not introduce a NEW pattern-matching shortcut for
  its own approval/allowlist handling; reuse the existing gate as-is.
- `.metaproject/memory/lessons/tui-alignself-height-collapse.md` (surfaced
  by `flow init`): `alignSelf:"flex-start"` on a ScrollBox child collapses
  its intrinsic height in `@opentui/core` — a real trap for the new sidebar
  panel/modal layout; avoid that prop shape when building
  `background-job-inspector.ts`'s scroll box (mirror `subagent-inspector.ts`'s
  existing, already-correct `ScrollBoxRenderable` usage instead of writing a
  new one from scratch).
