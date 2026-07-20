# Implementation Plan

Status: ready to freeze

## Approach

Extend the canonical contract and the spawn path by exactly one optional field
each, and slot `resolveChildModel` into `spawnChild`'s existing fail-closed guard
chain. Optional-everywhere keeps existing runs and fixtures valid.

## Steps

1. `subagent-dispatch.schema.json`: add optional `model` block per
   `docs/requirements/keryx-multi-agent-engine/schemas/child-model-selection.schema.json`.
2. `harness-child-contract-extension.schema.json` + `src/harness/child/contract.ts`:
   add optional `modelSelection` to `ChildContractExtension`; set it in
   `buildChildDispatchExtension` via conditional spread (like `maxToolCalls`).
3. `src/harness/child/spawn.ts`: add `SpawnChildRequest.modelRequest?` and
   `SpawnChildInput.{parentModel, allowedProviders}`; call `resolveChildModel`
   after the `inheritPolicy` gate; on `!ok` return `{ok:false,reason}` (no partial
   extension); on success stamp `modelSelection` on the extension.
4. Extend `src/harness/child/spawn.test.ts` and `contract.test.ts`: inherit
   default, explicit/tier, model-denial refuses the whole spawn, backward-compat.

## Risks

- Guard ordering must be budget → policy → model; a model denial must leave no
  partial session entry (match existing fail-closed spawn semantics).
- Schema edits must stay `additionalProperties:false`-clean and optional.
