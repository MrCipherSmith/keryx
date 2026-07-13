# Flow 010 — W16 Release 0 release-evidence (E-01…E-03)

Status: formalized
Source: user description (harness runbook, Phase 16 at the Release 0 boundary)

## Problem

Release 0 is achieved (W1–W7) but has no consolidated release-evidence: no
capability/evidence matrix tying each capability to its source + test + commit,
no normalized managed review of the assembled slice, and no flow-orchestrator
handoff. W16 (E-01…E-03) produces that evidence at the Release 0 boundary.
Docs + reviews only — no new runtime code.

## Expected Outcome

- **E-01 (docs)** — a capability/evidence matrix (implemented/planned/deferred +
  source path + test file + commit), an updated `research-ledger.md`, migration
  notes, and a package index; the two deferred `@release-0` scenarios explicitly
  marked.
- **E-02 (review)** — a normalized managed review package of the Release 0 slice
  across 7 lenses (architecture, contract, logic, security, testing/replay,
  performance, Gherkin) with severity-ranked findings; the per-wave reviews are
  not touched.
- **E-03 (docs)** — roadmap/package promotion + a `flow-orchestrator-handoff.md`
  (DAG, frozen AC proposal, gates, constraints, out-of-scope, deferred) created
  ONLY if E-02 shows no BLOCKER/P0/P1.

## Out of Scope (do NOT touch)

- Any wave/feature other than W16. NO new runtime code (`src/harness`,
  `src/contracts`, `src/eval` unchanged).
- The frozen requirements package (`docs/requirements/…`) and the existing frozen
  ADR-0001…0004 — read/cite, never edit. (Our own `research-ledger.md` /
  `decision-registry.md` MAY be updated — they are W-decision artifacts.)
- No new production dependency; no test changes (the 797/0 suite stays as-is).
