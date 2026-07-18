# Implementation Plan

Status: formalized

## Approach

Same additive pattern as flow 043: OPTIONAL port methods + adapter impl over
gdgraph querySymbol / repomap (+ wiki CLI if clean) + descriptors; generic
projections surface them. TDD.

## Steps

1. Inspect gdgraph querySymbol (pure, needs symbol layer) + service.repomap signatures; wiki ask backing.
2. metaproject-port.ts: OPTIONAL graphSymbol?/repomap?/wikiAsk? + result types.
3. metaproject-adapter.ts: implement (facade or bounded CLI); injectable; never throw.
4. metaproject-operations.ts: descriptors (risk read) + formatters; invoke checks method presence.
5. Tests: schema-valid; absent->unavailable + present->formatted; projections include new names.

## Risks

- Symbol layer may be optional/disabled -> querySymbol returns empty; handle as "no symbol".
- wiki ask needs embeddings -> if not cleanly available, DROP and document.
