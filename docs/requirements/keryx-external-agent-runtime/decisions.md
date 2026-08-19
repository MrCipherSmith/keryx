# Decisions: Keryx External Agent Runtime
Version: 0.2.0

## Status

Decision record. Every entry below was put as an explicit fork with options and
a recommendation during the 2026-08-19 interview; the reasoning and the rejected
alternatives are kept because several of the refusals are the load-bearing part.
Full option history is in [brainstorm.md](brainstorm.md).

## D-01: The credential boundary, and what it does and does not permit

**Question.** `provider-auth` D-01 refuses subscription OAuth for Anthropic and
OpenAI, because their terms forbid third-party products from using consumer-plan
credentials. Does that refusal also forbid keryx from *running the vendor's own
CLI*?

**Decision.** No — but the permitted shape must be stated narrowly, and it is:

> keryx executes the vendor's own official client, which authenticates itself
> from its own configuration. The token is never obtained, read, stored,
> forwarded or proxied by keryx.

**Reasoning.** `provider-auth` D-01 concerns keryx holding and presenting
someone else's subscription credential. Here keryx holds nothing: it starts a
process the operator already installed and already logged in, in the same
relationship as a terminal multiplexer starting it. That is a different act, and
conflating the two would be as wrong as permitting the first.

**Enforced consequences.**

- keryx must not read `~/.codex/auth.json`, Claude's credential store, or any
  vendor token file — **not even to test whether a login exists**. Reading the
  token would place keryx inside D-01's prohibition for no gain. Availability is
  determined from `--version` and process exit codes only.
- keryx must not inject a credential into the child environment. The reverse is
  also required and is not symmetric: an inherited `ANTHROPIC_API_KEY` actively
  *breaks* the subscription path (see [security-policy.md](security-policy.md)),
  so the variable is stripped, never supplied.
- keryx must not pool, resell, share or proxy any vendor session.

**The residual risk, stated as a risk.** Whether a vendor considers headless
orchestration of its own client by a third-party harness acceptable is **not
addressed by either vendor's published terms**. This package does not claim
vendor sanction, and no document in it may imply one. The mitigation is
structural rather than legal: the capability is off by default, opt-in, and
local-only — the operator enables it on their own machine, for their own
subscription, by an explicit act. It is hard disabled under remote transports
and CI precisely so that it cannot become a service offered to anyone else,
which is the thing the vendors' terms unambiguously forbid.

**Consequence for the roadmap.** If a vendor later publishes a position, this
decision is where it lands — a registry field and a status line, not a
re-architecture.

## D-02: An external CLI is a runtime, not a provider

**Decision.** External CLIs plug in as a second implementation behind
`spawnChild`, surfaced as a `runtime` parameter on `spawn_subagent`. They do
**not** implement `ProviderPort`.

**Reasoning.** `codex exec` and `claude -p` are whole agents with their own tool
loops, their own sandboxes and their own file access. `ProviderPort` returns an
assistant message plus tool calls for keryx's loop to execute. Fitting one into
the other requires either breaking the port's contract or suppressing the
external loop — and the external loop is the entire thing being paid for.

Choosing the child seam instead inherits, at no cost, the machinery
`keryx-multi-agent-engine` already shipped: budget ledger, depth and child
caps, worktree assignment, quarantine, the `agent-event` stream, and
`SubagentCompletionStatus`.

**Rejected alternative.** A standalone builtin tool (`spawn_external_agent`).
Honest and simple, but it sits outside every one of those mechanisms and would
have to reimplement them or go without.

## D-03: keryx spawns the CLI; it does not serve a CLI that spawns itself

**Question.** The reference implementation studied (helyx) has two working
patterns: keryx-style *push*, where the harness spawns the CLI; and *pull*,
where the harness runs an MCP server and a human-started CLI session pulls work
from it.

**Decision.** Push.

**Reasoning.** Pull has a genuine advantage — no environment or authentication
handling at all, because the session was started normally by a human. But under
pull keryx stops being the orchestrator: it cannot fan out on demand, cannot
enforce fail-closed behaviour, and cannot hold the "parent owns completion"
invariant from `keryx-project-agent-harness`. The useful residue of pull — an
external agent consuming keryx's project intelligence — is already delivered by
`src/mcp/`.

**Kept from the rejected option.** Two ideas are worth carrying forward and are
recorded here rather than lost:

1. Forwarding the external agent's *permission requests* back into keryx's own
   `decide()` would resolve the audit-boundary objection to a mutating external
   worker. It rests on an experimental MCP capability with no corresponding
   documented flag, so it is a flagged future option, not a foundation.
