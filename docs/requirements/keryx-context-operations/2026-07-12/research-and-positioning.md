# Context Operations — Research and Positioning
Version: 1.0.0

## Product position

Keryx must not market Context Operations as a generic “agent memory database”.
Its differentiated category is a **Git-native governed project-context layer**:
the project, not a vendor runtime, owns code knowledge, rules, decisions,
quality evidence and their lifecycle.

## Relevant market patterns

- **Mem0** offers a universal memory layer and self-hosted/cloud choices; its
  extraction/search primitive is useful, but it does not own project quality or
  flow governance. <https://github.com/mem0ai/mem0>
- **Letta** distinguishes always-in-context blocks from files and archival
  memory. Context Operations adopts the same principle: policies are mandatory
  and bounded, archives are retrieved on demand. <https://docs.letta.com/guides/core-concepts/memory/context-hierarchy>
- **Graphiti** proves value in temporal facts, provenance and hybrid retrieval;
  Keryx should use compatible concepts without making a graph DB mandatory.
  <https://github.com/getzep/graphiti>
- **Cognee** demonstrates an explicit remember/recall/improve/forget lifecycle;
  Keryx maps this to candidate/draft/accepted/superseded with human governance.
  <https://docs.cognee.ai/core-concepts/overview>
- **OpenViking** is the nearest strategic comparator because it unifies memory,
  resources and skills with progressive context loading. Keryx differentiates on
  code graph, Git artifacts, quality gates and policy-bound engineering flow.
  <https://github.com/volcengine/OpenViking>
- **LangMem** makes background extraction/consolidation a first-class pattern;
  Keryx defers automatic model-backed consolidation until evaluation and
  governance are in place. <https://langchain-ai.github.io/langmem/concepts/conceptual_guide/>

## Research-derived decisions

- A memory system is a `write → manage → read` lifecycle, not a vector index;
  lifecycle states and evaluation are therefore first-class requirements.
  <https://arxiv.org/abs/2603.07670>
- Dynamic linking and structured attributes can improve retrieval, but changes
  to historical memory must remain explainable and reversible.
  <https://arxiv.org/abs/2502.12110>
- Long-horizon memory must be measured with reproducible multi-session tasks;
  LoCoMo inspires the conversation part, while Keryx needs a code-project corpus.
  <https://snap-research.github.io/locomo/>

## Build versus integrate

Build locally: manifest, provenance, policy, quality/flow coupling, offline
planner and eval corpus. Integrate optionally: embeddings, temporal graph
engines and hosted/multi-tenant stores. This protects the deterministic floor
and avoids recreating mature database runtimes prematurely.

