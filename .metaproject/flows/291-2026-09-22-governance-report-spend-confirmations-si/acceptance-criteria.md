# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx governance report` aggregates, per flow in the current project, review-round spend from every review package's `manifest.json` `cost` field (input tokens, output tokens, USD), summed across rounds. A figure is shown as a number only when at least one round recorded it; a flow where no round recorded cost reports `spend: not recorded`, never `0`; a flow with partial coverage reports the sum together with a rounds-with-cost / rounds-total count, never silently dropping the gap.
- AC2: The report shows trigger spend from `.metaproject/data/trigger/runs.jsonl` as a separate project-level figure: USD summed over runs whose cost was recorded, plus the count of runs whose cost was not recorded, reported as such and never counted as zero. A run record carrying no flow reference is never attributed to a flow, and the report says why. An absent ledger means no trigger has run; an unreadable one reports `not recorded` with the reason, never a guessed value.
- AC3: For each flow the report shows who confirmed each acceptance criterion and who signed its completion, from the flow's signatures joined with its confirmations, with every identity's basis (`stated`, `derived`, `unknown`) shown beside the name; a derived or unknown identity is never presented as a verified confirmation. A flow that predates signatures reports `confirmations: not recorded (predates signing)`, never an empty list read as nobody confirmed anything.
- AC4: `flow complete` persists the outcome of every gate it evaluated — name, status and detail, for passing, failing and skipped gates alike — on every completion attempt from now on, pass or fail, as an append-only additive field of the flow; it is no longer reduced to one prose history line. Existing `flow.json` files load, validate, pass `keryx flow check` and complete unchanged, with no new schema version, and the report shows `gate outcomes: not recorded` for attempts made before this change. Tests cover a failing attempt followed by a passing one, and a pre-change fixture.
- AC5: The report derives every figure only from what is already recorded — flow files, review manifests, the trigger ledger and, when present, the security artifact and the deletion journal. It never re-runs a gate, never calls a model or any network service, and never modifies anything it reads; the only files it writes are its own report artifacts. A test asserts no file under `.metaproject/flows/` or `.metaproject/data/trigger/` changes.
- AC6: The report writes `.metaproject/data/governance/artifacts/latest.md` and a schema-versioned `latest.json`, following the convention `keryx health run` uses, and a shape-guarded reader treats a missing or malformed stored report as no report yet rather than failing.
- AC7: The report can be filtered by `--flow <id>`, `--owner <name>` and a `--since`/`--until` date range applied to each record's own timestamp; each filter is tested against a fixture set and narrows the markdown and the json output consistently.
- AC8: The report covers the current project by default; `--all-projects` also covers every project in the user-global registry, and a registered project whose path is missing or unreadable is listed with a warning instead of failing the whole report.
- AC9: Policy allow/ask/deny decisions and unattended-run denials have no durable project-wide record today; the report lists them as `not recorded (no durable log exists yet)` rather than omitting the category.
- AC10: README and the CLI reference describe `keryx governance report`, its flags, where it writes, what it reads, the gate-outcome persistence, and the rule that a figure never recorded is reported as not recorded, never as zero.
- AC11: CI is green on the PR and `keryx health run` gate is pass.
