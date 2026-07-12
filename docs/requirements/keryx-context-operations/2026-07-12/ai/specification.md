# Keryx Context Operations — AI Specification
Version: 1.0.0

## Input → output

`query + project reference + budget + config` → `ContextAssemblyManifest +
RetrievalTrace`.

## Algorithm

1. Validate request and capability state.
2. Reserve mandatory policy/rules/flow AC items.
3. Collect valid candidates from Keryx service facades.
4. Filter by status, trust, scope, validity and policy.
5. Deterministically score; optional adapters rerank only the candidate pool.
6. Enforce budget; successful receipt records project revision/config hash and
   `within-limits`; otherwise return typed `context_overflow` with required IDs.
7. Record guarded feedback separately; require review for promotion.

## Contracts

Validate [manifest](../schemas/context-assembly-manifest.schema.json),
[candidate](../schemas/context-candidate.schema.json) and
[trace](../schemas/retrieval-trace.schema.json), plus
[error](../schemas/context-error.schema.json) and
[adapter](../schemas/external-adapter.schema.json). Maintain AC-1…AC-7.
