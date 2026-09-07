# T7 structural redaction and recursive scan RED evidence

- Timestamp: `2026-09-06T12:11:35Z`
- Base HEAD: `0bc6418fa1a038f8ec909cf949fecba077acf9a4`
- Framework: `bun:test`
- Test files: 3
- Tests: 8
- Result: **RED — 0 pass, 8 fail; every failure is runtime behavior**
- Production changes: none
- Git/flow changes: none

## Focused RED command

```bash
bun test src/mcp/structural-redaction.test.ts src/security/structural-detection.test.ts src/commands/security-recursive-scan.test.ts
```

Result: exit `1`; `0 pass`, `8 fail`. Immutable raw log:

- Path: `.metaproject/data/gdctx/raw/2026-09-06T12-11-35-102Z_run.log`
- SHA-256: `cdb1cce1790ac2ba95834389f81efdacef33668bbdec0690825cf035cec5fca5`

## Reproduced defects

| Group | Current result | Required result |
|---|---|---|
| Structured service redaction | Safe integer/decimal metrics are misclassified and replaced by unquoted mask tokens, making JSON unparsable | Preserve safe metrics/IDs; mask true string secrets; return valid JSON |
| MCP JSON tool output | The same text-splice behavior produces invalid serialized JSON and provides no sibling redaction state | Preserve the operation schema and add sibling `redaction:{state,reasons}` |
| Numeric secret in required field | Tool result remains a nominal success instead of declaring that masking would violate the numeric schema | Leak-safe `isError:true`, `redaction.state=format-unsafe`, and no raw number |
| MCP resource/error | The text resource returns its raw synthetic secret; current error masking lacks the required sibling redaction evidence | No secret in either surface; explicit sibling redaction state |
| Public Markdown control | A plain public documentation link is classified as an egress/exfiltration operation | No egress finding without an operation/exfiltration signal |
| Recursive directory scan | All three directory cases throw `EISDIR` before scanning | Default recursive scan with per-file evidence and bounded traversal |
| Symlink/inaccessible coverage | No traversal result exists | Internal canonical links once, cycles terminate, external denied, unreadable is incomplete, external details remain leak-safe |
| Limit plus finding | No traversal result exists | File-count exhaustion is incomplete while earlier findings remain and FAIL may coexist with incomplete coverage |

The URL-secret assertions execute before the public-link assertion and pass: the current deterministic detector masks both synthetic secret occurrences in URL path/query while preserving the public host. This is a required positive control inside an otherwise RED scenario.

## Public contract supplied to implementation

- MCP tool result: existing `text` and `isError`, plus optional sibling `redaction: { state: "none" | "redacted" | "format-unsafe"; reasons: string[] }`.
- Resource result: existing `uri`, `mimeType`, and `text`, plus the same optional sibling `redaction`.
- Recursive scan JSON: existing security report fields plus `coverage: { status: "complete" | "incomplete"; required: boolean; reasons: string[] }` and `files: Array<{ path; status: "scanned" | "skipped" | "failed"; reason? }>`.
- CLI flags: `--max-files <positive integer>` and `--max-bytes <positive integer>`. A directory recurses without requiring `--recursive`.

This additive contract was confirmed by the parent before tests were finalized. Traversal helper signatures remain deliberately unspecified.

The proposed pure core validator signature for the implementation split is:

```ts
type OutputValidationResult =
  | {
      ok: true;
      value: unknown;
      text: string;
      redaction: { state: "none" | "redacted"; reasons: string[] };
    }
  | {
      ok: false;
      text: string;
      redaction: { state: "format-unsafe"; reasons: string[] };
    };

function validateOutputForTransport(input: {
  value: unknown;
  format: "json" | "text";
  schema?: JsonSchema;
}): OutputValidationResult;
```

It walks structured string leaves and runs deterministic local detectors regardless of field names. Safe number/boolean/null leaves remain unchanged. A numeric value under a sensitive key such as `password` returns `format-unsafe`; broad phone matching alone must not classify ordinary numeric metrics. With `format: "json"`, JSON string values remain quoted and `text` serializes the returned `value`; with `format: "text"`, resource text stays plain. `format-unsafe` uses a fixed leak-safe constant. An optional operation schema may verify the safe value only through validation features the project actually supports; it must not claim full JSON Schema coverage. The MCP wrapper adds the returned redaction metadata beside `text`/`isError`; it never injects metadata into the operation value.

## Test hygiene

Targeted ESLint passed for all three new files. Artifact: `.metaproject/data/gdctx/artifacts/2026-09-06T12-11-36-267Z_run.md`, SHA-256 `2794fb705b133d8d29b0f6bedabc3001aad5347f43b66e1b70a0ba0f1db52c0d`.

All temporary directories, symlinks, files, and permission changes are cleaned in `finally` blocks. Recursive success has a 3-second timeout. No production file, package, lockfile, dependency, index, branch, commit, flow state, or frozen criterion was changed.

## Test file hashes

| File | SHA-256 |
|---|---|
| `src/mcp/structural-redaction.test.ts` | `cc459f00125316fc7ac0b3cb5e032341abc1eaeba778273c2345c38cb32088bc` |
| `src/security/structural-detection.test.ts` | `f2f39a291717582fcc48e08930da468a65a5e7ffa751c154284432f3a1774848` |
| `src/commands/security-recursive-scan.test.ts` | `615e5f6bac4d87e1b7f3c3efae38ccfe85ddccb301a109f2e32de16e27a753c6` |

## Routing audit

- `graph_used: yes` — graph context identified security/MCP/command surfaces; 122 uncommitted code files made it stale, so it was navigation-only.
- `wiki_used: yes` — wiki index and security, detector, MCP, and command component pages established existing contracts before source reads.
- `ctx_used: yes` — source searches, related-test discovery, large reads, RED execution, and lint used `keryx ctx`/gdctx.
- `raw_rg_used: no`.
