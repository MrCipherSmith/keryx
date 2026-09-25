# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx review conform` output reports ONE verdict per hunk-kind clause, not one row per hunk × clause: status (satisfied / likely-violated / not-evaluated), the number of hunks judged and how many were below threshold, the worst hunk (location + its Jev probability), and at most N (default 3, `--max-hunks`) further violating hunk locations; the full per-hunk detail stays available under `--json` (nested per clause) and `--detail`.
- AC2: The per-clause aggregate is a pure function in core (`src/review/`), unit-tested: a clause is likely-violated when any retained hunk falls below the threshold, satisfied only when every judged hunk is at or above it; ties and empty sets (no hunks → not-evaluated) are covered.
- AC3: Jev calls for hunk-kind clauses are bounded: a `--max-hunk-calls` budget (default chosen and documented, e.g. 40) caps hunk × clause questions per run; when the cap truncates, the report says which clauses were judged on a subset and how many hunks were skipped — never silently.
- AC4: The `/conform` modal shows the aggregated clause list (one row per clause) and the detail view lists the worst hunks with their evidence; unit/render tests updated.
- AC5: The default text report for a large PR fits a human read: on the committed invented fixture against a fixture diff with ≥10 hunks, the rendered report has at most one line group per clause (test-pinned line bound).
- AC6: CI triage leftovers from the PR #713 review: a test where a `runInfo` promise stored in `runInfoCache` rejects and every later job's lookup degrades exactly like the uncached path; the pagination case (triaged run missing from the same-head list) is documented as a known signal gap in `docs/docs/cli-reference.md` next to the job-name ambiguity paragraph; the facade-import comment in `src/review/ci-triage.ts` states the real reason (consistency with the security facade), not an import-policy rule it does not trigger.
- AC7: Docs: `docs/docs/cli-reference.md` `review conform` section documents the aggregated output, `--max-hunks`, `--max-hunk-calls`, `--detail`; HELP_GROUPS/commands-by-task regenerated if help text changes; invented fixtures only — no text from any private document.
- AC8: Live check (run with `env -u OPENROUTER_API_KEY`) of the aggregated report on a real merged PR of this repo with ≥10 hunks, using the invented fixture document: report line count, Jev calls and cost before (0.2.164 behaviour) vs after, journaled; no private document is used in this flow.
- AC9: CI green on the PR; `keryx health run` passes; hermetic, macOS-safe tests; import zones respected.
