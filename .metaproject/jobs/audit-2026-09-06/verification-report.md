# Verification evidence

## Current source health

Command: `keryx ctx run -- bun ./src/cli.ts health run --strict --source eslint,typescript,dependencyAudit,complexity`

Normalized result: `Code Health: PASS`, project score 93, 237 findings, all P2 complexity, gate pass. Current report was generated at `2026-09-05T21:03:03.251Z` at git `d0a2a01`.

Sources: eslint skipped (required); typescript available, 0 findings; dependencyAudit available, 0 findings; complexity available, 237 findings. Tests and coverage were intentionally omitted from this health invocation to avoid rerunning the full test suite; the full test result is referenced below. Coverage is n/a and the health report reports 10 wiki pages needing attention.

## Current dependency audit cross-check

Command: `keryx ctx run -- bun audit --json`

Normalized command result: rc 1, 28 advisories including critical/high severities. This conflicts with health's dependencyAudit 0 findings. The adapter source at `src/health/sources/dependency-audit.ts:54-69` parses only `vulnerabilities` or `advisories` maps; the current Bun JSON is package-keyed arrays. Therefore health PASS must not be interpreted as a clean dependency state.

## Existing test and typecheck evidence

Full test raw: `.metaproject/data/gdctx/raw/2026-09-05T20-58-58-202Z_run.log`

Full test summary: `.metaproject/data/gdctx/artifacts/2026-09-05T20-58-58-202Z_run.md`

Full result: 6897 pass, 18 skip, 0 fail, 562 files, 149.10 s.

Typecheck raw: `.metaproject/data/gdctx/raw/2026-09-05T21-02-48-994Z_run.log`

Typecheck summary: `.metaproject/data/gdctx/artifacts/2026-09-05T21-02-48-994Z_run.md`

Typecheck result: `tsc --noEmit` exit 0.

Health raw: `.metaproject/data/gdctx/raw/2026-09-05T21-03-03-280Z_run.log`

Health summary: `.metaproject/data/gdctx/artifacts/2026-09-05T21-03-03-280Z_run.md`

Audit raw: `.metaproject/data/gdctx/raw/2026-09-05T21-03-23-012Z_run.log`

Audit summary: `.metaproject/data/gdctx/artifacts/2026-09-05T21-03-23-012Z_run.md`

No source changes or remediation were made.