2. An MCP server's `instructions` capability reaches the client's system prompt
   before any project file is read — a cleaner channel than a prompt preamble
   for standing behavioural rules, if keryx ever serves rather than spawns.

## D-04: Read-only in this release, with the permission axis in the contract

**Decision.** Only read-only execution is implemented. The `runtime` block
carries `sandbox: "read-only" | "worktree-write"` from the first version, and
`worktree-write` is refused at runtime with a named reason.

**Reasoning.** A mutating external worker is the more valuable feature and the
honest destination, but its cost is not spawn machinery — it is a credible audit
boundary for writes that keryx's guarded-mutation path, evidence ledger and
completion gate can accept. That boundary has a promising design (D-03, kept
idea 1) resting on an unstable interface. Shipping read-only first delivers real
value, exercises every other mechanism, and buys the information needed to
design the write path properly.

Declaring the axis now costs one schema field and avoids a breaking change
later. Omitting it would cost a contract revision and an ADR rewrite within a
release or two.

## D-05: An external agent's output is input, never evidence

**Decision.** The result reaches the parent as material for its decision. It is
never written as an evidence record, and flow completion still requires
artefacts keryx produces itself.

**Reasoning.** keryx's evidence model is about **reproducible artefacts** — a
test run, a health gate, a checked diff. A third-party model's judgement is not
reproducible: the same CLI version will answer differently tomorrow, and keryx
cannot re-derive it. Admitting it to the evidence ledger would weaken the one
mechanism that stops an agent declaring itself finished.

**Rejected alternatives.** Evidence with provenance — attractive because
`keryx-execution-observability` already carries provenance, but provenance
records *where* a claim came from, not whether it can be checked again.
Two-source corroboration — agreement between two language models is correlated,
not independent; it has the shape of a quorum without the property.

## D-06: Registry metadata is data; parsing is code

**Decision.** A declarative registry holds per-CLI metadata. Argv construction,
event parsing and failure classification live in a codec module per CLI.

**Reasoning.** The two CLIs differ *structurally*, not parametrically. Evidence
from the reference implementation:

- `codex exec` narrates itself on stderr and prints the contents of files it
  reads, so its failure classifier must subtract the prompt and consider only
  lines beginning `error`/`usage:` — otherwise a successful exploration is
  misclassified as an error because the agent quoted the classifier's own
  patterns back at it.
- `claude -p` prints `Not logged in · Please run /login` to **stdout with exit
  code 0**, so the rule "exit 0 and non-empty output means success" is false for
  it and true for the other.

A purely declarative table encoding this would grow fields like "subtract the
prompt from stderr before classifying" — code expressed in data, with none of
code's testability. Metadata proper (id, binary, detection, supported modes,
version range) is genuine data and belongs in a table, by the same argument
`provider-auth` D-03 makes for authentication methods.

**Scope.** `codex-cli` and `claude-cli` only. `opencode` is present on the
reference machine, but a third codec teaches nothing new; the seam is validated
by confirming a third agent would need exactly one module and one registry row.

## D-07: Failure is reported, never papered over

**Decision.** When an external CLI is missing, logged out, rate-limited, timed
out or unparseable, the runtime returns a structured `SubagentCompletionStatus`
and a human-readable cause. It never falls back to another agent, another
runtime, or the parent's own model.

**Reasoning.** Fallback is a **policy**, not a mechanism. A parent holding a
named status can implement any policy it likes as a visible decision. A runtime
that substitutes silently corrupts the parent's account of what happened — and
in keryx the parent owns completion, so it would close a task believing an
external agent did work that it did not do.

The reference implementation's automatic self-fallback is correct *for a review
bot*, where a degraded answer beats no answer and nothing downstream depends on
who produced it. That is not this system.

Auto-failover to a second CLI is rejected for the same reason plus one more: it
doubles spend at exactly the moment something has already gone wrong.

## D-08: The disposable worktree is the load-bearing guarantee

**Decision.** Read-only is held by three independent mechanisms — the CLI's
sandbox flag, a tool deny-list, and a throwaway `git worktree add --detach`
checkout — and the worktree is the one relied upon.

**Reasoning.** Deny-lists cannot be shown complete. In the reference
implementation, escape routes were discovered only by asking the agent directly
what it could still reach, and it named two the author had not considered.
Anything a CLI gains in a future version is permitted by default. A guarantee
resting on such a list is a guarantee with an expiry date nobody is told about.

