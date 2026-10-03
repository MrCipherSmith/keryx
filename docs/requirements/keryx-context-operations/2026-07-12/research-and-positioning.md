# Context Operations — Research and Positioning
Version: 1.0.0

## Product position

Keryx must not market Context Operations as a generic “agent memory database”.
Its differentiated category is a **Git-native governed project-context layer**:
the project, not a vendor runtime, owns code knowledge, rules, decisions,
quality evidence and their lifecycle.

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

