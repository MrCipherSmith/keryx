# T16 review — health completeness and Shell CLI

## Scope and evidence

Reviewed AFC-05 `health-spec.md`, T12 change report, AFC-18 shell parser spec and implementation report, plus current health and shell sources. Stage 1 spec compliance was run before any Stage 2 logic/security pass.

Focused current verification: `bun test src/health/health-truthful-gate.test.ts src/health/dependency-audit-format.test.ts src/commands/health-incomplete.test.ts src/commands/shell-cli-validation.test.ts` — 28 pass, 0 fail. Raw evidence: `.metaproject/data/gdctx/raw/2026-09-06T12-09-58-359Z_run.log`; summary: `.metaproject/data/gdctx/artifacts/2026-09-06T12-09-58-359Z_run.md`.

## Stage 1 — spec compliance

Shell AFC-18: PASS for the covered contract. Help and parser errors precede version/provider/session/UI startup; unknown, missing, empty, invalid, conflicting flags return actionable usage errors; valid aliases and last-flag-wins behavior remain covered. The real CLI fixture covers `--help`, `-h`, typo and missing provider without credentials or project writes.

Health AFC-05: FAIL with one major finding below. Required coverage and findings are separate, required incomplete sources cannot PASS, source filters remain visible, supported Bun/npm formats and unknown top-level JSON are covered, and strict incomplete exits are covered. The decoder still accepts malformed data inside recognized npm containers as a clean result.

## Finding

### F-001 — malformed recognized audit entries are silently accepted as clean

- Severity: major
- File: `src/health/sources/dependency-audit.ts:36-41` and `:59-65` (legacy branch has the same skip behavior)
- Repro: call `dependencyAuditAdapter.validate(raw({ vulnerabilities: { "pkg": "malformed" } }, 0))`; it returns `{ valid: true, format: "npm-modern" }`, while `parse` returns zero findings. Likewise `{ advisories: { "1": "malformed" } }` validates as npm-legacy and parses zero findings. `{ vulnerabilities: [] }` is also accepted through the top-level Bun array fallback.
- Path: `decodeAudit` recognizes `vulnerabilities`/`advisories`, then `record(value)` returns null and the loop `continue`s. `runAdapter` sees valid parse, exit code 0 and no findings, records the source `available`/`parsed`; the gate therefore has no incomplete coverage reason and can report PASS for a required audit that did not have a parseable result.
- Impact: a malformed or unsupported dependency-audit payload can suppress an audit check without warning, violating AFC-05's requirement that unknown/malformed output at rc0 be incomplete rather than clean.
- Suggested fix: when a recognized npm container has any non-record package/advisory value, return `{ valid: false, error: ... }`; reserve the Bun package-array fallback for an object whose keys are package names and whose values are arrays, and reject reserved npm container keys with non-array values.
- Confidence: high

## Stage 2 gate

Per the review workflow, Stage 2 logic/security review is blocked because Stage 1 has an unresolved spec finding. No Stage 2 verdict is claimed.

## Routing audit

`graph_used: yes` (affected health dependency context; treated as stale where uncommitted files were reported); `wiki_used: yes` (Metaproject index/context and supplied health/shell specifications); `ctx_used: yes`; `raw_rg_used: no`.

