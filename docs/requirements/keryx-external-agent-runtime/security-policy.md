# Security Policy: Keryx External Agent Runtime
Version: 0.1.0

## Purpose

The rules that make delegating work to a third-party agent safe enough to ship.
Each rule below exists because of a specific failure — measured in the reference
implementation, or structurally guaranteed by keryx's own invariants. Rules
without a reason are not rules; they are habits, and they get relaxed.

## 1. The credential boundary

**keryx never touches a vendor credential.** Not to use, not to store, not to
forward, and — the part that is easy to get wrong — **not to read for a liveness
check**.

- Availability is determined from `--version` output and process exit codes.
- `~/.codex/auth.json`, Claude's credential store, and any equivalent are
  out of bounds. Opening one to answer "is the operator logged in?" would place
  keryx inside the prohibition `provider-auth` D-01 describes, in exchange for a
  status line.
- The consequence is accepted deliberately: there is **no cheap liveness probe**
  for the subscription path. `--version` proves a binary and nothing about a
  login, and a real probe spends the operator's quota. Availability therefore
  has three states — available, unavailable, and *not probed* — and the third
  must be displayed as itself. A green tick meaning "nobody asked" is a lie with
  a specific cost: the operator dispatches work that cannot run.

## 2. Environment hygiene

The child environment is built by copying the parent's and removing from it. Not
by allow-listing: an allow-list would have to enumerate every variable a build
toolchain needs, and would fail closed in ways that look like the CLI being
broken.

### 2.1 Named removals

| Variable | Why |
|---|---|
| `ANTHROPIC_API_KEY` | **Presence breaks the subscription path.** Measured: with the key present the CLI answers `Not logged in · Please run /login`; with all `ANTHROPIC_*` cleared it answers on the subscription. Counter-intuitive and load-bearing. |
| `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` | The keryx session may itself be bound to a third-party or local provider. Inheriting these routes the "external" agent straight back through the model it is supposed to be independent of, while the result is still labelled with the external agent's name. |
| `CLAUDE_CONFIG_DIR` | A settings file can carry its own `ANTHROPIC_BASE_URL`. Stripping the variables while leaving a pointer to a config that re-sets them achieves nothing. A third-party router has hijacked every session on a machine this way before. |
| `CLAUDECODE` | Marks "you are running inside Claude Code". A child that inherits it misidentifies its own context. |
| `CODEX_HOME` | Same class as `CLAUDE_CONFIG_DIR` for the other CLI. |

### 2.2 Prefix sweeps

`CLAUDE_CODE_*` is swept rather than enumerated. A table of individual names
would be a table that falls behind the vendor's next release, and this is
precisely the kind of list that is not noticed when it does.

### 2.3 Sweeps for keryx's own variables

Any keryx variable that identifies a session, transport, or channel is removed.
The reference implementation recorded the exact failure: a nested CLI inherited
its parent's channel identifier, registered itself as *the same session*, and the
parent's next tool call never returned — three operator messages sat queued for
twenty-two minutes. A nested agent that believes it is its parent is not a
cosmetic problem.

The depth marker described in [agent-protocol.md](agent-protocol.md) is the one
keryx variable deliberately **added**, not removed.

### 2.4 stdin

`stdin` is never inherited. It is either the streaming-input pipe or explicitly
ignored — a CLI that inherits an open stdin announces that it is reading
additional input from it and waits.

## 3. Containment

Read-only is held by three mechanisms, and their order matters because only one
of them is a guarantee.

1. **The CLI's sandbox flag.** Real, vendor-implemented, and the cheapest to
   apply. Not sufficient alone: it constrains the CLI's own shell, not every
   route the agent has.
2. **The tool deny-list.** Reduces wasted turns and closes the obvious routes.
   **Not a guarantee.** It cannot be shown complete; escape routes in the
   reference implementation were found only by asking the agent directly what it
   could still reach, and it named two the author had not considered. Anything
   the CLI gains in a later version is permitted by default.
3. **The disposable detached worktree.** The guarantee. A write that escapes the
   first two lands in a directory that is deleted afterwards.

Two corollaries follow, and both must be honoured:

- The worktree is removed on **every** terminal path, including thrown errors
  and killed processes. A leaked worktree is a leaked escape hatch.
- The project's own permission-granting settings files apply to a subprocess
  that inherits the working directory, and they may allow far more than the
  deny-list denies. Under `-p` there is nobody to prompt, so an allow-listed
  tool simply runs. Running in the throwaway worktree is what makes this
  survivable; neutralising those files in the live tree was considered and
  rejected ([decisions.md](decisions.md) D-08).

## 4. Untrusted output

Everything an external agent returns is untrusted input. It read files under a
model keryx does not control, possibly with network access, and its prose may
carry content from any file it opened.

- Free text passes `quarantineChildSummary` before entering the parent's
  context, exactly as a native child's does.
- It additionally passes `keryx security check-output` before being written into
  memory, wiki, reports, or task context.
- The structured result is validated against `subagent-result`. An invalid
  result is an `Error`, never a silent downgrade to prose — accepting prose in
  place of a schema is how an unvalidated payload reaches the parent by the back
  door.

## 5. Transport and environment restrictions

The capability is **hard disabled** — regardless of configuration — when:

- the active transport is remote (`keryx-remote-entry`, `keryx-telegram-transport`);
- CI is detected.

The reason is the compliance boundary, not paranoia about automation. What the
vendors' terms unambiguously forbid is offering their subscription as a service
to others or routing anyone else's requests through it. A local, operator-run,
explicitly-enabled capability is not that. The same capability reachable over a
chat transport begins to look like it, and the difference must be structural
rather than a matter of intent.

Refusal is always a named reason. A silent no-op would leave the operator
believing an external agent ran.

## 6. Cost as a security property

Subscription quota is a finite resource the operator paid for, and an agent they
are not watching can exhaust it.

- Model-initiated spawns default to policy `ask`. The default is configurable to
  `allow` for operators who want autonomy, but it is not the default.
- Per-run cost and turn count are surfaced where the CLI reports them. A missing
  figure is displayed as missing, never as zero.
- A CLI-reported budget cap is used where available, so exhaustion is a clean
  `BudgetExhausted` rather than an unbounded run.

## 7. Non-claims

This package does not claim:

- that any vendor sanctions third-party headless orchestration of its CLI —
  neither vendor has published a position, and [decisions.md](decisions.md) D-01
  records this as an open risk rather than a resolved question;
- that the tool deny-list is complete, now or after any CLI update;
- that an external agent's output is verified, reproducible, or evidence;
- that read-only containment has been penetration-tested. It is defence in
  depth with one load-bearing layer, and the acceptance criteria test that
  layer's behaviour, not an adversary's absence.
