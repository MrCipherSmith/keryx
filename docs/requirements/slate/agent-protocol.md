# Keryx Slate — Agent Protocol
Version: 2.0.0

## Status

Design/future protocol. It specifies agent behavior once slate exists; no
behavior in this package is a claim about the current runtime. Slate does not
replace or reinterpret the [SAC agent protocol](../shared-agent-context/agent-protocol.md);
it adds task-local behavior in front of it.

## Preconditions

An agent must receive a slate scoped to its own session (or, for a dispatched
subagent, its own dispatch) before treating any Anchors/Course/Seeds content
as authoritative. It must treat a missing or unreadable slate as unknown, not
as "nothing is happening" — Anchors/fence are always rebuilt from live repo
state on any restart/resume, never restored from a possibly-stale prior
slate.

A slate never grants access. Anchors.root/tree/touched are situational
awareness for the agent, never an authorization input — access is never
inferred from checkout or worktree proximity.

## Read protocol

1. Anchors are read-only to the model; only harness code writes them.
2. Course is always re-derived from the live Flow projection at the moment of
   read — a cached/stale Course value must never be presented as current. If
   the underlying flow read fails for any reason (deleted, archived,
   malformed, permission), the agent must treat Course as `unbound`, not
   retry indefinitely or crash the surrounding context assembly.
3. Seeds are draft hypotheses only. An agent must never present a Seed as
   accepted knowledge, and must never promote a Seed to Know-how itself —
   only the existing `workspace review` path may do that.
4. A subagent's own slate (Anchors/Course/Seeds) is scoped to its dispatch
   only. It must never read or write the parent's slate directly, and must
   never claim authority over the parent's Course or flow.

## Work protocol

The agent reads Course from the live Flow projection and reports
discrepancies. It must use existing Flow commands/APIs for any work-state
change; slate is never an alternate tracker or completion channel. An agent
must never call `flow complete` itself because Course appears finished — it
may only react to an already-committed transition.

## Wrap-up and proposal protocol

The agent may hand the wrap-up composer only: machine-collected facts (git
diff, flow snapshot, deduplicated Seeds) and a model-authored summary that
must not contradict those facts. It must not submit raw transcripts, prompts,
hidden reasoning, or a claim that a target was already updated.

`propose` requires a `workspaceId` captured earlier in the slate's life
(there is no reverse lookup from a Flow reference to its workspace) — either
through an explicit mid-session consult naming an id, or through `/goal
--workspace <id>` (SLATE-15) at slate-open time, the recommended path for
unattended tasks specifically since nothing else prompts a consult on its
own. If none was ever captured, the composer must not guess, default, or
invent one. It still preserves its evidence and summary as a local artifact
rather than discarding the completed work, for a human to bind to a
workspace later via `workspace catch-up`.

Wrap-up triggers on Flow-complete, an explicit human command, or — for a
one-shot `keryx harness run`/`--goal` invocation specifically, never for a
`keryx shell` REPL session — natural process termination. A task that never
bound a Flow and had no human present must still reach wrap-up this way;
the agent must not treat "no Flow, no human command" as a reason to skip
wrap-up entirely.

Each Seed may carry an optional `kind`. The composer groups Seeds by `kind`
and issues one `propose` per non-empty group; untagged Seeds go into a single
`follow-up` group. The agent must never invent or guess a `kind` a Seed did
not actually carry, and must not collapse Seeds of different explicit kinds
into one proposal to save a call.

**Interactive sessions.** A wrap-up may only be triggered by an already
surfaced, visible action — the harness stating its intent, or an explicit
human command. A silent background chain from Flow-complete straight through
to `propose` is prohibited, even though nothing today technically blocks it.

**Unattended sessions.** `propose` proceeds normally on Flow-complete or an
explicit scheduled trigger. `accept` is unavailable to any session whose
`interactive` context field is `false` — including every `keryx serve`
session unconditionally, regardless of its configured `PolicyProfile` —
regardless of role. The agent must not attempt `accept` in that state, must
not retry around a denial, and must not degrade to any other mechanism that
achieves the same effect (e.g. spawning an interactive-looking sub-invocation
to self-authorize, or arguing that a configured profile implies interactivity
when the honest `interactive` flag says otherwise). The proposal remains
pending until a human runs `workspace catch-up` or `workspace review` from a
session where `interactive` is honestly `true` — for local scheduled runs,
that requires an operator-set flag on `keryx harness run` fixed ahead of time
by a human, never claimed by the agent at run time.

