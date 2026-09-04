# Plan

## Chosen approach

**Health reads, it does not compute.** The metric is lifted from
`data/wiki/freshness/latest.json`. Running a graph traversal inside
`health run` would make a fast command slow and would couple two subsystems
that currently only share a file.

**Absence must be loud.** The failure this design is most exposed to is a
missing report reading as a clean one. So the metric is either present with a
number, or absent with a stated reason — never zero-by-default.

**The gate stays untouched.** LWG-15 says so, and `ci-protocol.md` explains
why: a blocking freshness check invites updating a page so CI passes, which
manufactures filler faster than drift manufactures staleness.

## Steps

1. `HealthReport.wikiFreshness?` — additive and optional, exactly as
   `hotspots?` was added.
2. A reader that parses `latest.json`, tolerates damage, and reports staleness
   of the report itself (a month-old report is not current evidence).
3. Render it in the health artifact and the dashboard line.
4. A CI workflow per `ci-protocol.md` §6.
5. Tests, including the absent-report and stale-report cases.

## Rejected alternatives

- **Recomputing freshness inside `health run`.** Rejected: slow, and it would
  make `health` depend on the graph being built.
- **Defaulting the ratio to 1.0 when no report exists.** Rejected outright —
  this is the exact shape of the bug the package keeps finding in itself.
- **Failing the gate on stale pages.** Rejected by LWG-15 and by
  `ci-protocol.md`; a project may opt in, and that stays its decision.

## Risks

- A stale `latest.json` is worse than none if presented as current, so its
  age is reported alongside it.
- The denominator excludes undecidable pages; that must be visible, or the
  ratio flatters itself by hiding the pages it cannot judge.
