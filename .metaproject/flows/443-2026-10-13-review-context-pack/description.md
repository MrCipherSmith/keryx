# Review context pack: metaproject layers as reviewer context

Status: registered, criteria not frozen (the 30 criteria were read by the operator on 2026-10-13 with no edits; the freeze is still to be done)
Source: user description (origin: agent-proposal). Full PRD and criteria: `docs/requirements/keryx-review-context-pack/` (PR 990).

## Problem

A keryx review round runs inside a metaproject, yet the reviewers do not use it. On the PR 7659 comparison the blast radius was computed (40 of 795 files) but no reviewer used it; reviewers did not receive the wiki page for the touched module, past decisions from memory, the covering tests from the testing context, or the earlier rounds of the flow the review belongs to. Every reviewer got the same 58 KB `review_context` (39 KB PR body, 15 KB scope), not filtered per reviewer and not built from the graph. The native package built the plumbing (`MetaprojectPort`); the review path does not call it.

## Expected Outcome

A review round assembles, per reviewer, a context slice drawn from the metaproject layers (graph blast radius and callers, wiki domain rules, memory decisions and constraints, covering tests, the flow's state and earlier rounds), with provenance and freshness recorded, degradation visible (`used|unavailable|not-relevant|stale`, never a silent `0`), and findings able to cite the context they relied on. The effect is measured against the PR 7659 baseline with and without the layers.

## Outcome criteria

- Источник: docs/requirements/keryx-review-context-pack/prd.md; ~/notes/review-depth-gap-7659.md (the review-depth comparison on PR 7659 and the flow 417 AC16 run); operator audit request helyx message 199859 (2026-10-12): «также еще проверь как используются wiki, graph и другие инструменты именно метапроджекта используются ли они как-то для review и помогают ли они»; operator answers in polls 152 and 154 (2026-10-13). No verbatim request to build this exists; the flow is the agent's proposal from the audit.
- Эффект (формализация агента): each reviewer payload references a versioned context pack and carries only the layer sections its role needs; a layer that cannot be read is recorded as `unavailable` or `stale`, never as zero; a finding may cite the pack section it relied on; the replay on PR 7659 shows the effect of the layers and names every layer that added cost and produced no cited finding.
- Как наблюдать (предложение агента): `keryx review context` on a round prints the pack with per-layer status, source, generation time and hash; the replay report compares layers-off and layers-on on PR 7659 and PR 7840 and lists layers that did not pay for themselves; the operator decides on keeping each one default-on.

## Relation to other flows

- Flow 431 (layer refresh and chunked passes) keeps the graph, wiki and memory fresh and records which layer each reviewer used. This flow builds the per-reviewer context from those layers. Poll 154 (2026-10-13) made them two flows.
- Flow 428 (depth parity) owns the pull-request section of the pack, the reviewer set and the mutation pass. Per its Decision 5 one flow builds both the pull-request section and the layer sections; this flow adds the layer sections to the builder.

## Out of Scope

- The reviewer set, the mutation pass, severity rules and the evidence floor (flow 428).
- Which module owns graph, wiki, memory or flow data.
- Writing to the metaproject from a review (layers are read-only).
- Policy-context enrichment of the permission engine (native MP-6).
- A new review skill per layer; the layers feed the existing reviewers.
