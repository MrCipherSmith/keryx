# Implementation Plan

Status: DRAFT — not frozen. The operator reads the PRD and the criteria first.

## Approach

Diagnosis first, then the smallest contract fixes, then one live rerun. The 4-of-19 gap has four
causes (description.md); three are product or contract defects with a deterministic fix, one (depth of
a read-only static review) is a lever that is only proposed here. Counts decide: the attribution table
(AC6) is written before any depth lever is touched, and AC7 keeps tier, blast-radius cap and reviewer
tools out of this flow.

Alternatives rejected: raising the tier or the blast-radius cap now (would mix a model effect into
a driver defect and make the rerun unreadable); loosening the `review complete` gate (it refused for real
reasons — a major with a surviving mutant, unresolved rule evidence).

## Steps

1. Attribution: classify the 19 reference items by cause from the run's artefacts (read-only), write
   the anonymous table (AC6).
2. `retry-plan` reads `slices` as ids or `{id, ...}` objects; define `slices` in the reviewer output
   schema and the prompt (AC1, AC2).
3. Driver `definition`: document the key in the dispatch step, or resolve from `skill_path` (AC3).
4. Raw triage: a raw file with no `REVIEW_RESULT` is named and set aside, never silently blocking (AC4).
5. `keryx review diagnose` (read-only) and its TUI surfaces: the Review depth tab, `/reviews` text,
   the sidebar count, `/help` (AC5, AC8).
6. Docs, CLI reference, CHANGELOG, typecheck, lint (AC8, AC9).
7. Release once the batch is ready, then `keryx update` in the bench project and the live rerun (AC10).

## Risks

- Accepting objects in `slices` could mask a real stall if an entry has an id but no coverage; the
  decision keeps the progress-aware rule (a result that covers no new slice twice is still `not-run`).
- Resolving rules from `skill_path` could read a path outside the package; it must stay inside the
  project roots the ledger already allows.
- The rerun is one sample on a private bench; the table of AC6 is what survives it.
- Postponed control run (AC10 of flow 428) must not start before this flow reports.
