# Plan

## Chosen approach

Reuse before building, and stay deterministic. Three constraints inherited
from phase 0 and its review, all of them already paid for once:

- **The module set has exactly one source.** `validModuleNames` and
  `moduleNameFromProjectPath` (`src/wiki/service.ts`). There are now three
  consumers; this adds a fourth, and re-deriving grouping is forbidden.
- **`orphan` is not new.** `wikiPruneOrphans` (`src/wiki/service.ts:306`)
  already finds pages whose module left the graph and already refuses to
  delete accepted ones. The report projects its `orphanedAccepted`, adding a
  reason chain — it does not reimplement the detection.
- **An absent graph means "nothing to say", never "everything is stale".**
  `validModuleNames` returns `undefined` rather than an empty set for this
  reason. `orphan` and `undocumented` derive from a node's ABSENCE and must
  be suppressed entirely when the graph itself is absent.

## Steps

1. **Queue writer** (`src/wiki/freshness/queue.ts` + hook template): append
   one line per commit, schema-valid, rotating past 10k lines or 5 MB.
   Replaces the body of the existing `keryx:gdgraph-post-commit` hook rather
   than adding a second hook.
2. **Change classification** (`src/wiki/freshness/classify-change.ts`): diff
   the symbol layer's `{id, signature}` sets between two revisions for
   `signature` vs `body`; normalise via tree-sitter for `cosmetic`. Degrade
   honestly — with no symbol layer, return `body` for any substantive change
   and never claim `signature`.
3. **Propagation** (`src/wiki/freshness/propagate.ts`): BFS over `describes`
   plus `imports`/`calls` per §6.1, with the decay of §6.2.
4. **Freshness paths**: git range where `VerifiedAt` resolves, `VerifiedScope`
   comparison where it does not. Both built together — the second is the only
   path a whole class of projects has.
5. **Report + command** (`keryx wiki freshness`): categories, reason chains,
   `limitations`, sorted by commits-behind, `--json` schema-valid, exit 0
   always.
6. **Registry + tests**: register in `src/standard/command-registry.ts` with
   an honest `json` flag; tests per AC.

## Rejected alternatives

- **Classifying by content hash alone** (today's `computePageNodeHash`
  behaviour). Measured on this repo: filtering whitespace saved zero pages
  over three weeks. Hashes cannot separate `signature` from `body`, which is
  the distinction that decides whether prose is in doubt.
- **Running the graph build inside the hook.** A full build is ~2.3 s here;
  the hook budget is 50 ms. The queue exists precisely so the expensive part
  is deferred.
- **A blocking freshness gate.** Deliberately not built: `wiki freshness`
  exits 0 always. A blocking check invites "update the page so CI passes",
  which produces filler faster than drift produces staleness.

## Risks

- Symbol-layer availability is a capability, not a guarantee; the degraded
  path must be tested, not assumed.
- Propagation over `imports` can explode on a hub module. The decay is the
  bound, and it needs a real measurement on `src/lib` (79 files) rather than
  a fixture.
- The queue is append-only state a hook writes; a corrupt line must skip that
  line, never fail the drain.
