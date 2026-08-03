# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Enumerate the three classes and record the method for each |
| T2 | implement | F-015: positive heading identification in the ingest parser |
| T3 | implement | F-014a: loadArchive falls back and reports the degradation |
| T4 | implement | F-014b: guard the two unguarded transcript-reader callers |
| T5 | test | F-014c: source-level guard over the caller class |
| T6 | test | F-013a: widen the AC8 extractor to the whole instruction class |
| T7 | test | F-013b: cover the refusal-by-design instruction with its own test |
| T8 | docs | Correct flow 130's journal claim about the readers guard evidence |
| T9 | review | Verify: focused tests, full suite, typecheck, lint, health |
| T10 | review | Self-review the diff against the three findings; draft PR |
</content>
