# Acceptance Layer — Implementation Plan

Version: 0.2.0

## Shape

Six workstreams. Only W0 is implementation-ready. Each later workstream sits
behind a decision gate that reads a measurement, not an opinion.

| W | Workstream | Size | State |
|---|---|---|---|
| W0 | Verification kind per criterion, at the source | small | spec ready |
| W1 | Runner for `exec` / `invariant`, and the right to gate | small | behind gate G1 |
| W2 | `keryx eval` — a gate for probabilistic behaviour | medium | behind gate G2 |
| W3 | Portable conformance report | medium | behind gate G1 |
| W4 | docpack ↔ flow loop, and attachment to a ticket | large | behind gate G3 |
| W5 | Outcome criteria in the PRD contract | small | ships with W0 |

## W0 — the only one to start now

Scope is in [specification.md](specification.md). One flow, one PR.

Sequence inside the flow:

1. Parser and records, pure, with the corpus test (AC3) written first — it
   proves the format is backward compatible before anything else is touched.
2. `flow ac kinds` read-only command.
3. `flow freeze` distribution block and the derived `acKinds` field.
4. `ac update` re-seal path.
5. `governance report` coverage column.
6. Rule and docpack Verify-phase change.

Steps 1–3 are independently useful: if the flow stops there, the project has a
parser, a report and a distribution, and nothing is half-built.

## W5 — ships with W0, not after it

W5 is a rule change in `requirements-package-standard.mdc` and one more check in
the docpack Verify phase. It has no code and no gate of its own, and it belongs
with W0 for one reason: both make an unverifiable thing declare itself rather
than hide. Splitting them would ship half a principle.

It is listed separately only because it is measured separately — the share of
packages carrying a non-empty outcome list, before and after.

There is no decision gate on W5. If outcome lists turn out to be universally
`not measured`, that is itself the finding, and it is a finding worth having in
writing rather than a reason to withdraw the rule.

## Decision gates

### G1 — after W0 has run on at least ten flows

Read the freeze distributions.

- **`exec` + `invariant` ≥ 20 % of new criteria** → build W1. There is enough
  runnable acceptance for a runner and a gate to matter.
- **Below 10 %** → do not build W1. Build W3 instead: if almost nothing is
  runnable, the value is in making the distribution legible to a human, not in
  automating a gate that fires twice a year.
- **Between** → W3 first, re-read after ten more flows.

The gate exists because the runner is the more interesting thing to build and
will therefore be argued for regardless of the numbers.

### G2 — after the first flow whose criteria include a probabilistic feature

W2 is built only when a real criterion needs it, not in anticipation. The
trigger is a criterion that cannot be `exec` because the behaviour is
non-deterministic, and would otherwise be forced to `judged` or `none`.

Note that `shared-agent-context-evaluation-orchestration` evaluates SAC and
coordination themselves. W2 is for product features built by a keryx user.
Different addressee; the packages must not be merged.

### G3 — after W3 exists

W4 links a requirements package to a flow. Linking a PRD to criteria that carry
no kind only doubles the prose, so W4 waits for W0 to be in use and W3 to render
the result.

## Order relative to the existing roadmap

The agreed order recorded in `keryx-p0-improvements` is: audit-remediation R3 →
audit-remediation R4+R5 → W1 external agents → W2 `/rewind` → W3 review as a
GitHub Action → W4 remote approval. That order is not changed by this package.

W0 is small and touches only `src/flow/`, so it can be slotted where it does not
contend with audit remediation. The report's transport to a pull request belongs
to that package's W3 and must not be duplicated here.

## What would stop this programme

- W0 ships and the kind distribution shows ~100 % `unclassified` on new flows:
  the slot is there and nobody fills it. Then the assumption that the discipline
  only lacked somewhere to land was wrong, and no further workstream follows.
- W0 ships and everything is declared `exec` while nothing is ever run: the
  marker became a ritual. G1 must read the distribution together with W1's later
  refusal count, not the distribution alone.
