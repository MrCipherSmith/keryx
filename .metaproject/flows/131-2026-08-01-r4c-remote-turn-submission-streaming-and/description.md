# R4c: remote turn submission, streaming, and the non-weakening remote policy profile

Status: formalized
Source: `docs/requirements/keryx-remote-entry/launch-prompts/R4c-flow-orchestrator.md`

## Problem

R4b (flow 128, PR #216) opened the door and deliberately put nothing behind it:
a loopback listener, bearer authentication, a token lifecycle and two read-only
routes, so the most security-sensitive change in the codebase could land with
its refusal paths proven before anything could execute. Flow 130 then finished
the containment around it.

R4c is the slice that puts something behind the door. It is the first thing in
keryx that can cause agent execution from outside the operator's terminal, and
security-policy.md opens by saying exactly that.

Scope: turn submission, the terminal turn result, the event stream with
re-attachment, and the non-weakening remote policy profile check that R4b
deferred because there was nothing to compare against.

## Expected Outcome

A remote caller can submit a turn and watch it run, under a profile that is
provably no weaker than the operator's own — or the listener refuses to start at
all.

- A widening remote profile is a startup refusal that binds no socket.
- `POST /v1/turns` bounds the body before parsing semantics, stamps origin
  server-side, resolves the session identity-first, scans the prompt as
  untrusted content, and honours an idempotency key across restart.
- `GET /v1/turns/{turnId}` returns a terminal, redacted result, durable across
  restart.
- `GET /v1/turns/{turnId}/events` streams monotonic events and replays from the
  durable record on re-attachment, executing nothing.
- An `ask` terminates in a recorded denial rather than hanging.
- Repeated authentication failures are throttled; an authenticated in-flight
  turn never is.

## Decisions

### D1 — one local-profile resolver, and there were four profiles, not two

Spec AC-04 compares the remote profile against the local one, and nothing
resolved "the local profile" — `commands/harness.ts` built two literals inline,
one per subcommand. Writing a third inside `serve` would have made the
comparison a comparison against a literal nobody else used, and it is the
`config-dir.ts` shape from one flow earlier: the third copy is the one that must
not be written.

The resolver is `src/harness/policy/profiles.ts`, and the source-level guard
written alongside it found something the launch prompt had wrong. The prompt
recorded the two in `commands/harness.ts` as "the ONLY local profiles that
exist". `tool/builtin/spawn-subagent-tool.ts` held two more, with their own
fingerprint inputs. All four now resolve from one module; the two shell profiles
keep their exact fingerprints and stay OUT of the operator-selectable name set,
because `network: allow` with `delegate: allow` is not a posture a `serve.json`
should be able to select by typing a name.

That the guard found them, rather than a reading of the prompt, is the point.
The prompt was written by the same process that wrote the code.

### D2 — the comparison is structural, and every uncertainty fails closed

"Not weaker than local" is decided over the resolved profile's fields, never
over `profileId` or `profileVersion`. Two profiles can share a name and differ
in every default, and the default is the part that grants. A name comparison
here is the recorded `allowlist-not-a-boundary` lesson repeating exactly.

The comparator iterates the UNION of both profiles' `defaults` keys rather than
a hardcoded list of five, so a key added to `PolicyProfileDefaults` later is
compared without editing the comparator. An unrecognised outcome has no rank and
widens; a key present in one profile and absent in the other cannot be shown to
be no weaker and widens; a dropped isolation requirement widens; the two
`deny`-pinned controls are checked rather than assumed.

### D3 — `ask` resolves to deny in this slice, explicitly

Approvals are R4d. A turn that raises `ask` must terminate in a recorded denial
here, visible in the turn result and the event stream. It must not block, must
not silently allow, and must not leave a turn hanging on a timeout that does not
exist yet. This is written in the source as a stated R4d boundary rather than
being an accident of there being no approval store — the difference matters,
because an accident stops holding the moment the store appears.

### D4 — the first mutating route pays R4b's deferred debt

R4b deferred authentication-failure throttling with the reason "on two read-only
routes behind a loopback socket there is nothing to enumerate and no state to
change". `POST /v1/turns` changes state. Throttling lands here, and it must
never throttle an already-authenticated in-flight turn.

## Out of Scope — with reasons

- **Pending approvals**, `GET /v1/approvals`, `POST /v1/approvals/{id}`. R4d.
  `ask` denies here (D3).
- **`POST /v1/turns/{turnId}/cancel`.** Drain already reaches a terminal state
  on SIGINT/SIGTERM and the TUI stays canonical for emergency shutdown; cancel
  lands with approvals, which is where a long-lived pending turn first becomes
  reachable.
- **`GET /v1/commands`, `POST /v1/maintenance`** (R4e); **`POST
  /v1/credential-links`** (R4f); `GET /v1/flows`.
- **`GET /health` and cross-process liveness.** Still deferred: there is no PID
  file and no supervisor, so a separate CLI process cannot honestly report
  `listening`. `keryx serve status` continues to report configuration state.
- **TLS, a public listener, any non-loopback default.** Non-loopback stays
  refused-unless-acknowledged, unchanged from R4b.
- **Any change to the harness run loop, the policy engine or the session store**
  beyond the profile-resolver extraction in D1. Remote Entry invokes them; it
  does not reclassify, and no HTTP type may appear in a harness domain contract.
