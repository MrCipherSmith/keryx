# T12 Change Report

## Outcome

Truthful health completeness is implemented within the T12-owned health and health CLI surfaces. The original eight T11 RED cases are green, and four additional bounded tests cover supported empty audit results, unknown JSON shapes, nonzero tool crashes without findings, and strict warning exit parity.

No network, package audit, provider, or model call was made. All runtime tests use local temporary fixtures and fake executables. No package, lockfile, flow state, branch, index, or commit was changed by T12.

## Behavior implemented

- `GateStatus` includes `incomplete`, while `GateResult.coverage` records `complete` or `incomplete` independently. Blocking findings and regression thresholds still dominate as `fail`, including when coverage is incomplete.
- Required missing, skipped, disabled, filtered, execution-failed, or parse-failed sources make a non-failing report incomplete. Optional skipped sources remain visible without escalating the gate; optional configured failures preserve warning behavior.
- Source reports now distinguish `execution`, `parse`, `exitCode`, findings, and diagnostic error. New reports populate these additive fields; old artifacts without them remain readable.
- Source filters retain excluded required checks as explicit skipped rows with an `excluded by source filter` reason.
- Bun package-keyed audit arrays and npm modern/legacy reports preserve advisory identity, title, and severity. Empty supported shapes are clean. Malformed JSON and unknown shapes are parse failures even at exit zero.
- Recognized findings from nonzero tool exits are retained. A nonzero exit without findings becomes an execution failure.
- Live JSON/text health runs and stored health gates exit nonzero for `fail` and `incomplete`. Strict live runs and `health gate --strict-warn` also reject `warn`.
- Markdown reports render gate coverage and source execution/parse states.

## Verification

| Check | Result | Immutable evidence | SHA-256 |
|---|---:|---|---|
| T11 acceptance plus edge cases | 12 pass, 0 fail, 68 assertions | `.metaproject/data/gdctx/raw/2026-09-06T11-49-18-741Z_run.log` | `9a2cc956e4d7d05133a97e3af168a1e231065e7cbe5ac1660a058344eb4b0288` |
| All `src/health` tests | 83 pass, 0 fail, 238 assertions | `.metaproject/data/gdctx/raw/2026-09-06T11-49-26-004Z_run.log` | `730fe552665af528e159b637b370d0ecbb2173af22eb90d714bd15efb93935d8` |
| Targeted ESLint for every T12 code/test file | exit 0, no findings | `.metaproject/data/gdctx/artifacts/2026-09-06T11-50-29-442Z_run.md` | `07367dfa1c92885bd7f556d46f618646688ac89cc016eea103bb888573460c87` |
| Diff whitespace check | exit 0 | command output empty | n/a |

Exact acceptance command:

```text
bun test src/health/health-truthful-gate.test.ts src/health/dependency-audit-format.test.ts src/commands/health-incomplete.test.ts
```

The repository-wide ESLint command ran and failed with 168 errors and 2 warnings across existing and concurrently edited files; it reported no T12-owned file. Raw evidence: `.metaproject/data/gdctx/raw/2026-09-06T11-50-22-222Z_run.log`, SHA-256 `12e9d6019fd13ad9232ca1118ce4b18d9892a03b2731dd59c5198dfcb910e911`.

Root TypeScript checking currently cannot pass because the new `incomplete` status must be propagated to the outside-owned harness port union at `src/harness/tool/metaproject-port.ts:149`; the resulting assignment error is at `src/harness/tool/metaproject-adapter.ts:495`. Concurrent containment tests also reference an unfinished module/API. Raw evidence: `.metaproject/data/gdctx/raw/2026-09-06T11-47-52-845Z_run.log`, SHA-256 `88ed2b4d9ec76cf4940c8f451cb5d29f6c330a512c1f6edf4836280fd080f717`. The parent was notified to coordinate that propagation, as required by the dispatch ownership boundary.

## Key file hashes

| File | SHA-256 |
|---|---|
| `src/health/types.ts` | `be8edca77296ac566bf7407cd6c0cc92d86178cfdec046318e778850e9eafcf1` |
| `src/health/gate.ts` | `9c26cc7f36b86d171c0b223132b6acbd47735dc524f2e39a0b103b1d3f08d0c0` |
| `src/health/run.ts` | `a6b25cedf12f61ebf4b80479722c11b59d599e0f76fd0fc23deae1b6117c3bc7` |
| `src/health/sources/dependency-audit.ts` | `1dde619c1fbbae681962167f91bf5c0e4b5ee51fb2c5af578728bc0dae134e55` |
| `src/health/health-truthful-gate.test.ts` | `09af44a1d72770fb6da11b58b85a7832d35a15ddf3b52161ef37822f71501bb8` |
| `src/health/dependency-audit-format.test.ts` | `8c9ad4740a98b6f1e6ca7bce259685047ba106326b522586b3158c49ecc15391` |
| `src/commands/health.ts` | `99a0d95e55043499f1dc0135924d61765afc6aadf5ecc5ebcf240fddc3b418e8` |
| `src/commands/health-incomplete.test.ts` | `4f05983bdffac1a364c3dc3915dbdade6cbc52e543f7181fcfd7575217e996b0` |

## Routing audit

- `graph_used: yes` — gdgraph identified health gates, sources, and CLI consumers. It reported uncommitted code, so direct source reads were authoritative and graph answers were treated as potentially stale.
- `wiki_used: yes` — the wiki index and health/source/command component pages were consulted before deep code reads.
- `ctx_used: yes` — searches, diffs, test output, lint, type checking, and large reads used `keryx ctx`/gdctx.
- `raw_rg_used: no`.
