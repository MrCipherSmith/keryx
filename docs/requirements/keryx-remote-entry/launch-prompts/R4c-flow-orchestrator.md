# Launch prompt — R4c turn submission, streaming, and the non-weakening profile
Version: 0.1.0

Copy the fenced block into a flow-orchestrator session. One flow, no phases.

**Prerequisite:** R4b merged (PR #216, squashed to `05a9a8e3`). R4c is the first
slice that can cause agent execution from outside the operator's terminal.

---

```text
Run flow-orchestrator for ONE slice: R4c of keryx-remote-entry — put something
behind the door that R4b opened. Turn submission, streaming, and the
non-weakening remote policy profile check.

## Metaproject hard gate
Project root: the keryx worktree, on a clean dedicated branch off main.
Read `<project-root>/.metaproject/index.md` before any repo action.
Never edit flow.json or frozen acceptance criteria by hand. All flow state goes
through the `keryx flow …` CLI. (`keryx` is on PATH; `bun ./src/cli.ts …` is the
in-repo fallback.)

## Standing operator rule
When green: commit, push, open a DRAFT PR. Then stop. Do not start R4d.
No AI attribution anywhere — no Co-Authored-By, no "Generated with", in commits,
PR bodies, issues or comments.

## Governing requirements — read in full before planning
docs/requirements/keryx-remote-entry/: README.md, specification.md,
api-protocol.md, security-policy.md, and the schemas turn-request,
turn-result and stream-event. The package specifies the WHOLE surface (29 ACs);
this slice implements a named subset and must not drift into the rest.

Load-bearing clauses for this slice:
- security-policy.md §"Required decision path" — the nine ordered steps. The
  order is the control; implementing them in a different order is a finding.
- security-policy.md §"Remote policy profile" — non-weakening is a STARTUP
  refusal, "not a warning and not a downgrade". Stricter default absent
  configuration: sandbox required, network off or restricted, every mutation
  classified `ask`.
- specification.md §"Session addressing" — identity-first, exact-match on the
  declared project path. Never infer from recency, arrival order, or the fact
  that only one session is idle. helyx shipped timing-based pairing first and
  had to replace it after transports cross-linked between projects.
- api-protocol.md §"POST /v1/turns" — the status table, and "An accepted turn is
  not a permitted turn."
- api-protocol.md §"GET /v1/turns/{turnId}/events" — re-attachment via
  Last-Event-ID replays from the durable evidence record and NEVER re-executes.
- api-protocol.md §"Bounds" — body size enforced before parsing semantics.

## What R4b already built (do not rebuild, do not fork)
| File | What it owns |
|---|---|
| src/lib/serve-server.ts | The listener, the route table (exact-match, closed enumeration), authentication BEFORE routing, the fixed 401, the 404/405 bodies, drain. |
| src/lib/serve-credential.ts | Salted-hash credential store, constant-time compare, per-request `resolveCredential()`, fail-closed on a group- or other-readable store. |
| src/lib/serve-config.ts | Whitelist projection of the config schema; `serveConfigState` = absent/valid/malformed/unreadable. |
| src/lib/config-dir.ts | `ensureKeryxConfigDir` — 0700 on the directory, called by EVERY writer of the shared user-global directory. |
| src/commands/serve.ts | The CLI: `serve`, `serve status`, `serve config init|set|show`, `serve token issue|rotate|revoke`. Every printed instruction is executed by a test. |
| src/lib/project-registry.ts | R4a. `listProjects()` / `emitProjectsJson()` back GET /v1/projects. |

Harness seams to invoke, unchanged:
- src/harness/run/run.ts — `runOffline(...)`, `RunDeps`, `RunResult`.
- src/harness/session/session.ts — `AppendOnlySession`, `resumeSession(...)`.
- src/commands/harness.ts:202 `shellAllowProfile()` and :245 `readOnlyProfile()`
  — the ONLY local profiles that exist, built inline per command. There is no
  `resolveLocalProfile`. Creating one is part of this slice (see D1).

## Decisions to take in the flow (record them in description.md)

D1 — extract a single local-profile resolver.
AC-04 compares the remote profile against the local one, and there is nothing
to compare against today. Extract the inline profiles into one resolver with a
declared shape, and repoint both call sites in src/commands/harness.ts, rather
than adding a third inline profile for serve. This is the R4b `configDir()`
precedent: the third copy is the one that must not be written.

D2 — comparison is structural, not a string or name match.
"Not weaker than local" must be decided over the resolved profile's fields
(sandbox requirement, network posture, mutation classification, allowlist
membership), with an UNKNOWN field failing closed. A profile-name comparison is
the `allowlist-not-a-boundary` lesson repeating: a check matched against a raw
string is not a security boundary.

D3 — `ask` resolves to deny in this slice, explicitly.
Approvals are R4d. A turn that raises `ask` must terminate in a recorded denial
here, and the denial must be visible in the turn result and the event stream.
It must NOT block, must not silently allow, and must not leave a turn hanging
until a timeout that does not exist yet. Write this in the source as a stated
R4d boundary, not as an accident of there being no approval store.

D4 — the first mutating route pays R4b's deferred debt.
R4b deferred authentication-failure throttling with the reason "on two read-only
routes behind a loopback socket there is nothing to enumerate and no state to
change". POST /v1/turns changes state. Throttling lands in this slice, and it
must never throttle an already-authenticated in-flight turn.

## Deliver

1. Local-profile resolver + non-weakening check (AC-04), enforced at STARTUP:
   a widening resolution enters `refused` and binds no socket. Add it as a new
   `ServeRefusalReason` member, and extend the existing refusal test — that
   suite already enumerates every refusal state, runs the command, extracts the
   instruction it prints, and EXECUTES it requiring exit 0. The new member must
   satisfy that suite, not sit beside it.
2. POST /v1/turns: body size and content-type bound before parsing semantics;
   server-stamped origin (a body claiming `origin: local-tty` is ignored —
   AC-05); identity-first session resolve or create (AC-11); the prompt through
   src/security as untrusted content, rejecting with 422 that says only that it
   was rejected; idempotencyKey returning the original turnId and starting
   nothing; 202/400/401/409/413/422/503 per the protocol table.
3. GET /v1/turns/{turnId} — terminal result per turn-result.schema.json,
   durable across restart.
4. GET /v1/turns/{turnId}/events — SSE per stream-event.schema.json, monotonic
   `seq`, bounded structured tool summaries and never raw stdout, raw arguments
   or raw provider payloads. Last-Event-ID replays from the durable record and
   re-executes nothing.
5. Containment (AC-12): when the profile requires the sandbox and the launcher
   is unavailable, the turn is refused. Never downgraded to an uncontained run.
6. Redaction (AC-13) on every stream event, turn result and error body.
7. Auth-failure throttling (D4), never applied to an authenticated in-flight
   turn.
8. The offline fake transport specification.md §Testability requires, for the
   subset this slice covers: authenticated and unauthenticated submission,
   session create and resume, a turn that raises `ask` (terminating in denial
   here), a mid-turn restart, a detach and re-attach, and secret-bearing tool
   output.

## Frozen acceptance criteria — propose these, freeze after review
AC1  A widening remote profile is a startup refusal that binds no socket, and
     the instruction that refusal prints, when executed verbatim, exits 0.
AC2  Parity (spec AC-03): the same prompt over HTTP and through the existing
     harness CLI path produces identical policy decisions and evidence shape,
     differing only in recorded origin.
AC3  Origin is unforgeable (spec AC-05): a body claiming a local origin is
     recorded with the server-assigned remote origin.
AC4  Identity-first binding (spec AC-11): two concurrent sessions for different
     projects, a declared path resolves to its own session regardless of arrival
     order or idleness; an unknown project fails rather than falling back.
AC5  An `ask` terminates in a recorded denial, visible in both the turn result
     and the stream, with nothing executed and nothing left pending.
AC6  Containment required and launcher unavailable: the turn is refused, never
     run uncontained.
AC7  A repeated idempotencyKey returns the original turnId and starts no second
     turn, across a process restart.
AC8  Re-attachment with Last-Event-ID replays the missed events from the durable
     record and executes nothing; asserted by driving a real turn, killing the
     stream mid-flight and reattaching.
AC9  Redaction: token-like strings, absolute paths and PII fixtures in tool
     output appear in no stream event, no turn result and no error body — with a
     positive control first proving the surrounding fields DO reach the caller,
     so the absence is meaningful.
AC10 Task Manager stays read-only (spec AC-14) and the append-only session store
     stays the single writer (spec AC-15): a full recursive inventory of the
     fixture project (path -> size:mtime) is unchanged by every route, with a
     flow.json pinned as present so the inventory cannot be empty.
AC11 Repeated authentication failures from one peer are throttled; an
     authenticated in-flight turn is never throttled.
AC12 Gates: `bunx tsc --noEmit` clean, full `bun test` green, `keryx health run`
     PASS, and the command-registry coverage guard still green.

## Working rules — these are why R4b took three review rounds
- Write the failing test FIRST and confirm it fails for the stated reason.
- MAKE THE GUARD THE CLASS, not the site. R4b's rounds 1 and 2 each fixed the
  one call site a finding named and left its four siblings broken. The two
  guards that worked are the model: config-dir.permissions.test.ts drives every
  writer under umask 002; serve.recovery.test.ts enumerates every refusal state
  and executes the instruction it prints. Neither can pass while a sibling is
  broken. Every new guard in this slice must have that shape.
- Mutation-check every guard: remove or invert it, confirm the suite goes red
  for the right reason, restore. Record the table in the journal. A guard never
  observed failing is decorative. Where a mutation does NOT go red, either add
  the missing test or document the control as untested — never claim it.
- Never let a comment describe enforcement no code performs.
- A fix round is new code and deserves its own review round.

## Host and test constraints (do not relearn these)
- ripgrep is NOT installed on this host; `keryx ctx rg` exits 127. Use grep with
  `# keryx:raw ripgrep not installed on this host` appended, which the gdctx
  PreToolUse hook requires. The same hook rejects raw head/tail/sed/cat/find in
  pipelines.
- No test may bind a fixed port. Bind port 0 and read the assigned port back.
- Never read an exit code through a pipe. `process.exitCode = undefined` does
  not reset in Bun; read exit codes from a real subprocess via `proc.exited`.
- `bun test` runs files sequentially in ONE process, so command-level suites
  must restore console.*, XDG_DATA_HOME, APPDATA and process.exitCode.
- bunfig.toml `[test].preload` redirects the user-global config dir. Confirm at
  the end that the real ~/.local/share/keryx is unchanged by the suite.

## Out of scope — with reasons
- Pending approvals, GET /v1/approvals, POST /v1/approvals/{id}. R4d. `ask`
  denies here (D3).
- POST /v1/turns/{turnId}/cancel. Drain already reaches a terminal state on
  SIGINT/SIGTERM and the TUI stays canonical for emergency shutdown; cancel
  lands with approvals, which is where a long-lived pending turn first becomes
  reachable.
- GET /v1/commands, POST /v1/maintenance (R4e); POST /v1/credential-links
  (R4f); GET /v1/flows.
- GET /health and cross-process liveness. Still deferred: there is no PID file
  and no supervisor, so a separate CLI process cannot honestly report
  `listening`. `keryx serve status` continues to report configuration state.
- TLS, a public listener, any non-loopback default. Non-loopback stays
  refused-unless-acknowledged, unchanged from R4b.
- Any change to the harness run loop, the policy engine or the session store
  beyond the profile-resolver extraction in D1. Remote Entry invokes them; it
  does not reclassify, and no HTTP type may appear in a harness domain contract.

## Flow lifecycle
1. keryx flow init --title "R4c: remote turn submission, streaming, and the
   non-weakening remote policy profile"
2. Propose AC1..AC12, freeze after review, start, execute.
3. Verify: tsc, full bun test, keryx health run, and the mutation table.
4. Completion A (draft PR).

## Done report
flow id, files touched, the mutation table with what went red for each entry,
gate output, draft PR URL, residual risks, and an explicit statement of which
of the package's 29 acceptance criteria this slice closed and which it did not.
```
