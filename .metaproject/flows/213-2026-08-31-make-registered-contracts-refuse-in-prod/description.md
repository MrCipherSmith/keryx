# Make registered contracts refuse in production

## Problem

Eleven contracts are registered in `src/gdskills/contracts.ts`. Four of them
refuse a bad value in production. Seven cannot refuse anything, because nothing
loads them outside a test or an explicit `keryx skills contracts validate`
invocation an agent has to remember to type.

Established by enumeration over the registry, not by impression — for each name,
which non-test `.ts` file mentions it:

| Contract | Refused in production by |
|---|---|
| `review-finding` | `src/review/managed.ts:1443` (ingest), and the disposition schema at `:1258` |
| `subagent-dispatch` | `src/harness/child/{spawn,contract}.ts`, `src/harness/extension/execute.ts` |
| `subagent-result` | `src/harness/external/runtime.ts:424`, and the two above |
| `job-orchestrator-state` | `src/job/store.ts:81` (`writeJob` refuses to write) |
| `agent-event` | nothing |
| `orchestrator-state` | nothing |
| `task-implementer-input` | nothing |
| `task-implementer-output` | nothing |
| `flow-orchestrator-input` | nothing |
| `review-pr-feedback-input` | nothing |
| `review-pr-feedback-output` | nothing |

The last three were registered in PR #424 (merged as `bfaf3b16`) precisely so a
validator could be pointed at them. That was worth doing — before it,
`keryx skills contracts validate --schema review-pr-feedback-input` exited with
a usage banner. It is not the same as an enforcement: the skill says "Validate
before dispatching", which is an instruction, and an agent that skips it sees
nothing.

## Why the four that work, work

Not diligence — position. `writeJob` validates because keryx itself writes the
file. The harness validates `subagent-dispatch`/`subagent-result` because keryx
itself spawns the child. In both, keryx code sits on the path and can refuse.

`flow-orchestrator-input` describes a payload one AGENT hands another. In a
session driven by a host agent's own dispatch tool, no keryx process is in that
path, so there is nothing to do the refusing. `enforcement-claims.test.ts`
already records this for `reviewer-input`: "reviewer dispatch is a host-agent
action rather than a `keryx` invocation, so there is no point at which a
malformed dispatch could be refused." The same comment sits beside the
`task-implementer` registration, noting five `ASSERT … → ABORT(…)` refusals its
skill lists that nothing could perform.

So this is a known, twice-recorded structural gap, and PR #424 added three more
members to it while closing a different problem.

## Expected outcome

A registered contract either refuses in production at a named point, or the
tree states plainly that it cannot and why — with a guard that fails when a new
registration adds a member to the second group silently.

## Out of scope

- Rewriting how any harness dispatches subagents.
- `ARCH F-108` from the #424 review (the flow record carries no base branch, so
  `keryx flow complete` cannot compare a merge target to the base a dispatch
  named). Same review, different subject, its own flow.
- Adding new contracts.
