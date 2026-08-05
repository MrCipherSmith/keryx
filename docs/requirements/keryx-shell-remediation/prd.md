# Keryx Shell Remediation PRD
Version: 0.1.0

## Problem

On 2026-08-05 the shell benchmark ran five cases against a real project with a
populated `.metaproject/` workspace, across seven agent legs. The result for
keryx was the worst possible one, and not for the reason anybody expected.

**On the flagship structural question — "what breaks if I change this export?" —
keryx was the only leg of seven that produced no answer.** opencode answered in
93 seconds. Claude Code with no workspace at all answered in 73, having written
its own reverse-dependency program to do it. Grok answered twice, with and
without the workspace, four seconds apart. keryx spent 62,000 tokens of context
and returned nothing.

The cause is not a missing feature. `graph_affected` is registered in the shell's
tool registry and would have answered the question directly. The model called
`shell_exec("keryx gdgraph affected config.ts --depth 2")` instead — its own CLI,
through the one door that is default-deny — and stopped at the approval gate.

Underneath that sits a second defect that made the first one terminal: **there is
no way to run `keryx shell` unattended.** `claude` has `--permission-mode`.
`grok` has `--always-approve`. keryx has nothing. So the gate that stopped the
run could not be answered by anything except a human at a keyboard, and keryx
finished zero of five cases.

Two consequences follow, and the second is the expensive one:

1. Every measurement of keryx in that run is a measurement of a stall.
2. keryx cannot be put in CI, cannot be scripted, cannot be benchmarked — by us
   or by anyone evaluating it — and that is invisible from the documentation.

## Goal

Make a scripted, read-only question get a correct answer from keryx, through the
native tool, with nobody at the terminal — and keep every destructive action
failing closed while that is true.

## Users

| User | What changes for them |
|---|---|
| The maintainer | Can re-run the benchmark and get numbers about capability instead of numbers about a stall. |
| A CI pipeline | Can run an agent step at all. Today it cannot. |
| Anyone evaluating keryx | Stops concluding, correctly, that it does not answer. |
| The agent | Reaches the graph in one tool call instead of a shell round-trip through its own CLI. |

## Requirements

### R1 — the native tools must be the obvious first choice

For a structural, wiki, memory or health question, the agent must select the
registered metaproject tool rather than shelling out to the `keryx` CLI. This is
a prompt- and tool-description change, not a capability change.

A shell call whose command is the CLI equivalent of a registered tool is a
symptom worth detecting in its own right — the agent has taken a longer, more
restricted path to something it could do directly.

### R2 — an explicit unattended posture

A named, opt-in mode, settable from the command line, under which:

- pre-declared low-risk classes execute without prompting;
- an `ask` with no approver resolves to **deny**, never to allow;
- a `deny` stays terminal, exactly as today.

The policy engine already has the vocabulary (`allow`/`ask`/`deny` across seven
risk classes). What is missing is a way to state a posture at launch. The mode
must be loud in the UI and recorded in the run's evidence — an unattended run
that looks identical to a supervised one in the record is worse than no mode.

### R3 — the scriptable door must be able to do tool work

`keryx harness run` registers no tools, so the only door with tools is the
interactive shell. With R2 that becomes survivable, but the non-interactive path
should be able to carry a tool-using turn on its own.

### R4 — the provider list must come from the registry

`harness run` accepts `fake|anthropic|ollama` from a literal set while
`cli-reference.md` documents the OpenAI-compatible gateways as accepted. Either
the code or the docs is wrong; the code is. Read `OPENAI_COMPAT_PROVIDERS`.

### R5 — re-measure, and publish whatever comes out

With P1 and P2 landed, run the full catalog with the corrections the run report
names (C2 needs a planted secret; C4 needs the restricted profile; A6/A7 need a
target whose wiki has decision pages; the 106-vs-102 transitive count needs
adjudicating).

## Success criteria

| # | Criterion |
|---|---|
| S1 | A scripted structural question returns a correct answer with `human_interventions: 0` and a tool path containing the native graph tool. |
| S2 | Under the same mode, a destructive action still fails closed, proven by a test that asserts the refusal. |
| S3 | `keryx harness run` accepts every provider the registry declares, and the CLI reference matches the code. |
| S4 | The benchmark's group A completes on all legs, with a verdict per case. |
| S5 | No claim in the README or docs is widened by this work beyond what a test covers. |

## Risks

| Risk | Mitigation |
|---|---|
| **An unattended mode becomes a bypass.** The obvious implementation is a `--yes` that approves everything, and that would trade the one property the benchmark showed keryx has. | R2 is written as a *posture declaration*, not an approval. S2 exists to fail the work if a destructive action stops failing closed. The C-group cases are the regression suite. |
| **Tool-affinity work turns into prompt roulette** — tweaking wording until one model behaves, with no way to know it holds for the next. | The acceptance is a tool path assertion in a test, not an eyeball check. If it cannot be asserted, it is not done. |
| **The fix makes the agent prefer native tools even when shell is correct.** | The requirement is scoped to questions with a registered tool that answers them; nothing forbids shell for the cases only shell can serve. |
| **Re-measuring shows keryx still loses.** | Then that is the finding, and it goes in the report the same way this one did. The package's value does not depend on the answer. |

## Recommendation

Do P1 as one flow. D1 and D2 are a single story — "the agent can finish a task" —
and they share one verification scenario, so splitting them means building the
same test twice and shipping half a fix in between. P2 and P3 are separable and
should not block it.
