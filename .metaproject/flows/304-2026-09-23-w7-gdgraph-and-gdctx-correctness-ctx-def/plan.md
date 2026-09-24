# Implementation Plan

## Approach

One flow, one PR into feat/agent-platform-expansion (split only if review churn demands).
Parallel implementation lanes over disjoint files, then a benchmark lane that consumes
the fixed behavior, then verification tasks, review and CI.

- GDCTX-1 (T5): `classifyLine` gets a line context (stream + exit code). Repo failure
  markers and non-stem markers stay stream-agnostic; `FAILURE_STEMS` only fire on stderr
  lines or when the command exited non-zero. `summarizeCommandOutput` classifies stdout
  and stderr separately (a line is stderr when it came from `result.stderr`). The
  compaction rescue uses the same gate.
- GDCTX-2 (T6): data-driven source override in `SecurityConfig` policies (egress
  image-URL policy, source `trusted-project` -> allow) consulted by `resolve.ts`, gated on
  the URL carrying no credential-shaped query string (token/key/auth/secret/sig/... or a
  secret detector hit). The finding is still recorded. A project can turn the override off.
- GDCTX-3 + allowlist (T7): expand `-[a-zA-Z]{2,}` bundles in `buildRgCommand` only when
  every letter is an `RG_SAFE_FLAGS` boolean; refuse whole naming the offending letter.
  `GIT_READONLY_ALLOW` in `hook-classify.ts` checked before `GIT_ROUTABLE`: status, blame,
  branch, tag, `log --oneline -N` (bounded), `diff --stat`. Plain diff/log/show stay routed.
- gdgraph (T8): audit every query subcommand for `printStaleNote`; add where missing;
  golden edge fixtures (barrel `export *`, type-only re-export, dynamic `import()`,
  tsconfig `extends`+`paths`) with exact edge sets; staleness fixtures (fresh after build,
  stale naming the mutated file, not-fresh without provenance).
- Benchmark (T9): a `goldens` section in `gdctx-fact-preservation.json` (the existing
  three dogfood inputs are a lossy compression benchmark — e.g. 110/327 facts for the docs
  listing, by design — and stay as they are), recomputed live by a CI test at 100%
  agreement; the generator script carries `goldens` forward.
- Index gate (T10): tighten the template budget test to ≤400 tokens (chars/4) and assert
  the live `.metaproject/index.md` is within budget and equal to the template render, so
  `keryx update` cannot undo it. GDCTX-5's slim gate itself already shipped (templates.ts
  `renderIndexGateMarkdown`; live file 1,470 bytes).
- Memory (T11): four known-mistake entries.

## Steps

T5-T8, T10 in parallel -> T9 -> T11 -> T12 (targeted tests/typecheck/eslint) ->
T13 (end-to-end CLI repro) -> T4 (review + PR + CI + merge).

## Risks

- Redaction relaxation is security-relevant: query-string gate must be fixture-tested
  with token/key/auth variants and untrusted sources must still redact.
- Stream-aware classification changes existing ctx golden outputs/tests.
- `-mA`-style bundles must never admit a value flag.
