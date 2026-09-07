# T19 Change Report — Core Structural Output Validation

## Outcome

Implemented the pure `validateOutputForTransport({ value, format, schema? })` boundary and deterministic detector corrections. JSON-compatible outputs keep their shape and scalar types, string secrets are masked with leak-safe reasons, text and JSON string serialization remain distinct, and unsafe representations return the constant `Output withheld: format-unsafe` without the rejected value or a fingerprint.

The mandatory local text floor now also neutralizes inline Markdown images, reference images, and HTML images. Ordinary public links remain content rather than an egress operation; links carrying explicit sensitive URL locators and actual send operations remain detectable.

## Stable exports

`src/security/output-validation.ts` exports:

- `validateOutputForTransport`
- `OutputTransportFormat`
- `OutputRedaction`
- `OutputValidationInput`
- `OutputValidationResult`
- `FORMAT_UNSAFE_OUTPUT_TEXT`

Success is discriminated by `ok: true` and carries the safe `value`, serialized `text`, and `redaction.state` of `none` or `redacted`. Failure is discriminated by `ok: false` and carries only constant text plus `redaction.state: "format-unsafe"` and safe reason tokens.

## Behavior delivered

- Recursively validates arrays and plain objects before serialization.
- Preserves null, booleans, finite numbers, decimal metrics, numeric IDs, and safe strings.
- Preserves numeric-looking string IDs/metrics from the broad phone heuristic while continuing to detect provider-pattern secrets under any field name.
- Masks generic string credentials under explicit sensitive keys and rejects numeric credential fields as format-unsafe.
- Rejects cycles and values JSON cannot faithfully transport.
- Screens optional schemas before using the existing supported validator subset. Unsupported keywords, types, formats, references, malformed schemas, and schema-incompatible safe values fail closed.
- Detects and masks sensitive URL query values and explicit sensitive path segments.
- Keeps the auto-fetch image defense in `redactSensitiveText`; public Markdown links are unchanged.

## Files

- `src/security/output-validation.ts` — new pure validator and public result types.
- `src/security/output-validation.test.ts` — seven pure boundary tests.
- `src/security/structural-detection.test.ts` — direct core tests for structural values, URLs, public links, images, and actual egress operations.
- `src/security/redact.ts` — mandatory text floor includes redactable exfil image spans.
- `src/security/detect/secrets.ts` — sensitive URL query/path value rules.
- `src/security/detect/exfil.ts` — distinguishes public inline links from auto-fetch/sensitive-link surfaces and limits reference handling to images.
- `fixtures/exfil/cases.json` — updates the synthetic reference-link control to the accepted public-link policy.
- `T19-implementation-spec.md` — pre-production design and verification contract.

No guard, service, MCP, recursive scan, package, lock, dependency, git, or flow-state file was changed. The generated wiki index timestamp produced by the required index read was restored to its prior value.

## TDD evidence

- Initial RED: `bun test src/security/output-validation.test.ts src/security/structural-detection.test.ts` produced 0 pass, 2 fail because the pure module did not exist. Raw log: `.metaproject/data/gdctx/raw/2026-09-06T12-20-20-779Z_run.log`, SHA-256 `d6035d568b98d7a836a5f758572879633816e5b4a27cda1d6c8bb2884b615d59`.
- Context refinement RED: the generic sensitive-field regression produced 6 pass, 1 fail before contextual masking. Raw log: `.metaproject/data/gdctx/raw/2026-09-06T12-27-30-169Z_run.log`.
- Final GREEN: `bun test src/security/output-validation.test.ts src/security/structural-detection.test.ts src/security/detect/exfil.test.ts src/security/redact.test.ts` produced 22 pass, 0 fail, 92 assertions. Raw log: `.metaproject/data/gdctx/raw/2026-09-06T12-27-57-041Z_run.log`, SHA-256 `ba4ac6090784bd84a137974916d2f07d903a5563718e011bb5f4f4edf93b1fa9`.
- Root integration boundary: `bun test src/security/output-validation.test.ts src/security/structural-detection.test.ts src/mcp/structural-redaction.test.ts` produced 14 pass, 0 fail after the independently owned guard/MCP adapters adopted the stable exports. Raw log: `.metaproject/data/gdctx/raw/2026-09-06T12-31-45-015Z_run.log`, SHA-256 `1ddd20a3fa0f76a595692fcff7646d61594717cd2f17461808c0b0ef83d83db7`.
- Targeted ESLint passed with no output. Raw log: `.metaproject/data/gdctx/raw/2026-09-06T12-27-58-429Z_run.log`, SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `bun run typecheck` passed. Raw log: `.metaproject/data/gdctx/raw/2026-09-06T12-28-06-710Z_run.log`, SHA-256 `8366207267355d3e3d5bf3bf6e8c94c5f93f6078c34f08973fa2b38cdda6cc92`.

The global test suite was intentionally not run because the dispatch reserved it for independent verification while other workers were editing the shared worktree. No network or model call occurred.

## Routing audit

- `graph_used`: yes; `gdgraph context` reported the security module but warned that 130 concurrent uncommitted code files made the graph stale, so no stale relationship claim was used.
- `wiki_used`: yes; read the wiki index plus accepted security and detector component pages, then applied the newer frozen policy contract where it superseded older prose.
- `ctx_used`: yes; dispatch validation, searches, tests, lint, typecheck, and evidence capture used `keryx ctx`.
- `raw_rg_used`: no.
