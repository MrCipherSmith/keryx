# T20 implementation report — recursive security scan

## Result

T20 implements bounded file and directory security scanning with explicit coverage. A scan now records its authorized scope, exclusions, limits, and per-file outcomes. A finding threshold failure remains `fail`; incomplete traversal is reported as `incomplete` only when findings are otherwise clean. `SecurityGate` and the CLI exit paths carry the incomplete state.

The shared contained reader is used for every file read. The traversal resolves and pins canonical identities, follows internal symlinks once, refuses external targets without exposing their target names, and terminates cycles. Directory, depth, file-count, and aggregate-byte limits are bounded. A file that cannot be read does not discard findings already collected from earlier files.

The existing service redaction and serialized-output validation paths were preserved. An unexpected service check error now yields an incomplete warning result instead of a fabricated pass. `runGate` preserves an incomplete report as `status: "incomplete"` for the owning guard integration.

## Acceptance evidence

| Criterion | Status | Evidence |
|---|---|---|
| Nested directory recursion, internal canonical duplicate once, cycle termination | met | `src/commands/security-recursive-scan.test.ts`, 3/3 passed; raw `.metaproject/data/gdctx/raw/2026-09-06T12-45-10-870Z_run.log` |
| External/unreadable/limited entries produce incomplete coverage while retaining findings and hiding unauthorized targets | met | Same focused suite, including external symlink and `--max-files`; no external target name/content appears in report assertions |
| Reports expose scope/exclusions/limits and per-file scanned/skipped/failed outcomes with truthful statuses | met | `SecurityReport`/schema/report renderer plus command tests; source typecheck and focused security suite pass |

## Verification

- Typecheck: pass, `bun run typecheck`; raw `.metaproject/data/gdctx/raw/2026-09-06T12-46-34-667Z_run.log`.
- Owned lint: pass for all T20 source/test files; raw `.metaproject/data/gdctx/raw/2026-09-06T12-46-27-636Z_run.log`.
- Source bundle: pass for `src/commands/security.ts`; raw `.metaproject/data/gdctx/raw/2026-09-06T12-46-46-082Z_run.log`.
- Focused recursive scan: 3 passed, 0 failed, 18 assertions; raw `.metaproject/data/gdctx/raw/2026-09-06T12-45-10-870Z_run.log`.
- Focused security/guard/persistence/harness/recursive selection: 53 passed, 0 failed, 155 assertions; raw `.metaproject/data/gdctx/raw/2026-09-06T12-45-39-211Z_run.log`.

The broader selected security run remains 58/59 because the pre-existing `src/security/service.memo.test.ts` expectation fails in isolation at line 162; raw `.metaproject/data/gdctx/raw/2026-09-06T12-41-02-112Z_run.log`. This test is outside T20 ownership and was not modified. No global suite, network, model, or external socket was used.

## Changed files

- `src/security/path-scan.ts`: bounded canonical traversal and coverage model.
- `src/security/service.ts`: path scan aggregation, incomplete propagation, and scan artifacts.
- `src/security/types.ts`, `src/security/schemas.ts`: additive scan metadata and incomplete gate schemas.
- `src/security/report.ts`: scan metadata in JSON and Markdown artifacts.
- `src/commands/security.ts`: recursive scan flags, safe target/exclusion parsing, and incomplete exits.
- `src/commands/security-recursive-scan.test.ts`: T7 RED scenarios are now green.

## Routing audit

`graph_used: yes (stale graph acknowledged); wiki_used: yes; ctx_used: yes; raw_rg_used: no.`
