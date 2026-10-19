# Module src/harness/routing

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/harness/routing` decides which provider and model runs each kind of task. It holds a pure resolver that picks a model per task category from layered config, the trust and profile stores that feed it, a derivation step that builds defaults from the session's own provider, and a measured task-cost store that can refine those defaults. Groups 20 file(s) and exposes 20 public symbol(s).

## Overview

`src/harness/routing` owns the mapping from task categories (`default`, `review`, `subagents`, `quick`, `coding`, `planning`, `docs`, `unattended`) to the provider and model that should run them. It involves no task classifier: the caller names the category, and the module resolves it from whichever layers are configured, falling back to the session's own model. Most of the logic is pure, and the file and network state it needs is loaded by sibling modules and passed in.

## How it works

The core is `table.ts`. `resolveCategoryDetailed` walks a `RoutingLayers` value in precedence order (`override`, `project`, `user`, `derived`) and takes the first layer whose assignment passes two checks. Those checks are injected as predicates: `ConnectedPredicate`, built from the provider list by `connectedPredicateFrom`, and `AvailablePredicate`, built from stored profiles by `availablePredicateFromProfiles`. The core therefore never probes providers or reads the profile store itself. A skipped layer is recorded on `ResolvedCategory.rejected` with a reason, so callers can show a fallback notice. If no layer answers, the result is `session-default`, which is the session's own model.

`config.ts` reads and writes the two configured layers. The project layer is `routing.config.json` at the project root. The user layer is the `routing` key in shell config. `trust.ts` gates the project layer. `loadRoutingConfig` returns an empty table with `untrusted: true` unless the operator has approved the validated table for that project root. The fingerprint covers the validated categories, not the raw bytes, so a reformat keeps approval. Writes first read the raw table, so entries hidden by the trust gate are not lost on a write.

`model-profile.ts` records what keryx knows about each `<providerId>/<modelId>`: strength tier, input and output price, context length, priority, and whether the model is still listed and chat-capable. Each value carries a source (`reported`, `curated`, `guessed`, `operator`, `unknown`), and refreshes do not overwrite operator-sourced values. Profiles are stored in `model-profiles.json` under a file lock. The curated seed for the Anthropic, OpenAI and Gemini lists is merged in on read and is persisted only when something writes.

`derive-default-table.ts` is a pure function. Given one provider's available models, the profiles and the session's model id, it returns the `RoutingTable` that becomes the `derived` layer. `task-cost.ts` holds measured per-task token and cost samples and exposes them as a lookup. The derivation consults that lookup only to choose between its size-based step-down pick and the stronger pick.

## Key concepts

- **Task category** (`RoutingCategory`, `ROUTING_CATEGORIES`): the eight kinds of work a model can be assigned to. Only `review` and `subagents` are wired to a real call site (`WIRED_ROUTING_CATEGORIES`).
- **CategoryAssignment**: what a category resolves to. It is `session-default`, `model` (an exact provider and model pair), or `provider-default` (a provider without a pinned model). `parseAssignmentTarget` reads the `provider/model` text form.
- **RoutingTable and RoutingLayers**: a `RoutingTable` is a partial map from category to assignment. `RoutingLayers` holds one table per layer, and `RoutingSource` names the layer that answered.
- **Connected and available**: "connected" means the provider or model is in the operator's provider list. "Available" means the stored profile has `available: true`, and a model with no profile counts as available. A `provider-default` assignment is checked only for connection.
- **ModelProfile and ProfileSource**: the per-model record and the provenance of each field. Operator corrections outrank every refresh.
- **TaskCostRecord and TaskCostStats**: one finished task, and the rolling summary for a key of `providerId::modelId::category`. The summary holds the median tokens, the median cost when a cost is known, and the success rate. Each key keeps at most 200 samples.
- **Trust fingerprint**: a SHA-256 over the sorted, validated category table. Approval is stored in `routing-config-trust.json`, keyed by the resolved project root.

Relationships: a `CategoryAssignment` is the value inside a `RoutingTable`. Tables feed `RoutingLayers`. Connected and available predicates decide whether a layer's assignment is accepted. The derived table is built from `ModelProfile` values and, optionally, a `TaskCostLookup`.

## Main flows

1. **Resolving a category.** The caller loads each layer first. The project layer comes from `loadRoutingConfig` and is trust-gated, and the user layer comes from the same loader. The derived layer comes from `deriveDefaultTable`. The caller then builds the two predicates and calls `resolveCategoryDetailed`. The result's `source` and `rejected` fields feed `describeCategoryResolution` and `describeRejectionNotice`. Per its comments, `table.ts` shares these describers between the CLI (`src/commands/routing.ts`) and the TUI (`src/tui/routing-inspector.ts`).
2. **Deriving defaults.** `deriveDefaultTable` keeps the comparable, chat-capable, non-`:free` profiles. Planning and review take the strongest candidate that is not weaker than the session model. Subagents, docs and unattended take the next size step down. Quick takes the smallest class. Default and coding are left unset. A single chat model is assigned to every category except default and coding. Size comes from `rankModelId`, and `familyKey` and `parseModelVersion` order versions within a family. `preferByMeasuredCost` swaps the step-down pick for the stronger one unless the lighter model's median cost is strictly lower. That comparison runs only when both sides have at least `MIN_MEASURED_TASKS` (20) samples with known cost.
3. **Refreshing profiles.** `refreshModelProfiles` diffs a provider's live model list against the store. New ids get a fresh profile with a guessed tier. Listed ids have their non-operator fields updated. Ids that are no longer listed for that provider are kept and marked `available: false`, never deleted. Every write runs under the same lock.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `ROUTING_CATEGORIES`
- `RoutingCategory`
- `isRoutingCategory`
- `WIRED_ROUTING_CATEGORIES`
- `CategoryAssignment`
- `SESSION_DEFAULT_ASSIGNMENT`
- `RoutingTable`
- `RoutingLayers`
- `RoutingSource`
- `ResolvedCategory`
- `ConnectedPredicate`
- `AvailablePredicate`
- `resolveCategoryDetailed`
- `resolveCategory`
- `connectedPredicateFrom`
- `describeFallbackNotice`
- `describeUnavailableNotice`
- `describeRejectionNotice`
- `describeAssignment`
- `describeCategoryResolution`

### Key files

- `src/harness/routing/table.ts` - imported by 29, imports 1
- `src/harness/routing/model-profile.ts` - imported by 19, imports 6
- `src/harness/routing/config.ts` - imported by 16, imports 5
- `src/harness/routing/task-cost.ts` - imported by 9, imports 3
- `src/harness/routing/trust.ts` - imported by 10, imports 2
- `src/harness/routing/derive-default-table.ts` - imported by 4, imports 5

### Depends on

- `src/lib` - 11 import(s)
- `src/gdskills` - 5 import(s)
- `src/commands` - 2 import(s)
- `src/harness/child` - 1 import(s)
- `src/harness/provider` - 1 import(s)

### Depended on by

- `src/commands` - 15 import(s)
- `src/tui` - 15 import(s)
- `src/harness/decision` - 5 import(s)
- `src/harness/tool/builtin` - 3 import(s)
- `scripts` - 2 import(s)
- `src/lib` - 2 import(s)

### Dependency basis

- Production imports only: 29 import(s) from test file(s) (e.g. `src/commands/providers.model-profiles.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 20
- Cross-module imports: 20

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/gdskills](src-gdskills.md)
- [Module src/commands](src-commands.md)
- [Module src/harness/child](src-harness-child.md)
- [Module src/harness/provider](src-harness-provider.md)
- [Module src/tui](src-tui.md)
- [Module src/harness/decision](src-harness-decision.md)
- [Module src/harness/tool/builtin](src-harness-tool-builtin.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-10-19T10:13:19.815Z. Prose sections are drafts for the gdwiki enrich workflow.
