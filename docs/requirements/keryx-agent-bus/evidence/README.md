# Evidence: keryx agent bus

Flow 279 T5 (agent bus P5), acceptance criteria AC4–AC6 of
[the flow's own acceptance criteria](../../../../.metaproject/flows/279-2026-09-20-agent-bus-p5-wiki-architecture-page-cli-/acceptance-criteria.md):
proof that [the PRD](../prd.md)'s two success-criteria scenarios hold, on a
real throwaway clone with two linked git worktrees, each running its own
shell — not a unit test, not a mock.

- [scenario-1-pause-publishing.md](scenario-1-pause-publishing.md) — A holds a
  `git-publish` lease over B; B's `git push` requires approval in `auto` mode
  while it applies; A resumes; the floor lifts. **Held**, fully, live.
- [scenario-2-ask-and-reply.md](scenario-2-ask-and-reply.md) — A sends B a
  message; it enters B's agent history as `provenance: "tool"`; B replies; A
  sees the reply. **Held**, live, on a local `ollama/llama3.1` model, including
  the `ack` and its ordering after the history push. The one part not proven is
  a *model-authored* reply: that model would not emit a well-formed tool call,
  so the reply is operator-issued and labelled as such in the file.

Read the relevant specification and decisions before either file:
[specification.md §4.3](../specification.md#43-pause-lease) (pause lease
fields and scope enforcement), [§4.4](../specification.md#44-publish-floor-in-the-approval-gate)
(the publish floor), [decisions.md D-09](../decisions.md#d-09-presence-liveness-is-a-heartbeat-first-the-pid-second)
(liveness), [D-12](../decisions.md#d-12-bounds-on-every-sender) (rate limits,
lease bounds) and [D-13](../decisions.md#d-13-the-agent-cannot-use-the-cli-to-bypass-its-own-tools)
(why the CLI refuses inside a tool call). Most of this evidence drives the
`/bus` slash commands, so that the operator surface exercised is the one
D-05/D-13 describe; scenario 2's delivery step sends from the `keryx bus` CLI
instead, deliberately, so that the `cli` origin is covered too.

## How this was produced

Both scenario files are self-contained: each states its own setup from a bare
`mktemp -d` sandbox, so either can be followed on a fresh checkout without
depending on the other having been run first, or on any state this dispatch
created but did not write down. Every command, and every quoted line of
output, was actually run and actually observed — not reconstructed from
reading the source. Two small automation scripts drove the interactive
shells' stdin/stdout for this dispatch (the same shape
`src/commands/shell-bus.process.test.ts` and
`src/commands/shell-pause.process.test.ts` already use for hermetic
cross-process bus tests); the commands and output in the scenario files are
exactly what a person typing them into two real terminals would see.

## The honesty boundary (binding per AC6)

Two things in the PRD scenarios need a live model turn or a human at a
prompt, and neither was available in this sandbox:

1. **A live agent deciding to call `shell_exec("git push")` under a
   `git-publish` lease, and a human answering the resulting approval prompt.**
   Scenario 1 instead drives the real `isPublishCommand` +
   `resolveApprovalDecision` functions directly against the real lease state
   the real bus produced — the same substitution
   `src/commands/shell-pause.process.test.ts` makes for its own AC11
   coverage of this exact case. Stated inline in that file, not left to be
   inferred.
2. **A live agent's turn actually completing, so a bus message can reach one
   of `runAgentTurn`'s three drain sites and be pushed into history with
   `provenance: "tool"`, and a live agent authoring a reply via `bus_send`.**
   Scenario 2 attempted this directly (typed an operator line into the
   target shell to start a real turn) and observed it fail before reaching
   any drain site, because both shells run `--provider deepseek --model
   unused` with no credentials configured, which resolves to the offline,
   transcript-less `FakeProvider` (`src/harness/provider/make-provider.ts`).
   That failure, and what it does and does not prove, is recorded verbatim in
   that file rather than smoothed over.

Neither substitution is presented as if it were the real thing: every claim
in both scenario files that rests on a driver script, an offline function
call, or an operator standing in for a model says so in the same sentence,
and each file's closing section lists everything not exercised and why.

## Defect found

None. Both mechanisms specification §4.3/§4.4 describe (the `git-publish`
floor, live/resume transitions) behaved exactly as documented when driven for
real. The one gap found — bus-message delivery into agent history has no
path reachable from the readline surface without a completing model turn —
is not a defect: it is the documented design (§5.3: readline "has no idle
wake in v1"; delivery happens only at a completed turn's drain sites), and
this dispatch's contribution is confirming that by direct observation rather
than leaving it as an assumption.

## Reproducing this

`bun scripts/check-doc-links.ts` must report 0 broken links for this
directory and the rest of `docs/`. Beyond that, both scenario files are
written to be followed top to bottom on any machine with `bun` and `git`
available; nothing in either depends on network access, credentials, or a
specific host.