**Amended by flow 176 T1 (2026-08-19).** Layer two is stronger than this text
assumed. Probing `claude 2.1.220` showed `--tools Read Grep Glob` yields a
roster of exactly `["Glob","Grep","Read"]` — it is a genuine **allow-list**, so
future tools are excluded by default rather than admitted. The reference
implementation's lesson was about `--allowed-tools`, a different flag that is
indeed not a restriction; the two were conflated in 0.1.0. Specification §5.3
now uses `--tools`.

This does **not** move the guarantee. A roster governs which tools exist, not
what the model does with the ones it has — `Read` alone still reaches every path
the process can — and codex constrains itself by a different mechanism
(`-s read-only`) whose completeness we equally cannot prove. The measured
starting point remains sobering: with four tools denied, the probe was still
offered twenty-seven, including `NotebookEdit`, `Monitor`, `Workflow`,
`CronCreate` and `TaskCreate`. The worktree stays the load-bearing layer.

A disposable worktree survives a hole in the list: the write lands somewhere
that is deleted afterwards. Since the entire value proposition of this release
is *safe* delegation, the guarantee must not be the weakest of the three.

**Accepted cost.** `git worktree add --detach <path> HEAD` does not carry
uncommitted changes, so the operator's working diff must be passed in the
prompt — which collides with the single-argv-element size ceiling. This is a
treatment for the symptom and is recorded as risk R-6 in [prd.md](prd.md),
not presented as an absence of the problem.

**Rejected alternative.** Neutralising permission-granting settings files in the
live working tree for the duration of a run. It races the operator's own session
and any other process in the repository, and it mutates the tree in order to
prevent mutation of the tree.

## D-09: Delivery and awareness are separated

**Decision.** An operator message is delivered to the external agent verbatim,
and a corresponding event is written into the stream the parent's folded view
reads.

**Reasoning.** Routing the message *through* the parent couples two independent
things and loses direct control — the operator says "stop" and a supervising
model decides the moment is wrong. Bypassing the parent entirely desynchronises
its picture from reality, so its own corrections begin to contradict the
operator's. Splitting them costs one extra event and has neither failure mode.

## D-10: The parent sees a fold; the operator sees everything

**Decision.** The parent agent receives trigger-driven updates from the folded
event stream. The operator's modal renders the complete stream.

**Reasoning.** A parent reading every event of a verbose external run spends the
operator's own model budget in proportion to another vendor's verbosity — the
exact inversion of the point of the feature. Rendering, by contrast, costs
nothing: the modal is a view, not a context. So the economising applies only
where tokens are actually spent, and the operator's visibility is not reduced
at all.

`reduceAgents` / `reduceState` already produce the fold, and
`SubagentCompletionStatus` already names the stop reasons a trigger would fire
on, so this decision consumes existing machinery rather than adding any.

## D-11: The modal renders the event stream; it does not emulate a terminal

**Question.** The operator asked to watch the external agent work "like in a
normal terminal". Three ways to provide that: render our own structured view
from the machine-readable stream; run the CLI under a PTY and emulate a
terminal; or run it inside tmux and show a captured pane.

**Decision.** Render the structured event stream into the existing subagent
modal.

**Reasoning.** Both alternatives buy visual fidelity by forcing the CLI into
*interactive* mode, and interactive mode is mutually exclusive with the flags
this package depends on: the structured output format, the result schema, and
the native budget ceiling all require the print/headless mode. Losing them
means keryx cannot tell what happened, cannot validate a result, cannot cap
spend, and has nothing to hand a completion gate — which is to say it stops
being keryx and becomes a terminal multiplexer with extra steps.

A PTY route additionally needs a terminal emulator, which the zero-dependency
policy does not permit outside an optional dependency; a tmux route needs the
tmux binary and turns a stream into a scraped screenshot.

The fidelity gap is smaller than it looks: a coding agent's transcript *is* a
sequence of tool calls and results, so a structured render of the same events
reads much like the original. What it genuinely loses — the vendor's own
spinners, colours and layout — is not information.

**Compensation, so the loss is not total.** The modal shows the exact launch
argv and a detach instruction, so the operator can reproduce the run or
continue the session by hand in a real terminal against the keryx-assigned
session id. The escape hatch exists; it is just not the default view.

## Deferred

- The mutating external worker, and with it the permission-forwarding route
  described in D-03.
- A third and further codecs (`opencode`, and any vendor that later ships a
  headless mode).
- Whether an external child may itself spawn children, and what the depth
  marker should mean across a runtime boundary where the child cannot be trusted
  to honour it.
- Cost attribution across mixed runs, where part of the work was paid for by
  subscription and part by API key.
