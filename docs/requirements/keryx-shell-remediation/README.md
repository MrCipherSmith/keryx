# Keryx Shell Remediation Requirements Package
Version: 0.1.0

## Status

Specification ready; no implementation has started and no runtime claim is made.

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

- [PRD](prd.md) — problem, users, requirements, success criteria, risks, and recommendation.
- [Specification](specification.md) — the three phases in detail, with acceptance criteria per phase.
- [Implementation Plan](implementation-plan.md) — phase ordering, flow grouping, and what each flow must not do.

## Scope

Six defects (D1–D6) from the run report, grouped into **three flows** rather than
six. The grouping is by shared test surface, not by convenience: each phase is
verified by one coherent scenario, so splitting it further would mean testing the
same thing twice.

| Phase | Defects | The one sentence it must make true |
|---|---|---|
| **P1 — the agent can finish** | D1, D2 | A scripted read-only question is answered through the native tool, with no human touching the terminal. |
| **P2 — the scriptable door is real** | D3, D4, D5 | `keryx harness run` can do tool work, against any provider the registry declares. |
| **P3 — re-measure** | D6 | The benchmark runs to completion on a corrected catalog, and says what it finds. |

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
