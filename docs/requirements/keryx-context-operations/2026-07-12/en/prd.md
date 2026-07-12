# Keryx Context Operations — PRD
Version: 1.0.0

## Problem and goal

Project knowledge is currently distributed across valid Keryx sources but lacks
a single observable context-selection contract. The goal is a reproducible,
budgeted assembly that can explain every selected fact and improve only through
governed feedback.

## Requirements

- **CO-1–4:** bounded manifest, provenance/hash/score, progressive disclosure,
  validated Keryx sources.
- **CO-5–8:** deterministic default retrieval, explainable hybrid rerank,
  governed memory lifecycle, non-automatic feedback.
- **CO-9–11:** security gate, CLI/MCP parity, optional external adapters.
- **CO-12–13:** working development invocation, fixture-based evals and honest
  evidence.

## Success criteria and recommendation

Mandatory items have complete provenance and policy inclusion; context stays
within budget; optional intelligence never regresses the offline floor. Start
with an offline manifest/trace vertical slice, then add feedback, evals and
only subsequently optional adapters.

