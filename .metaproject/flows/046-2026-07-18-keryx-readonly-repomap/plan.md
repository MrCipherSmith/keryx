# Implementation Plan

Status: formalized

## Approach

Replace the adapter's `gdgraph.repomap` (writing) call with the pure `computeRepomap`
over loadGraph + loadGdgraphConfig. Add an injectable `repomapCompute` dep
(defaulting to that non-writing path) so tests stay deterministic and assert no
write. TDD.

## Steps

1. metaproject-adapter.ts: add injectable `repomapCompute(cwd, options) ->
   Promise<gdgraph RepomapResult>` to MetaprojectAdapterDeps (OPTIONAL/defaulted);
   default = loadGraph + loadGdgraphConfig + computeRepomap (NO write). repomap()
   uses it.
2. Update the existing repomap adapter test to inject the compute fake.
3. Test: repomap returns the mapped result via the injected compute; a test proves
   the writing path (writeRepomap) is NOT used (no fs write).

## Risks

- loadGdgraphConfig I/O — reads config (a read, acceptable); injectable default so
  tests avoid real I/O.
