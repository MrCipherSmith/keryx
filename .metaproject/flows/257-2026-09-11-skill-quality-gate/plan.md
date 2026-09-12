# Implementation Plan

Status: draft — freezes when flow 256 closes; re-check context-map.md line numbers first.

## Approach

Extend what exists instead of adding parallel machinery:

- lint lives in `src/gdskills/bundled-eval.ts` as new check ids with reason-carrying
  exemptions and fixture tests, the way flow 256 added `frontmatter:harness-claude`;
- routing evals reuse the one scorer `scoreBundledSkillRoute` and extend the
  `ROUTING_BASELINE` shape (prompt → expected skill), not `src/eval/corpus.ts`;
- runtime variants: stop shipping byte-identical copies and make "falls back to SKILL.md" the
  normal export result instead of a warning.

Decisions:

- One description per skill. The router scores the catalog entry; a file-backed skill's catalog
  description must equal its SKILL.md frontmatter description (test-enforced), and rendered
  skills keep descriptionOverride. The `Use when ${purpose}` fallback is removed rather than
  reworded, so an entry without a description fails the catalog test.
- Anatomy required of workflow skills: a trigger + "NOT for" (description or body), a Red Flags /
  rationalization table, and a Verification / exit-criteria / STATUS section. Phase subagents
  (12, "NOT for: direct user invocation") are exempt with a reason; any other exemption needs a
  written reason in the exemption map.
- Length: a checked-in ceiling per skill at today's line count; a skill over its ceiling, or a new
  skill over 500 lines, is a finding. Ceilings only move down.
- Routing corpus: ≥3 positives (expected skill in top 3) and ≥2 negatives per bundled skill,
  every negative naming the skill that must outrank it; a rank-1 accuracy baseline that may not
  fall; a catalog-wide description-similarity check (error ≥ 0.75, reported ≥ 0.5) on the
  scorer's own tokenisation.

## Tasks (to add with `keryx flow task add` at freeze)

| Wave | Task | Kind |
|---|---|---|
| W1 | One description and one trigger list per skill: catalog = SKILL.md frontmatter (description and triggers) for file-backed skills, remove the purpose fallback, reconcile the SKILL.md trigger lists that still overlap | implement |
| W1 | `description:*` checks in bundled-eval: trigger phrase present, no "Use when <bare imperative>", ≤ 1024 chars; fixtures | implement |
| W1 | Runtime variants: delete the 88 identical SKILL.<runtime>.md copies (bundled + mirror), keep the 14 gproject builds, make export/install/tests treat the SKILL.md fallback as normal | implement |
| W2 | `anatomy:sections` check + exemption map with reasons; fixtures | implement |
| W2 | `anatomy:length` check + ceiling file + ratchet test; fixtures | implement |
| W2 | Routing corpus for every bundled skill + pairwise negatives + rank-1 baseline test | test |
| W2 | `description:collision` check in bundled-eval; fixtures | implement |
| W3 | Resolve the collisions the corpus and collision check surface: catalog triggers are already disjoint for interview/interviewer, test-gen/tests-creator and the review triggers (re-verification 2026-09-12), so the work is the SKILL.md trigger lists that still overlap (fixed by the one-trigger-list task) plus "check performance" (three-way tie perf-check / review-performance / review-flow-graph) and the implement/issue triggers | implement |
| W3 | Backfill Red Flags + Verification: quality workflow skills (commit, changelog, perf-check, test-gen, pr, push, security-audit, metaproject-security, db-migrate, deploy, dependency-update) | implement |
| W3 | Backfill: platform, planning and orchestration skills (claude-md-management, hookify, agent-entrypoint-distiller, brainstorm, interview, interviewer, feature-analyzer, job-documenter, pr-issue-documenter, flow-orchestrator, code-verifier, tests-creator, context-collector, job-orchestrator) | implement |
| W3 | Backfill: review skills (code-*-review, review-regression, review-core-boundaries, review-frontend-conventions, review-testing-practices, review-flow-graph) | implement |
| W3 | Carry-overs: xref sweeps orchestrator-prompt.md and prefers `.metaproject/...` spellings; trailing-period capture; frontmatter values via parseSkillFrontmatter; feature-dev/hookify/deploy stop hardcoding `npx tsc` | implement |
| W3 | Rejected-change ledger (file + section in skills-storage-workflow.mdc) | docs |
| W4 | Full verification; review round | verify, review |

## Risks

- Backfilling Red Flags into 40 skills can produce filler. Each table must name failures specific
  to that skill; review checks this, and "If removing it wouldn't change agent behaviour, remove
  it" is the bar.
- Deleting variant files touches export, install and four tests; the change is cut so a single
  task owns all of them.
- The routing corpus can be overfitted to the scorer; negatives must name an owner, and a rank
  baseline only ratchets up.
