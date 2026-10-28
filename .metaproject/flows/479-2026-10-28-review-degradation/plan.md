# Implementation Plan

Status: approved with the frozen PRD.

## Approach

Add the reviewer beside `review-regression` and leave that skill and its screen alone. Mirror how `review-regression` is registered (catalog, ceilings, install manifest, bundle copy, coverage and caps lists) and add one ingest screen for the evidence rule, enforced in code because gates written only in skill prose do not hold.

## Steps

1. Schema: optional `degradation_class` and `evidence_kind` on a finding, every copy (AC3).
2. Skill text and bundled copy, catalog, ceiling, manifest entries (AC1, AC2, AC11).
3. Ingest screen `degradation-no-evidence` and its `scope.md` heading (AC4).
4. Payload: consumers of changed shared exports from `gdgraph affected`, capped and recorded (AC5).
5. Profile and routing: `full` only, delta round only when a shared symbol is touched (AC6).
6. TUI: class, evidence kind and unproven marker in the review panel and inspector (AC7).
7. `review-orchestrator` text in both copies (AC8); README, docs-site guide, CHANGELOG (AC9).
8. Trial on 3 to 5 operator PRs and the cost and effectiveness report; operator decides on promotion (AC10, AC12).

## Risks

- The ingest screen must not reject true findings: it downgrades to `info`, never drops.
- The orchestrator skill has a line ceiling; the added text must fit or the ceiling is raised on purpose.
- The trial uses private data: ground truth stays in the scratchpad and the public report holds counts and classes only.
