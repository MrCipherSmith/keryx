# Keryx Shell Remediation Requirements Package
Version: 1.0.0

## Status

**Ready to implement.** Specification complete, reviewed against code, and broken
into three agent-runnable flow dispatches. No implementation has started and no
runtime claim is made.

Start here: [`implementation/`](implementation/README.md) — one dispatch per flow,
each with the flow commands, the acceptance criteria to paste before freezing, the
exact files, and the definition of done.

Source: [the benchmark run of 2026-08-05](../keryx-shell-benchmark/run-2026-08-05.md),
which halted after 5 of 26 cases because it had already found two defects every
remaining case would have re-measured.

## Purpose

Make the keryx agent able to finish a task.

That is the whole of it. The benchmark did not find that keryx is slow, or that
its workspace is useless. It found something narrower and worse: **on the one
structural case that ran, keryx was the only leg of seven that produced no
answer** — not because the capability was missing, but because the agent reached
past its own registered graph tool for a shell call it was never going to be
allowed to make. And it found that no keryx run can complete unattended at all,
because there is no way to say so from the command line.

Both are reachability defects. Neither needs new capability built.

## Document Index

- [**Implementation dispatches**](implementation/README.md) — three flows, each executable end to end under the project's flow rule.
- [PRD](prd.md) — problem, users, requirements, success criteria, risks, and recommendation.
- [Specification](specification.md) — the three phases in detail, with acceptance criteria per phase.
- [Implementation Plan](implementation-plan.md) — phase ordering, flow grouping, and what each flow must not do.
- [Phase 4 — the tool surface](tool-surface.md) — the finding that reverses D1: `graph_affected` takes no `depth`, so A1's question was **unanswerable** through the native tool and the model was right to shell out. Plus the seven group-A questions with no tool at all, and the composite call that collapses six round trips into one.
- [Review 2026-08-05](review-2026-08-05.md) — the package checked against code, the report and the docs. Two blockers found and folded in: D1's root cause is a single instruction line, and there are two divergent system prompts.

## Scope

Six defects (D1–D6) from the run report, grouped into **three flows** rather than
six. The grouping is by shared test surface, not by convenience: each phase is
verified by one coherent scenario, so splitting it further would mean testing the
same thing twice.

| Phase | Defects | The one sentence it must make true |
|---|---|---|
| **P1 — the tool surface answers** | D1, P4.1 | A structural question is answered through the native tool, and no tool is weaker than the CLI verb it wraps. |
| **P1b — unattended posture** | D2 | **Descoped 2026-08-05** to [keryx-unattended-posture](../keryx-unattended-posture/README.md) after three review rounds. See below. |
| **P2 — the scriptable door is real** | D3, D4, D5 | `keryx harness run` can do tool work, against any provider the registry declares. |
| **P2b — the tool surface** | P4.2, P4.3 | Every question group A asks has a tool, and the common one takes a single call. |
| **P3 — re-measure** | D6 | The benchmark runs to completion on a corrected catalog, and says what it finds. |

## Why P1 was split

P1 originally paired D1 and D2 on the argument that either alone leaves the
scenario unprovable. That argument was correct and the pairing still cost more
than it bought: three review rounds each found the unattended half letting
something through, while the D1 half was clean after the first.

The rounds are not wasted — they are the evidence base of the new package, and
they established something worth more than the feature would have been: the
containment cannot be a list of forbidden command words. Three rounds tried,
three rounds were defeated by a word obviously in a category already banned.

D1's half ships on its own. It unblocks the P3 re-measurement, which is the only
thing that was actually waiting.

## Non-Goals

- Weakening the policy engine. P1 adds a way to *declare* an unattended posture;
  it does not add a way to bypass a `deny`. A destructive action must still fail
  closed under every mode this package introduces.
- Changing the graph, wiki, memory or health implementations. Every capability
  the benchmark probed already exists and works.
- Making a performance claim. The run made none, and nothing here authorises one.

## Related Modules

- `harness` — the run loop, tool registry, and policy engine ([page](../../docs/harness.md)).
- `session` — the interactive shell the agent runs in.
- `metrics` — where a re-run's evidence lands.
- `keryx-shell-benchmark` — the source of every requirement here, and the thing
  that verifies P1 and P2 once they land.
