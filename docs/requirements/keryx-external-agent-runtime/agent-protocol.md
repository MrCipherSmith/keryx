# Agent Protocol: Keryx External Agent Runtime
Version: 0.2.0

## Purpose

How an external child is instructed, how it is watched, and what the parent is
obliged to do with what comes back. The wire formats and argv are in
[specification.md](specification.md); this document covers behaviour.

## 1. The runtime directive

An external CLI discovers and obeys the operator's own project files. In this
repository that means `AGENTS.md` and `.metaproject/index.md`, which instruct any
agent to route through the metaproject router, prefer `keryx ctx rg` over raw
search, and consult skills before acting.

**This is desirable and must not be suppressed.** An external agent that
discovers keryx tooling and uses it produces better work — the ablation runner
observed exactly that behaviour arising unprompted. What must be suppressed is
the *routing* those files also trigger: an agent that reads them will try to
convene an orchestrator, open a flow, or offer the operator a menu of modes.

The reference implementation measured this precisely: asked to review a change,
the external CLI answered with a numbered choice of review modes — exit 0,
non-empty output, and therefore recorded as a successful review. A question is
not a review.

So every external dispatch carries a directive as the first element of its
prompt, before the task:

> You are running non-interactively as a bounded child agent. Produce the work
> itself as your final message, in the requested output schema. Do not ask
> questions, do not offer a choice of modes, do not route to another skill,
> orchestrator, or flow, do not delegate to another agent, and do not create or
> modify any files. Read-only investigation only. Project tooling documented in
> this repository is available and you are encouraged to use it for reading and
> searching.

The directive is written as instruction to the model rather than imposed by
modifying the operator's own CLI configuration, which belongs to them and is
used for other work.

The directive is never truncated. When the prompt exceeds its ceiling, the
working diff is cut and the truncation is stated inline — the directive and the
task always survive.

## 2. Recursion containment

The external agent has a shell and will find keryx. Left alone it can reach a
keryx spawn path and create a grandchild that has never heard of
`maxTreeDepth`, `maxChildrenPerRun`, or the ledger.

Two obligations, and the second is the one that actually holds:

1. The directive forbids delegation.
2. The child environment carries a depth marker. **keryx honours the marker on
   entry**, refusing to spawn any child when the marker indicates the process is
   already running inside an external child at or beyond the configured depth.

The second exists because the first is a request to a model and the marker is a
check in our own code. Only the check is a control.

The marker is also the reason the vendor's own nesting variables are stripped
(see [security-policy.md](security-policy.md)): a nested CLI that believes it is
its own parent produces exactly the class of session-identity confusion that has
been observed to hang a parent process for tens of minutes.

## 3. What the parent must do with the result

1. **Never treat it as evidence.** The result is material for the parent's
   decision. Flow completion still requires artefacts keryx produces and can
   re-check ([decisions.md](decisions.md) D-05).
2. **Never act on unquarantined text.** Free text outside the structured result
   passes `quarantineChildSummary` and `keryx security check-output` first. An
   external agent read files, and possibly the network, under a model the parent
   does not control; its prose is untrusted input, not a colleague's summary.
3. **Never paper over a failure.** A named `SubagentCompletionStatus` and its
   cause are the result. If the parent wants a retry, a different agent, or to
   do the work itself, it must choose that visibly ([decisions.md](decisions.md)
   D-07).
4. **Attribute honestly.** Any parent-authored summary that incorporates
   external work must say which agent produced it. A report that reads as the
   parent's own conclusions when it is a third-party model's judgement is the
   failure that D-05 and D-07 both exist to prevent.

## 4. Supervision

> **NOT IMPLEMENTED as of 0.2.0.** This whole section describes intended
> behaviour that does not exist: no trigger is implemented and the fold has no
> consumer, so today the parent receives the child's result and nothing before
> it. The stream itself is live and already drives the operator's transcript, so
> what is missing is the consumer, not the mechanism. Kept here as the design it
> is, marked so nobody reads it as the behaviour it is not.

The parent does not read the stream. It receives trigger-driven updates derived
from the existing fold, and may respond in exactly three ways: inject a
correcting message, kill the child, or escalate to the operator.

| Trigger | Parent's reasonable responses |
|---|---|
| `phase_changed` | usually nothing; update its own plan |
| `budget_threshold` | correct toward a narrower task, or kill |
| `no_progress` | correct with a concrete next step, or kill |
| `agent_asked` | answer it, or kill and re-dispatch with the answer inlined |
| `scope_drift` | correct, or kill |

`agent_asked` deserves care: the directive forbids questions, so a question
means either the directive was overridden by a stronger instruction in the
operator's own project files, or the task was underspecified. Both are worth
escalating rather than silently answering, because both will recur.

Injecting a correction is not free. For an agent with `streamingInput: false`
it costs a resume, and for any agent it costs turns on the operator's
subscription. A parent that corrects on every trigger has misunderstood the
economics of the feature.

## 5. Operator interaction

The operator's messages are delivered verbatim and immediately at the next turn
boundary. They are not routed through the parent, filtered by it, or delayed for
its judgement — the operator's control is direct.

The parent learns of every such message through a `user_message` canonical
event, so its picture stays synchronised without holding the delivery
([decisions.md](decisions.md) D-09).

When the operator and the parent issue contradictory corrections, the operator's
stands. The parent is told, through the same event stream, what happened.

## 6. Observability obligations

- Every spawn records the resolved agent, version, sandbox mode, session id,
  worktree path and the argv, so a run can be reproduced or continued by hand.
- Every parse failure is counted and surfaced; a transcript that yields a high
  skip rate is a version-drift signal, not a curiosity.
- Cost and turn count are surfaced as reported by the CLI. keryx does not
  estimate cost it was not told, and does not present a missing figure as zero.
- A version outside the codec's `knownGoodRange` produces a recorded warning on
  the run, visible in the modal's Meta tab. It does not block.
