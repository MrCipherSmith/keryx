# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `subagent-dispatch.schema.json` gains an optional `model` block matching `docs/requirements/keryx-multi-agent-engine/schemas/child-model-selection.schema.json`; a dispatch without the block still validates unchanged.
- AC2: `ChildContractExtension` and `harness-child-contract-extension.schema.json` gain an optional `modelSelection` (`{providerId,modelId,source}`); `buildChildDispatchExtension` sets it via conditional spread and omits it when absent (respects `exactOptionalPropertyTypes`).
- AC3: `spawnChild` calls `resolveChildModel` after the `inheritPolicy` gate (guard order budget → policy → model); any model denial returns `{ok:false,reason}` and produces no extension, session entry, or provenance (fail-closed, matching budget/policy denials).
- AC4: On success the returned extension carries the resolved `modelSelection`; an explicit/tier request is reflected, and an omitted `model` block yields `source:"inherited"` equal to the parent selection.
- AC5: A backward-compatibility regression test proves a dispatch with no `model` block yields byte-for-byte the same spawn behavior as before this phase.
- AC6: `spawn.test.ts` and `contract.test.ts` are extended and pass; determinism is preserved (injected `idSeq`/`clock` only) and the zero-`dependencies` guard passes.
