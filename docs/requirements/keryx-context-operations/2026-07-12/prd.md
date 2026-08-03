# Keryx Context Operations — PRD
Version: 1.1.0

## Problem

A long-lived coding agent loses effectiveness for more reasons than a short
context window. It receives too much unrelated information, re-explores the
repository, applies outdated decisions, or cannot justify why it used a
particular rule. Plain vector memory removes some of the searching, but it does
not tie memory to the code, the task, the quality evidence, a validity period,
or the safety of the write.

## Goal

Make Keryx the project-level control plane for context engineering: any agent or
human can assemble a small context package for a specific task, see its sources
and limits, reproduce the selection, and improve the system based on the outcome.

## Users

- A developer entering an unfamiliar module quickly, who wants provable
  recommendations rather than a full repository dump.
- A team running several agents over shared decisions, rules and lessons.
- A maintainer or reviewer who cares about context provenance, quality gates, and
  the absence of unsanctioned memory.
- The orchestrator of the future Project Agent Harness, which needs bounded input
  and a formal receipt for resume and replay.

## Product requirements

### Context assembly

- **CO-1.** The system must build a `ContextAssemblyManifest` for a question or
  work item, under an explicit budget in bytes, estimated tokens and item count.
- **CO-2.** Every `ContextCandidate` must carry a source kind, a stable source
  reference, a content hash, score components, typed freshness/validity, and a
  trust level.
- **CO-3.** Assembly must support progressive disclosure: orientation →
  high-confidence sources → on-demand evidence. Exceeding the budget returns a
  typed `context_overflow` rather than quietly dropping a critical policy item.
- **CO-4.** The result must reference code graph, wiki, memory, skills, rules and
  quality/testing artifacts **only** where the source exists and has passed its
  corresponding validation status.

### Retrieval and memory lifecycle

- **CO-5.** Baseline retrieval stays deterministic and offline. Optional
  semantic/graph providers attach exclusively through the Capability Seam and
  never change the disabled-floor output.
- **CO-6.** The query planner must combine lexical relevance, scope match,
  temporal validity, accepted status, graph distance and an optional semantic
  score; every component applied is explained in the trace.
- **CO-7.** Memory capture moves through `candidate → draft → accepted |
  rejected | superseded`; an accepted record stores its source, reviewer and
  validity.
- **CO-8.** The system must support feedback: an agent or human marks candidates
  useful, stale, misleading or unsafe. Feedback does not change the source of
  truth automatically without policy permission.

### Governance and interoperability

- **CO-9.** Security, redaction and policy gates apply both before a package is
  handed to an agent and before new knowledge is written; untrusted content
  cannot become procedural memory or a skill without explicit review.
- **CO-10.** The CLI and the MCP read surface must return identical normalized
  assembly/trace semantics; write operations remain separate guarded actions.
- **CO-11.** External adapters (Graphiti, Cognee, OpenViking and the like) are
  optional read-only — or explicitly approved write — backends, each with its own
  configuration, retention and provenance contract.

### Product operability

- **CO-12.** `keryx` must be runnable both from an installed binary and from a
  development checkout through a documented command; an agent rule may not
  require an unavailable executable without a fallback.
- **CO-13.** Every Context Operations release must ship fixture-based evals, a
  reproducible report, and **no unsubstantiated performance claims**.

## Success criteria

- At least 95% of context items in the acceptance corpus have resolvable
  provenance.
- 100% of accepted memory, rules and security findings in a selected package pass
  policy checks, with zero quiet drops of mandatory policy items.
- On the code-navigation corpus, retrieval surfaces a relevant source in the top
  five no worse than the deterministic baseline. Any improvement to the semantic
  ceiling is published only together with its methodology and raw fixtures.
- The context manifest and trace are reproducible from a single commit,
  configuration and input query.
- The agent can justify every recommendation by pointing at a source item.

## Risks

- Retrieval noise and over-extraction degrade both the quality and the cost of
  context.
- Automatic learning from tool or web output opens a prompt-injection and
  knowledge-poisoning channel.
- Integrating graph or vector databases too early inflates setup and breaks the
  local-first position.
- The new context layer may duplicate the future Agent Harness.

## Recommendation

The first vertical slice should be local: manifest, deterministic query planner,
trace, feedback ledger, and CLI/MCP parity. Graph and vector adapters, and
background consolidation jobs, should be added only after corpus-based evals.
