# Implementation Plan

Status: ready for freeze

## Approach

Three parts, one branch (`feat/flow-481-herdr-app`, base `main`). The new Herdr gets its
own small, pure modules; the old Herdr TUI reporter and `herdrStateFor` (which also feeds
the agent bus) stay untouched.

### Part 1 — status over OSC 7501

- New `src/tui/herdr-core-status.ts`:
  - `encodeOsc7501(report)` — pure, byte-exact herdr-core wire format (context.md), field
    order `state, kind, progress, app, title, msg`, `title`/`msg` base64 (UTF-8), ST terminator
    `ESC \`. Refuses unknown states.
  - `herdrCoreStateFor(...)` — new mapper: queued→`idle`, running→`working`, done→`done`,
    failed→`error`, approval→`blocked`+`kind=permission`, `ask_user`→`blocked`+`kind=question`,
    exit→`clear`.
  - `createHerdrCoreReporter({ env, write, redact })` — no-op unless `HC_TERMINAL_ID` is a
    non-empty string; dedupes identical consecutive reports; swallows writer errors (status is
    best-effort, never breaks the shell). `msg` = the approval command / external task / question
    body, collapsed to one line, passed through keryx's existing secret redaction, truncated to
    200 chars, then base64.
- Render-safe writer: write through the renderer's `writeOut` when the live renderer has it
  (ordered with native frame output when `useThread` is on), feature-detected with a narrow
  structural guard — not a blanket cast; `process.stdout.write` only when no renderer is live.
  If `writeOut` is absent the writer falls back to `process.stdout.write` and the live smoke
  (T11) is what proves the screen stays intact.
- Wiring in `src/tui/tui-shell.ts`: next to every `herdr.report(...)`/`herdr.release()`; the
  blocked sites pass kind + text (the `detail` string carries neither today). `idle` only after
  the composer is ready — never while a provider/model/resume picker owns the screen, because
  herdr-core templates type their task as soon as the first report arrives.
- `src/commands/shell.ts` debug env list: add `HC_TERMINAL_ID`.
- Readline fallback: out of scope (it never had the old reporter either); journaled.

### Part 2 — Herdr app entry

- New `keryx herdr install | remove | status` (`src/commands/herdr.ts` + registry entries):
  - `programs.json`: merge `programs.keryx = { name: "Keryx", icon: "keryx/keryx.svg", tint: true,
    run: ["keryx", "shell"] }` into `~/.config/herdr-app/programs.json`, preserving every other
    key; write the icon to `~/.config/herdr-app/keryx/keryx.svg` (from
    `vscode-extension/media/keryx.svg`, shipped as a keryx asset).
  - herdr-core template `~/.config/herdr-core/templates/keryx.md` (Part 3).
  - Conventions from `skills sync --global` and `mcp/client-config.ts`: opt-in, never from
    `keryx update`; a target whose home dir (`~/.config/herdr-app`, `~/.config/herdr-core`) is
    missing is skipped with a reason, never created; invalid JSON → refuse, file untouched;
    idempotent; a user-modified keryx entry/template is kept and reported (`--force` to
    overwrite); `--dry-run`; real `--json`; first modification of an existing
    `programs.json` keeps a backup beside it; `remove` deletes only content that still equals
    keryx's own. `HOME`/`XDG_CONFIG_HOME` honoured (tests use a temp HOME).
- Upstream: the guide carries the exact `defaults/programs.json` entry + icon for a PR to
  herdr-app. Sending that PR is outward-facing → operator decision after this flow.

### Part 3 — orchestration through hc

- Child role:
  - template `keryx.md`: `command: keryx shell`, default `ready` (7501), body tells the agent to
    report back with `hc send <parent>` when a parent assigned the task.
  - `keryx shell "<task>"`: one positional, non-flag argument = initial prompt, submitted as the
    first turn once the composer is ready (parity with `claude "…"`, `codex "…"`, which the hc
    manual uses: `hc run --bg --name fix claude "Fix …"`). Two positionals → error.
    `-p/--print` unchanged. Readline fallback must not drop it silently (submit or refuse).
- Agent messages: a submitted message that is exactly one `<hc from="…" [reach="…"]>…</hc>`
  block is shown in the transcript as a message from that agent and reaches the model framed as
  a message from another agent (a child report, or with `reach` a task from the parent plus its
  reply instruction) — not as the user's words. Anything else is unchanged.
- Parent role = instructions, not a new tool: when `HC_TERMINAL_ID` is set, the shell agent's
  system context gets a short herdr-core section (own address, delegate with
  `hc run --bg --name … <agent> "<task>"`, collect with `hc wait --children`/`hc read`,
  report with `hc send`, full manual `hc --skill`), ≤ 1,500 chars because it is re-billed every
  turn (memory: routing-index cost lesson). `hc` runs through `shell_exec` under the normal
  permission mode. With `KERYX_SANDBOX_SHELL` on, the section states that hc cannot reach the
  core from the sandbox; the core socket is never opened inside the sandbox (that would be a
  full sandbox escape: the core runs anything unsandboxed).

### Alternatives considered (rejected)

- Rewire `herdrStateFor` to emit `done`/`error`: breaks the bus schema
  (`PRESENCE_STATUSES`) and `tui-bus.test.ts` → separate mapper instead.
- Bare `process.stdout.write` of the OSC: may land inside a native-thread frame → `writeOut`.
- Dedicated `hc` tool family in the harness (spawn/send/wait/read with approval): more code
  and a second permission surface, while interactive `shell_exec` is unsandboxed by default
  and already approval-gated. Revisit if sandbox-on becomes the default.
- hc-backed `ExternalSpawnPort` so `spawn_subagent` children run as visible hc terminals: the
  external supervisor parses child stdout lines, which a terminal-hosted child does not give →
  separate design, out of scope.
- Add herdr to `keryx integrate`: that command edits project-local MCP configs and `all`
  would start writing into `$HOME` → separate `keryx herdr` command.
- Write an unknown "managed-by" field into `programs.json`: herdr may reject unknown fields
  (`programs.error`) → ownership by content equality instead.

## State × event matrix (herdr-core reporter, `HC_TERMINAL_ID` set)

| state \ event | composer ready | turn starts | approval shown | ask_user shown | turn ok | turn fails | `/new` `/clear` | exit |
|---|---|---|---|---|---|---|---|---|
| starting (pickers) | report `idle` | — | — | — | — | — | — | `clear` |
| idle | — | `working` | — | — | — | — | stays `idle` (deduped) | `clear` |
| working | — | — | `blocked` permission + msg | `blocked` question + msg | `done` | `error` | — | `clear` |
| blocked | — | answered → `working` | next approval → new msg | — | — | — | — | `clear` |
| done / error | — | `working` | — | — | — | — | `idle` | `clear` |

Not set: nothing is ever written (no bytes on stdout).
Interrupt (Ctrl+C mid-turn) ends the turn through the same done/failed path → `done`/`error`.

## Steps (tasks)

1. T5 encoder + mapper + reporter (pure, tests first).
2. T6 TUI wiring + render-safe writer + debug env.
3. T7 `keryx shell "<task>"` initial prompt.
4. T8 `<hc from>` framing + herdr-core section in the agent context.
5. T9 `keryx herdr install|remove|status` + registry + icon asset + template content.
6. T10 docs: guide `docs/docs/guides/herdr.md`, CLI reference, upstream snippet.
7. T11 live verification under an isolated herdr-core session (status sequence, template
   `first_message.sent`, screen integrity).
8. T12 live check in the real Herdr app (keryx in the "+" menu) — writes the operator's real
   `~/.config`, so only with the operator's go-ahead.
9. T4 review (review-orchestrator), then the completion choice.

T6, T7, T8 all touch `src/tui/tui-shell.ts` → sequential. T9 is independent of T6–T8.

## Risks

- `writeOut` is private OpenTUI API: an upgrade may rename it. Mitigation: feature detection
  with fallback, a unit test on the guard, T11 checks the screen.
- Approval text in `msg` leaves keryx (herdr-core stores it, Herdr shows it in toasts):
  redaction + 200-char cap; covered by a failure-scenario test.
- Template typing into the composer: hc pastes the body then submits after `paste_gap_ms`;
  keryx's composer must accept a pasted multi-line message → verified live in T11; if it fails,
  the template sets `submit`/`paste_gap_ms`.
- herdr-core is preview (protocol generation 1, 0.x): wire format verified against hc 0.1.16
  source; the encoder test pins the exact bytes.
