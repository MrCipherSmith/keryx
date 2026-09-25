# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A reference document - a rules file, a skill or a project skill, given by path - is split deterministically into clauses: each numbered or bulleted item under a heading becomes one clause with a stable id (heading slug plus index), its text, and its heading path; no model call is needed for this, and a test pins the ids for an invented document.
- AC2: Each clause is tagged `state_kind: "pr" | "report" | "hunk"` and `checkable: true | false` with a reason when false (e.g. a live or manual step such as verifying on a running instance, or an obligation on the reviewer's process that no artefact records); tagging uses explicit markers when the document provides them and otherwise a single Jev `choice` per clause, cached by the document's content hash so an unchanged document is not re-tagged.
- AC3: `pr`-kind state is gathered through the existing GitHub port: title, body split into its named sections, changed files, and hand-written line counts that exclude mechanical bulk (lockfiles, generated, vendored, snapshots) using `src/review/scope.ts`'s drop reasons; deterministic facts (which named sections are present and non-empty, the size against a budget stated in the clause) are computed first and shown as evidence.
- AC4: `report`-kind state is an existing review package's `report.md` and `findings.json`, and deterministic facts are computed first (which fields each finding records, such as severity, evidence and a file anchor; the report's sections and their order); `hunk`-kind state reuses `buildReviewScope`'s blocks.
- AC5: For every checkable clause keryx asks Jev a `noul` question - does the state satisfy this clause - with the deterministic facts for that clause placed above the redacted state in `state`, within the 64k budget, batching clauses of the same kind; a fact that alone decides a clause is reported as deterministic evidence with Jev's answer shown beside it.
- AC6: `keryx review conform --ref <doc> [--pr <n> | --report <dir> | --diff <ref>] [--explain] [--json]` prints, per clause: id, kind, checkable or not-checkable (with the reason), the deterministic evidence, and Jev's probability; clauses whose kind has no state supplied are listed as not evaluated; not-checkable clauses are always listed, never dropped.
- AC7: With `--explain`, each clause scored below a threshold (default 0.5, configurable) is explained by the model the routing table assigns to the `review` category (the session model when unset), citing the clause id and the evidence; the explanation is labelled advisory and nothing is written to the PR or to `findings.json`.
- AC8: `/conform` in the shell opens a modal: pick a reference document (recent ones remembered) and a target (the current branch's PR, a review package, or the working diff), then a list of clauses grouped by kind with status (satisfied, likely violated, not checkable, not evaluated) and a detail view with evidence and the explanation.
- AC9: Conformance is opt-in per project (`review.jev.conform`, off by default) because PR text, reports and code leave the machine; with it off, or with no OpenRouter credential, the command refuses before any network call, and the state is redacted before it is sent.
- AC10: All committed fixtures and tests use invented reference documents and invented clause text; no real reference document's wording, name or path appears in the repository.
- AC11: A live check against a real private reference document and a few real PRs of this repository is run locally, its results (per-clause verdicts and cost, no document text) are recorded in the flow journal, and the docs state the measured usefulness and limits honestly.
- AC12: `keryx review conform` and `/conform` are in the command registry, `HELP_GROUPS` and the CLI reference, in English; CI is green on the pull request and `keryx health run` passes before merge.
