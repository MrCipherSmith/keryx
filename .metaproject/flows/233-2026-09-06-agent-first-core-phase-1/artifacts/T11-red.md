# T11 AFC-05 truthful health gate RED evidence

- Timestamp: `2026-09-06T11:37:10Z`
- Base HEAD: `0bc6418fa1a038f8ec909cf949fecba077acf9a4`
- Framework: `bun:test`
- Test files: 3
- Tests: 8
- Result: **RED — 0 pass, 8 fail, 11 assertions reached**
- Production changes: none
- Git/flow changes: none

## Focused RED command

```bash
bun test src/health/health-truthful-gate.test.ts src/health/dependency-audit-format.test.ts src/commands/health-incomplete.test.ts
```

Result: exit `1`; `0 pass`, `8 fail`, `11 expect() calls`.

Immutable raw log:

- Path: `.metaproject/data/gdctx/raw/2026-09-06T11-36-12-293Z_run.log`
- SHA-256: `6d5b6589bb02090f3016e8980c3ccd96893d47d5f43e319a0319d7437b7e3184`

## Reproduced defects

| Scenario | Current result | Required result |
|---|---|---|
| Required missing source in non-strict fold | `warn` | `incomplete` |
| Required skipped/disabled source | Can remain `pass` | `incomplete` |
| P0 plus skipped required source | `fail`, no coverage axis | `fail` with `coverage=incomplete` |
| `--source complexity` omits required eslint/typescript | `pass`; omitted sources absent | `incomplete`; omitted required coverage recorded |
| Dependency audit malformed output, rc0 | `pass`, source `available`, zero findings | `incomplete` parse with an explicit reason |
| Bun package-keyed audit output, rc1 | Zero findings and `pass` | One retained P0 finding and `fail` |
| Stored incomplete report via service | Exit code `0` | Exit code `1` |
| Strict CLI with required skipped ESLint | JSON gate `pass`, exit `0` | JSON gate `incomplete`, exit `1` |

The failures are runtime contract failures rather than placeholder assertions or TypeScript errors. The first implementation-independent typecheck after the RED run passed:

```bash
bun run typecheck
```

Result: exit `0`.

- Raw log: `.metaproject/data/gdctx/raw/2026-09-06T11-36-26-668Z_run.log`
- SHA-256: `8366207267355d3e3d5bf3bf6e8c94c5f93f6078c34f08973fa2b38cdda6cc92`

## Synthetic fixture boundary

The two audit runtime scenarios write a temporary executable at `node_modules/.bin/bun`. It returns a fixed version and either public synthetic JSON or the literal string `not-json`, with the requested local exit code. `runHealth` invokes the real dependency-audit adapter through the existing `runAdapter` path. The tests remove the entire temporary project afterward. No live audit or registry request is possible through this fixture.

The parser-format test uses invented package and advisory identifiers only:

- Bun package-keyed arrays: two advisories for one synthetic package.
- npm modern `vulnerabilities`: one advisory object in `via`.
- npm legacy `advisories`: one numeric synthetic advisory key.

## Test file hashes

| File | SHA-256 |
|---|---|
| `src/health/health-truthful-gate.test.ts` | `e452950e8c821767f324cc8dc51c82ec055cc69da637298c07221652f1a78da9` |
| `src/health/dependency-audit-format.test.ts` | `4b769239c3936bea26d3b58e7f6a0119c01162c818727e476b8a2a11cecc5322` |
| `src/commands/health-incomplete.test.ts` | `c9a4eebd1c8f862820c99b3f1f0bf8e89f194e384526fc46667ebd909f4722dd` |

## T8 artifact correction

`T8-result.json` now references the corrected `T8-change-report.md` hash and states that the observed health command skipped required ESLint, so it does not claim a complete quality PASS. Earlier command evidence remains in the report.

- Corrected T8 report SHA-256: `d20f966e90cf530b68a5c70a10a3b2758901be9bc1e5c8c2450830738aacc02f`
- Updated, schema-valid T8 result SHA-256: `29fad9d7eb99778f2ecef54fd792bead7aee2caf2f5f9f09d94ba8adf9c4a9e1`

## Routing audit

- `graph_used`: `keryx gdgraph context` plus affected queries for gate, dependency audit, and health CLI. The graph reported uncommitted code files and was used only for navigation; source files were read directly for proof.
- `wiki_used`: wiki index plus `components/src-health.md`, `components/src-health-sources.md`, and `components/src-commands.md`.
- `ctx_used`: routed policy/source searches, related-test discovery, focused RED run, and root TypeScript check; raw command logs retained by gdctx.
- `raw_rg_used`: no.
