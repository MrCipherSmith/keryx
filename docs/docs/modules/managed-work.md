# Managed work: flows, jobs, review

Managed work turns a task into a record in the repository: frozen acceptance criteria, ordered tasks, a journal, signed confirmations, and review packages that outlive the branch. It removes the gap between "an agent said it was done" and "someone can check what done meant, and who agreed".

## When to use it

- You hand a non-trivial change to an agent and want the finish line written down before it starts, and unchangeable afterwards.
- You need the record of what was decided, tried and reviewed to survive the pull request and the branch.
- A flow must not be marked complete until its pull request is green, its tasks are closed, its health gate passes and a clean review round was observed.
- You want a repeatable step list for an analysis, implementation or review job, with a recorded status per step.
- You want each pull request reviewed by a bot that posts one review and stores every finding.

## Quick example

Run this in a scratch repository after `keryx init --yes`.

```bash
keryx flow init --title "Add a --json flag to status"
# write criteria into the flow's acceptance-criteria.md, then:
keryx flow freeze 001
keryx flow start 001
keryx flow ac confirm 001 <ACn> --note "checked"
keryx flow implemented 001 --pr https://github.com/acme/app/pull/1
keryx flow complete 001
```

```text
  ✓ Flow 001 → ready
  ✓ Flow 001 → in-progress
  ✓ Confirmed … (1 total)
  ✓ Flow 001 → implemented (PR: https://github.com/acme/app/pull/1)

✗ flow complete: returned to in-progress
  ✗ acceptance-criteria (unconfirmed: …)
  · pull-request (tracker unavailable; verify PR checks manually)
  ✗ tasks (not done: …)
  ✗ owner (no owner set; run `keryx flow owner set <id> --owner "<name>" --reason "<why>"`)
  ✗ review (5 of 5 conditions failed — ingested-round (unobserved): …)
  ✗ health (no report; run `keryx health run` first)
  ✓ security (security advisory: informational (advisory does not block))
  · confirmation (confirmation gate not enabled for this flow; …)
```

`complete` refusing is the point: it names every gate that still fails and what to run for each.

## How it works

**Lifecycle.** A flow moves through `initializing`, `ready` (after `freeze`), `in-progress` (after `start`), `implemented` (after `implemented --pr <url>`) and `completed`. `init` creates a directory under `.metaproject/flows/` with the description, plan, context, acceptance criteria, tasks, journal and `flow.json`. `freeze` records a checksum of `acceptance-criteria.md`. After that, any edit outside `keryx flow ac update` fails every gate and every status transition, and an `ac update` voids earlier confirmations. Tasks have a kind (`context`, `implement`, `test`, `verify`, `review` or `docs`), can depend on one another, and are closed with a disposition (`completed`, `blocked`, `failed` or `skipped`) and a reason. `flow next` names the first open task whose dependencies are done.

**Completion gates.** `flow complete` evaluates these gates in order. Every one must report something other than `fail`, and `skipped` counts as a pass for a gate that does not apply to the flow:

| Gate | Passes when |
|---|---|
| acceptance-criteria | the checksum is intact and every `ACn` is confirmed |
| pull-request, or main-merge | the PR exists with green checks, or the commit is proven to be on `origin/main` |
| base-branch | the merge landed on the base branch the flow recorded |
| tasks, owner, review | on for every new flow: no open task, an accountable owner, and a clean review round actually observed (flows created before these gates existed skip them) |
| health | the [health gate](quality.md) passes |
| security | the security gate does not fail (advisory by default; omitted if the module is off) |
| confirmation | opt-in with `--require-confirmation`: a terminal-minted, single-use token for this criteria checksum |

Each attempt, pass or fail, is recorded with its gate outcomes. A flow left in `completing` goes back with `flow recover`.

**Signatures.** `flow ac confirm` and `flow complete` record who signed: `--signed-by`, else `KERYX_ACTOR`, else the local git identity, else `unknown`. Each is labelled stated or derived. None proves a person signed, because a flag, an environment variable or a git identity can be set by an agent. `--owner` is never inferred.

**Job packages.** `keryx job` keeps a step list under `.metaproject/jobs/<name>` for an `implement`, `analyze`, `review` or `custom` intent: `init`, `status` (names the next open step), `step` to set a step's status, `document` to attach an analysis, report, review or verification file, and `complete`.

**Review packages and the PR bot.** `keryx review` creates a package with scope, findings, decisions and learning candidates, standalone or attached to a flow. `keryx review bot` and the repository's GitHub Action review each same-repository pull request, drop findings a second turn refutes, and post one review. See [Review with a durable record](../guides/review-with-a-record.md) and [Review as a pull request bot](../guides/review-as-a-pr-bot.md).

## Common tasks

| I want to… | Command or page |
|---|---|
| Start a flow from an issue or a title | `keryx flow init --issue <url>` or `--title "<t>"` |
| Lock the criteria and begin work | `keryx flow freeze <id>`, `keryx flow start <id>` |
| Add and order tasks | `keryx flow task add <id> --title "<t>" --depends <task-id>,<task-id>` |
| See what to do next | `keryx flow next <id>`, `keryx flow status <id>` |
| Confirm a criterion with evidence | `keryx flow ac confirm <id> <ACn> --note "<evidence>"` |
| Check the diff against the criteria (advisory) | `keryx flow check-ac <id> --pr <n>` |
| Record an accountable owner | `keryx flow owner set <id> --owner "<name>" --reason "<why>"` |
| Close the flow | `keryx flow implemented <id> --pr <url>`, then `keryx flow complete <id>` |
| Run an analyze, implement or review job | `keryx job init --name <slug> --intent implement` |
| Review a branch and keep the record | [Review with a durable record](../guides/review-with-a-record.md) |
| Review pull requests automatically | [Review as a pull request bot](../guides/review-as-a-pr-bot.md) |
| Use the optional review-service checks | [Use review-service checks in the delivery loop](../guides/jev-in-the-delivery-loop.md) |

## Status

Flows, frozen criteria, completion gates, signatures and review packages are stable. Job packages are available in every project. The review-service checks are experimental, and the pull request bot has been tested with injected fakes, so try it on a scratch repository first.

## Reference

- CLI reference: [flow](../cli-reference.md#flow), [job](../cli-reference.md#job), [review](../cli-reference.md#review)
- [Workspace and lifecycle](../workspace-and-lifecycle.md)
- [Built with Keryx](../project/built-with-keryx.md): the committed record of this repository's own flows
- [Write a rubric eval scenario](../guides/write-a-rubric-scenario.md)
