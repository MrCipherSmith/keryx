# Context

Collected deterministically by `keryx flow init` at 2026-08-01T09:32:04.020Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`
- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`
- [draft/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-08-01T09:19:51.796Z)
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

## Agent Findings

### Governing requirements

`docs/requirements/keryx-remote-entry/` v1.1.0. Read in full for this flow:
`README.md`, `specification.md`, `api-protocol.md`, `security-policy.md`,
`schemas/remote-entry-config.schema.json`. The package specifies the *whole*
remote surface (29 acceptance criteria); this flow implements only the skeleton.

Load-bearing clauses:

- `specification.md` §"Process and state machine" — `refused` is a terminal
  startup outcome, "The listener does not open… never a degraded listen".
- `specification.md` §"Configuration and credentials" — the bearer token lives
  only in the user-global credential store, referenced by opaque id; a raw token
  is forbidden in configuration, repository files, `.metaproject` artifacts,
  prompts, trace output, telemetry, fixtures, schemas and notification text.
- `security-policy.md` §"Authentication and token handling" — constant-time
  comparison, a fixed 401 body with no distinction between missing / malformed /
  wrong, `serve status` never prints the token.
- `security-policy.md` §"Network exposure" — loopback default; non-loopback needs
  an explicit flag **and** a configuration acknowledgement; either alone is a
  startup `refused`.
- `api-protocol.md` §"Principles" — "Silent to strangers": an unauthenticated
  caller learns nothing about which sessions, projects or turns exist.

### Code this slice builds on (R4a, flow 127, PR #215)

| File | What this flow uses |
|---|---|
| `src/lib/project-registry.ts` | `listProjects()` and `emitProjectsJson()` back `GET /v1/projects` verbatim. `sanitizeForDisplay()` guards every filesystem-derived string that reaches a terminal. A private `configDir()` lives here (extracted by this flow). |
| `src/lib/shell-config.ts` | `configDir()` — the second byte-identical copy, and the canonical documentation of the cross-platform rule (`%APPDATA%\keryx`, `$XDG_DATA_HOME/keryx`, `~/.local/share/keryx`). Holds `auth.json` at 0600. |
| `src/commands/projects.ts` | The command-layer shape this flow mirrors: `--help` resolved against the whole argv before any branch; a closed set of known flags; unknown flags rejected with a sanitized echo and exit 1. |
| `src/commands/projects.escape.test.ts` | The only formulation that actually catches an unsanitized call site: drive the COMMAND with stdout+stderr captured and assert the combined output carries no control characters. Reused for `keryx serve`. |
| `src/cli.ts` `CLI_ROUTES` | The dispatch table the coverage guard derives its denominator from. A new verb fails `command-registry.coverage.test.ts` until described or excluded with a reason. |
| `src/standard/command-registry.coverage.test.ts` | `EXCLUSIONS` — the precedent entries for `shell` ("interactive TUI; owns the terminal and returns no value") and `harness` ("executes arbitrary subprocesses…; gated by policy, never by a descriptor"). |

### Lessons applied (from `.metaproject/memory/lessons/`)

`a-fix-round-needs-its-own-review-…` (flow 127, PR #215, seven review rounds,
three consecutive fix rounds each shipping a new blocker). Its three root causes
are this flow's working rules:

1. The fix was not tested, only written → **write the failing test first and
   confirm it fails for the stated reason.**
2. The fix was applied where the finding pointed, not everywhere the class lived
   → **when a finding names one call site, grep the class.**
3. A comment asserted a control that did not exist → **never let a comment
   describe enforcement no code performs.**

Plus: **mutation-check every guard** (remove or invert it, confirm the suite goes
red, restore). This caught flow 087's coverage guard comparing two copies of one
belief and flow 127's tautological concurrency test.

`allowlist-not-a-boundary` — a check matched against a raw string is not a
security boundary. Applied here to the route table: authentication runs before
routing, and the route set is an exact-match closed enumeration, not a prefix or
pattern match.

### Host constraint

ripgrep is not installed on this host; `keryx ctx rg` exits 127. Searches in this
flow used `grep` with the `# keryx:raw ripgrep not installed on this host`
escape marker required by the gdctx PreToolUse hook.

### Testing constraints

- **No test may bind a fixed port** — every test binds `port: 0` and reads back
  the assigned port. The original reason given for this ("the suite runs
  concurrently") was measured during review and found false: `bun test` v1.3.11
  runs every file sequentially in ONE process. The rule stands on the true
  reasons — a fixed port collides with whatever else is on the developer's
  machine and with a second CI job on the same runner, and the failure it
  produces is an unrelated EADDRINUSE. The single shared process is separately
  why the command-level suites must restore `console.*`, `XDG_DATA_HOME`,
  `APPDATA` and `process.exitCode`.
- `process.exitCode = undefined` does not reset in Bun. Exit codes are read from
  a real subprocess (`Bun.spawn` → `proc.exited`), never through a pipe.
- The user-global config dir is redirected per test: library functions take an
  explicit `dir` override (the R4a pattern); command-level tests set
  `XDG_DATA_HOME` and restore it in `afterEach` (the `projects.escape.test.ts`
  pattern); subprocess tests pass both `XDG_DATA_HOME` and `APPDATA`.
