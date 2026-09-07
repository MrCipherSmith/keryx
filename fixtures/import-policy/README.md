# Import-policy fixtures

Four tiny, self-contained TypeScript module trees consumed by
`src/lib/import-policy.test.ts` (flow 239, AC-20 / AFC-20: "import-policy
проверка ловит запрещённый fixture и проходит разрешённый"). Unlike the
labeled-corpus fixtures elsewhere in `fixtures/` (`cases.json` consumed by
`src/eval/corpus.ts`), these are real, buildable module graphs — the check
under test asks the real bundler what an entry point reaches, so its fixtures
have to be things the bundler can actually reach something through.

Each directory is laid out with top-level subdirectories named after real
`src/lib/import-zones.ts` zone entries (`gdgraph`, `harness`, `lib`, …) so the
SAME zone table classifies fixture modules that the real tree would use —
no separate fixture-only zone table exists.

| Directory | Entry zone | Reaches | Expected |
|---|---|---|---|
| `forbidden-owner-imports-client/` | core (`gdgraph`) | client (`harness`) | violation |
| `allowed-owner-imports-shared/` | core (`gdgraph`) | shared (`lib`) | clean |
| `forbidden-client-imports-core-internal/` | client (`harness`) | a core module that is not `service.ts` | violation |
| `allowed-client-imports-core-facade/` | client (`harness`) | a core module named `service.ts` | clean |

None of these files are reachable from any real entry point (`src/cli.ts`,
`src/lib/production-graph.test.ts`'s release build, …) and none is imported by
anything outside its own pair — they exist to be built in isolation by the
check under test.
