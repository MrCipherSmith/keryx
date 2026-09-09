# Import-policy fixtures

Eight tiny, self-contained TypeScript module trees consumed by
`src/lib/import-policy.fixtures.test.ts` (flow 239, AC-20 / AFC-20:
"import-policy проверка ловит запрещённый fixture и проходит разрешённый").
Unlike the labeled-corpus fixtures elsewhere in `fixtures/` (`cases.json`
consumed by `src/eval/corpus.ts`), these are real, buildable module graphs —
the check under test parses them with Bun's own transpiler and, for the
coverage cross-check, hands them to the real bundler, so they have to be
things both tools can actually process.

Each directory is laid out with top-level subdirectories named after real
`src/lib/import-zones.ts` zone entries (`gdgraph`, `harness`, `lib`, …) so the
SAME zone table classifies fixture modules that the real tree would use —
no separate fixture-only zone table exists.

## The two policy directions

| Directory | Entry zone | Reaches | Expected |
|---|---|---|---|
| `forbidden-owner-imports-client/` | core (`gdgraph`) | client (`harness`) | `owner-imports-client` |
| `allowed-owner-imports-shared/` | core (`gdgraph`) | shared (`lib`) | clean |
| `forbidden-client-imports-core-internal/` | client (`harness`) | a core module that is not `service.ts` | `client-imports-core-internal` |
| `allowed-client-imports-core-facade/` | client (`harness`) | a core module named `service.ts` | clean |

`allowed-client-imports-core-facade/`'s facade is deliberately **not a leaf** —
it imports `gdgraph/internal.ts`, the way every real facade imports the
internals it re-exports. That single edge is what separates the two techniques:
the direct-edge check passes it (the client imports only `service.ts`), and a
reachability check cannot (the client "reaches" `internal.ts` through the
facade). The fixture was a leaf until flow 239 T8, and its leafness was the only
reason the old reachability-based check appeared to work.

## The tree-shaking shapes

Four trees whose core entry contains a plainly written forbidden import that
the previous, build-based check reported as `violations=0`, because a bundle
records what SURVIVES optimisation rather than what was written.

| Directory | Shape | Old check | Direct-edge check |
|---|---|---|---|
| `tree-shaken-unused-binding/` | binding imported, never used | `violations=0` | `owner-imports-client` |
| `tree-shaken-dead-branch/` | binding used only under `if (false)` | `violations=0` | `owner-imports-client` |
| `tree-shaken-through-barrel/` | unused binding through a re-export barrel | `violations=0` | `owner-imports-client` |
| `erased-type-only-import/` | `import type` — erased at compile time | `violations=0` | **still none: a documented limit** |

One precision note the fixtures pin: a barrel by itself does **not** defeat the
bundler. Written with the binding genuinely consumed, that same tree is
followed straight through to the module behind the barrel — measured, and
asserted in the fixtures test. What defeats the bundler is the unused binding;
the barrel is a hop the eliminated import happens to travel through.

`erased-type-only-import/` is the odd one out on purpose. It is not a case the
new check catches; it is the check's honest limit, held as a fixture so that
the limit is re-measured on every run instead of decaying into a stale claim in
a comment. If a future parser change ever does surface type-only edges, the
test asserting zero findings there fails and the documentation gets corrected.

None of these files are reachable from any real entry point (`src/cli.ts`,
`src/lib/production-graph.test.ts`'s release build, …) and none is imported by
anything outside its own tree — they exist to be scanned in isolation by the
check under test.