**Subagent handoff.** On dispatch return, a subagent's slate state
(Anchors/Course/Seeds) must be handed to the parent only through the
dedicated `childDispatches[dispatchId]` channel, tagged and unmerged. The
parent must never copy a child's Seed text verbatim into its own Seeds list
and represent it as its own — if the parent wishes to record a Seed inspired
by a child dispatch, it must author a new statement attributable to itself,
with the child's entry remaining separately visible as the underlying
evidence. This is a structural requirement (the storage schema itself keeps
the two separate), not only a prompt instruction.

## External-hand protocol (v3, SLATE-22…26)

This section governs any agent that is NOT keryx's own internal harness —
Claude Code, Codex, or any other MCP-connected client using `slate.open`/
`slate.writeSeed`/`slate.close` instead of the in-process slate keryx's own
runtime uses for itself.

1. An external hand's slate is exclusively its own. It must never attempt to
   discover, read, or reference another hand's `externalSessionId` or its
   slate content — no tool exists for this, and none should be assumed to
   exist. Nothing about this protocol makes Slate a shared object; only the
   dispatched proposal, after close, is shared, via the pre-existing SAC
   workspace `propose`/`review` path.
2. An external hand must call `slate.open` once per task, reusing the same
   `externalSessionId` for the life of that task if it needs to resume after
   losing its handle (`slate.open` is idempotent per id — it is safe to call
   again, it will not create a second competing slate).
3. Anchors an external hand reports via `slate.open`/`slate.writeSeed` must
   describe only what it directly observes about its own situation (its own
   working directory, the files it has actually touched). It must not
   fabricate keryx-native-shaped fields (`tree`, `runtime`) it has no way of
   knowing — omit them rather than guess.
4. Seeds written via `slate.writeSeed` are draft hypotheses exactly as
   defined in the Read protocol above — an external hand must never present
   one as accepted knowledge, and it cannot control or spoof its own `origin`/
   `trust` tagging (the harness sets both server-side); it must not attempt
   to work around this by, for example, writing a Seed's text claiming a
   different origin.
5. `slate.close` behaves like SLATE-7/18's wrap-up trigger for that hand's
   own task only. Binding a `workspaceId` (explicitly at `slate.open`, or via
   SLATE-16 resolve-or-create when omitted) works exactly as it does for a
   keryx-native slate — an external hand must not invent its own workspace
   resolution logic in place of calling `slate.open`/relying on SLATE-16.
6. An external hand must not treat a `slate.*` call's absence of an error as
   proof of dispatch: `slate.close` without a bound `workspaceId` succeeds
   but produces an `unbound-candidate` artifact, not a proposal — the hand
   should surface this distinction to the human it's working with, the same
   way keryx's own catch-up flow (SLATE-10) does.
7. An external hand has no obligation to call `slate.close` before its own
   process/conversation ends for unrecoverable reasons (crash, disconnect) —
   SLATE-26's idle-TTL auto-close exists precisely so a forgotten or
   impossible close does not leave state open indefinitely. A hand that
   *can* close cleanly still should, since it makes wrap-up happen sooner
   than the TTL would.

## Catch-up protocol (SLATE-10)

On invocation, `keryx workspace catch-up` presents accumulated unattended
output as three hard-separated categories — pending proposals, blocked/
incomplete runs, and unknown/crashed runs — never interleaved. For each
pending proposal, the agent (or the command itself) must re-check evidence
freshness before presenting it and mark any stale item explicitly rather than
letting the human decide against evidence that has already drifted. Each
item is presented as a structured question with options and a recommendation,
not a raw diff/JSON dump. The human's actual decision still flows through the
existing, unmodified `workspace review` command.

## Failure protocol

- Evidence unresolved/changed: mark candidate Seed `stale` or omit it from
  the wrap-up.
- Ask_user/Course.blocked with no human present (unattended): fail-closed
  safe-stop. Emit a structured, machine-readable terminal state (not a
  free-text instruction pushed permanently into session history). Do not
  retry with a silently-chosen default — an unattended session has no
  standing authorization to decide which questions may be defaulted.
