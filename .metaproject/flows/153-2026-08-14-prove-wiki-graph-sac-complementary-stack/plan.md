# Implementation Plan

Status: chosen

## Approach

Prove the live complementary stack first, then add only the tracing and
documentation needed to make that proof reproducible. Do not invent a new
knowledge store or a silent model-fallback chain.

Chosen because:

1. SAC, wiki, graph, memory, and Flow already exist and are tested.
2. The operator confusion is a *boundary* problem, not a missing product.
3. Fail-closed model commands plus deterministic owners is the actual design;
   documenting and demonstrating it is stronger than adding a hidden fallback.

Rejected:

- **Auto hosted → ollama → cache.** Contradicts `runModelTurn` fail-closed
  contract. Would make a missing key look like a successful empty enrich.
- **Treat SAC as a second wiki.** Forbidden by SAC non-goals and owner writers.

## Steps

1. Keep PATH `keryx` on the working-tree 0.2.34 build.
2. Add `keryx workspace overview|read --explain` so Facts / Work / Know-how
   (and which owner they came from) print as a human trace next to JSON.
3. Write `docs/verification/wiki-graph-sac-proof.md`: one explanation, write
   map, fallback result, 3–5 step scenario, gaps.
4. Add an architecture wiki page for the split and index it.
5. Fix the stale `propose --summary/--evidence` example in the SAC guide.
6. Run the scenario against this repo and paste expected/actual.
7. Run focused SAC/workspace tests plus a fail-closed enrich probe.

## Risks

- Wrap-up needs a real session with ≥2 messages; a fresh empty session will
  refuse (`session_too_short`).
- Enabling the `sac` module mutates `metaproject.json`; workspace CLI already
  works without that flag.
- Learned policy remains off; do not treat that as a proof failure.
