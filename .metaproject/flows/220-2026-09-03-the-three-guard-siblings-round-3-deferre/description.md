# the three guard siblings round 3 deferred

Status: formalized
Source: round-3 review of PR #431, findings F-104, F-109, F-302

## Problem

PR #431 closed the gdctx routing guard's main defect and three siblings. Round 3
found three more, each reproduced by a reviewer and each dismissed as
`dismissed-deprioritised` with a recorded decision rather than silently. They are
recorded in the ingested round-3 package under flows 216 and 218 in main.

### 1. `ctx hook`'s own stdin read is unbounded (F-104, major)

`src/ctx/hook.ts` reads stdin with `for await (const chunk of process.stdin)` and
no deadline. PR #431 bounded the SAME read in `keryx orient` and argued, in that
fix's own comment, that "a hook that never exits hangs the harness just as surely
as one that never writes". `hook.ts` was edited in the same commit range — the
`emit()` refactor — and its read was left.

Measured with one fifo harness: `orient claude` exits in 1202 ms; `ctx hook
claude` was still running at 14 s, and a first attempt ran past 120 s. Control
with a closed stdin: 665 ms.

This is the more serious of the three. `ctx hook` is a `PreToolUse` gate: a stdin
that is not promptly closed wedges the tool call rather than failing open, which
is the opposite of the module's stated contract.

### 2. `ANTIGRAVITY_RUNTIME.validate` is a second walker (F-109, major)

PR #431 added a `type === "command"` ownership test to `managedGroupsFor`,
because a harness executes only `type: "command"` entries and a group saying
`prompt` is installed and inert. `ANTIGRAVITY_RUNTIME.validate` is a separate
hand-rolled walker that still matches on `command` alone, so it returns `[]` for
an inert entry and for an absent matcher.

The comment on `managedGroupsFor` predicts this literally — "when a fourth
settings shape arrives, one copy gets updated and the other keeps reporting the
install clean" — and the fourth shape was already in the file when that comment
was written.

Separately: `managedGroupsFor`'s flat ownership branch (`entry.command ===
command`, for cursor/windsurf) carries no `type` requirement and is applied to
EVERY runtime, so a flat-shaped group validates clean for claude, which only
executes nested groups.

### 3. The escape marker ignores quoting (F-302, info)

`ESCAPE_MARKER` is matched against the raw command string before any
tokenization, so a command that merely CONTAINS `# keryx:raw` inside a quoted
argument opts itself out: `grep -rn '#keryx:raw' src/` and
`git log --grep='# keryx:raw'` both pass.

The asymmetry is the tell: PR #431 taught `splitPipeline` that a `|` inside
quotes is not a pipe, and left the escape regex quote-blind in the same file.

## Expected Outcome

- `ctx hook` cannot hang: an unclosed stdin yields the fail-open no-payload path
  within a bounded time, and the process exits. Bounding the read is not enough
  on its own — PR #431 established that an abandoned read keeps the event loop
  alive, so the reader has to be released.
- Ownership of a managed hook group is decided in ONE place, for every runtime,
  and whether a runtime's groups are flat or nested is a per-runtime fact rather
  than "either shape counts for everyone".
- The escape marker is recognised only where a shell would treat it as a comment.
- Each is pinned by a test that fails when the fix is reverted. Round 3's lesson
  is explicit about why: across three rounds, the guard and the prose describing
  the regression it prevents both shipped, and the assertion did not.

## Out of Scope

- The `sh -c` / `$(…)` / `eval` / `xargs` ceiling. Structural, documented in the
  `readsStdin` docblock, and named in `allowlist-not-a-boundary.md`. A larger
  parser does not reach it.
- Teaching the routing audit to distinguish classified-and-allowed from
  could-not-classify. That is the honest next step for the guard and it is a
  design change to the audit, not a fix to these three.
- Routing. That is flow 217.