- Model credential missing at wrap-up time: fail closed, no proposal created.
- Model credential present but the provider times out: fall back to a
  mechanical template summary (git diff + flow status) rather than blocking
  indefinitely or failing the whole wrap-up.
- Two wrap-up triggers firing close together for the same flow transition:
  must not produce two independently-reviewable overlapping proposals.
- `interactive` signal unavailable, ambiguous, or untrusted: treat the session
  as non-interactive and deny `accept` — never default an ambiguous or
  missing signal to `true`.

## Prohibited behavior

- Writing accepted knowledge directly, or accepting a proposal the same
  session/actor authored — in interactive or unattended mode alike.
- Self-declaring or overriding a session's own `interactive` context field to
  unlock `accept`.
- Copying a subagent's Seed/Anchors/Course content verbatim into the
  parent's own Seeds and presenting it as independently authored.
- Treating Anchors (root/tree/touched/fence) as an authorization signal for
  any read or write decision.
- Persisting or replaying raw agent reasoning, transcripts, or hidden
  chain-of-thought as slate or wrap-up content.
- Building a competing session↔workspace binding, evidence-sealing, identity,
  or reservation mechanism inside slate where [RP-03](../shared-agent-context-lifecycle-binding/README.md),
  [RP-05](../shared-agent-context-secure-evidence/README.md),
  [RP-06](../shared-agent-context-identity-capabilities/README.md), or
  [RP-08](../shared-agent-context-collaboration-worktrees/README.md) already
  own that scope.
- (v3) An external hand attempting to read, enumerate, or reference another
  `externalSessionId`'s slate content, or to claim a different `origin.harness`
  value than the one the MCP tool call itself attributes to it.
- (v3) An external hand fabricating keryx-native Anchors fields (`tree`,
  `runtime`) it has no actual way of observing, rather than omitting them.

## Required protocol tests

- Crash/resume: Anchors/fence after a restart equal a fresh computation, not
  a carried-over value from a prior (possibly stale) slate.
- Course desync: a flow deleted/archived mid-session yields `unbound` at the
  next read, not an uncaught exception.
- Subagent laundering: a parent's Seed, written after a subagent dispatch
  that itself saw the parent's existing Seeds, is provably distinct in
  storage from the child's `childDispatches` entry (never a verbatim copy).
- Unattended self-accept: a session with `interactive: false` attempting
  `accept` is denied regardless of its role or subject, and regardless of its
  `PolicyProfile`; the same session's `propose` still succeeds.
- Interactivity spoofing: a session cannot flip its own `interactive` context
  field from `false` to `true` at run time; only a value fixed by the harness
  boundary at session start (honestly `false` for every `keryx serve` turn;
  set by a human-configured flag ahead of time for local scheduled runs) is
  honored.
- Fork carry-over: a session created via `keryx sessions fork` starts with no
  `slate.json` at all — a test must assert the fork's Anchors/Course/Seeds are
  freshly empty, not inherited from the source session.
- Missing workspace binding: a wrap-up with no `workspaceId` ever captured
  produces an `unbound-candidate` artifact and no attempted `propose` call
  against any guessed or default workspace id.
- Wrap-up credential failure: missing credential yields no proposal and no
  partially-written evidence bound to a false summary; a slow-but-present
  credential yields a mechanical fallback summary, not a hang or a failure.
- Catch-up staleness: a proposal whose evidence has drifted since creation is
  marked stale before display, not only discovered as `stale` after an
  attempted accept.
- (v3) Cross-hand isolation: a `slate.*` call for `externalSessionId` A can
  never read or affect a file belonging to `externalSessionId` B, verified
  directly against the filesystem, not only against the tool's own responses.
- (v3) Idle reclaim: an external slate untouched past the stale-lock
  threshold is auto-closed (dispatched or `unbound-candidate`) on the next
  `slate.*` call for that `cwd`, and never auto-closed by any process that
  isn't itself handling a live `slate.*` call.
- (v3) Provenance integrity: a Seed written via `slate.writeSeed` always
  carries `origin.harness`/`trust: "external-unverified"` in the resulting
  proposal's evidence, regardless of what text the Seed itself contains.
