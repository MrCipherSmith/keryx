# T34 migration boundary repair

STATUS: DONE

Frozen paths:

- `deploy/team-hub/migrate-legacy.py`
- `deploy/team-hub/release/migrate-legacy-boundaries.test.py`

Read-only adoption readiness now inspects the queue schema. A table without a JSON body column conservatively counts every row as unresolved. For a JSON queue, only known terminal `applied`, `rejected`, and `removed` states stop blocking adoption. Missing, malformed, null, queued, suspended and admitted entries remain unresolved.

RED: three actual errors (missing body column and malformed JSON), raw `04-58-22-865Z-dd07d9`. GREEN: migration14, boundaries29, profile5 and Bun wrapper4 tests; all pass. Python syntax and whitespace checks also pass. Counts overlap because the boundary class inherits migration tests and the wrapper invokes Python; do not sum them as unique cases.

Exact commands and full raw paths are pinned in `/tmp/pr1113-r02-migration-boundary-results.json`. No commits, deployments or original review-package edits.
