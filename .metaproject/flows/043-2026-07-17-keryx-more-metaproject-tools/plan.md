# Implementation Plan

Status: formalized

## Approach

Additive: extend MetaprojectPort with OPTIONAL methods (graphPath?/testRelated?/
healthStatus?) + result types; implement them in createMetaprojectAdapter over the
gdgraph/testing/health facades (inspect their real signatures; use a bounded CLI
only where no in-process facade exists); add the three descriptors to
METAPROJECT_OPERATIONS (each checks port-method presence → "unavailable" when
absent). The existing toInteractiveTools/toToolDefinitions/toMcpTools projections
surface them automatically. TDD via task-implementer.

## Steps

1. metaproject-port.ts: optional graphPath/testRelated/healthStatus + result types.
2. metaproject-adapter.ts: implement them (facade or bounded CLI); deterministic;
   never throw.
3. metaproject-operations.ts: 3 new descriptors (risk read) + formatters.
4. Tests: adapter (injected fakes), operations (schema-valid + fake-port), projections.

## Risks

- Facade availability — inspect gdgraph/testing/health services; drop (documented) a
  tool with no clean backing rather than fake it.
- Interface churn — new port methods are OPTIONAL so existing fake ports compile.
