# Context

Collected deterministically by `keryx flow init` at 2026-07-24T00:19:06.965Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`
- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`
- [accepted/lesson] OpenTUI: alignSelf on a transcript box collapses its intrinsic height - `.metaproject/memory/lessons/tui-alignself-height-collapse.md`

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

## Agent Findings

### How herdr detects agents (verified against the live binary + sockets)

herdr recognizes agents two ways:

1. **Screen detection** — regex manifests (`~/.local/state/herdr/agent-detection/
   remote/<agent>.toml`, catalog `https://herdr.dev/agent-detection/index.toml`)
   match terminal regions and infer state. This is how `claude` is detected.
2. **Socket reporting** — the agent connects to the pane's unix socket and pushes
   state. This is how `opencode` works (`~/.config/opencode/plugins/
   herdr-agent-state.js`). More reliable (`screen_detection_skipped: true`).

herdr already ships a **`keryx.toml`** manifest stub (id `keryx`, no rules) — an
empty-rules manifest means "this agent reports via socket". The `keryx` agent id
is whitelisted; no host-side install needed.

### Socket protocol (mirrors the opencode plugin)

- Env gate: `HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_SOCKET_PATH`.
- Newline-delimited JSON over the unix socket.
- `pane.report_agent` → `{ pane_id, source:"herdr:keryx", agent:"keryx", seq, state }`
  with `state ∈ {working|idle|blocked|unknown}`.
- `pane.release_agent` → hands pane authority back on exit.
- Method names verified against the binary strings.

### Live validation done during discovery

- CLI `herdr pane report-agent w2:p1 --source herdr:keryx --agent keryx
  --state working` → herdr agent list showed `w2:p1 keryx working`.
- The reporter module driven over the **real** `HERDR_SOCKET_PATH` produced the
  same result; `release()` returned the pane to `agent=None`.

### Integration point in keryx

`src/tui/tui-shell.ts` → `launchTuiAgentShell` has a single choke-point
`setMainAgent(status, detail)` (status `queued|running|done|failed|blocked`)
through which every lifecycle transition already flows. Mapping:
`running→working`, `blocked→blocked`, `queued|done|failed→idle`. Reporter is
created at function scope (visible to both `setMainAgent` and the `finally`
teardown that calls `release()`).

Style refs: `src/tui/ask-user-bridge.ts` (small singleton module), `node:`
imports throughout, `bun:test` co-located tests (`src/tui/side-worker.test.ts`).
