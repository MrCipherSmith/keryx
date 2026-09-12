# Context map for flow 257 (dispatch 257-T1, 2026-09-11)

Collected read-only while flow 256 was in review. Line numbers are as of the
skills/quality-program branch after flow 256's round-1 fixes; re-locate before editing.

## Routing infrastructure (reuse, do not duplicate)

- One scorer: `scoreBundledSkillRoute(entry: BundledSkill, query)` — src/commands/skills.ts:501-559,
  also behind `keryx skills route` (routeProjectSkills :334-406). Deterministic additive points:
  exact name +100, trigger hit +55 (triggerFires/containsPhrase :435-499, word-boundary with an
  inflection whitelist, order-free fallback), name substring +30, token overlap +10/token
  (routeTokens :699-716, stopwords, Russian prefix expansion :632-684).
- Haystack = name + description + purpose + workflow[] + triggers[] of the BundledSkill
  (src/gdskills/catalog.ts:3-11) — i.e. the CATALOG entry, not the SKILL.md frontmatter.
- Checked-in baseline: src/commands/routing-baseline.ts `ROUTING_BASELINE: BaselineEntry[]`
  (:29-37 query, top, score, verdict, note) asserted exactly by routing-baseline.test.ts:16-37;
  :81-93 guards against a second scorer. trigger-reachability.test.ts:78 snapshots unreachable
  triggers.
- A per-skill corpus should extend the BaselineEntry shape (prompt → expected skill), NOT
  src/eval/corpus.ts (`CorpusCase` is binary positive/negative for detectors).
- A description-collision check belongs in bundled-eval.ts as a new check id.

## bundled-eval.ts (layer one)

- Checks are ids in `BUNDLED_SKILL_CHECKS` (:97-114, 16 ids incl. flow 256's
  frontmatter:harness-claude and frontmatter:category); implemented imperatively inside
  `evaluateBundledTree` (:705-961) via a per-loop `add(check, line, message)`; findings
  `{check, skill, file, line, message}`; report `renderBundledEvaluation` (:972-1028) prints every
  check even at zero and a fixed "what this did NOT check" disclaimer.
- Exemptions are reason-carrying maps/sets asserted non-empty with reasons in tests:
  KNOWN_EXTERNAL_SKILL_REFERENCES, GENERATED_PATH_ROOTS, KNOWN_SKILL_COMPANION_DOCUMENTS,
  BUILD_DIVERGENCE_ALLOWED_FIELDS, PLACEHOLDER_ACCOUNTS, HARNESS_HOME_ROOTS.
- Fixtures: bundled-eval.test.ts writes tmp skill trees (writeSkill/writeSkillFile/writeRule),
  one broken SKILL.md per violation + a CONTROL_SKILL; :680-689 requires every declared check id
  to be exercised; denominators asserted non-vacuous.
- Info carry-overs from flow 256 review: L-005 harness/category values read by single-line regex
  (use parseSkillFrontmatter); L-006 PATH_REFERENCE captures a trailing sentence period;
  orchestrator-prompt.md files are not swept by xref.

## Anatomy survey (67 bundled SKILL.md)

Totals: "When to Use" heading 11/67; NOT-for 28/67; Red Flags table 18/67; Iron Laws 31/67;
Verification / exit / STATUS section 25/67.

Largest: job-orchestrator 2187, review-orchestrator 1926, review-pr-feedback 894,
task-implementer 659, context-collector 655, flow-orchestrator 640, review-frontend 636,
review-highload 552, review-clean-code 545.

Phase subagents (description ends "NOT for: direct user invocation") — exemption candidates:
autodoc-analyst, autodoc-architect, autodoc-assembler, autodoc-scanner, autodoc-writer,
consistency-checker, planner, problem-definer, project-discovery, spec-writer, stack-advisor,
patterns-researcher.

Workflow skills with none of Red Flags / Verification (backfill candidates): commit, changelog,
perf-check, test-gen, pr, push, security-audit, metaproject-security, db-migrate,
claude-md-management, hookify, agent-entrypoint-distiller, brainstorm, interview, interviewer,
code-style-review, code-learned-review, code-mobx-store-review, code-ai-review, feature-analyzer,
job-documenter, pr-issue-documenter, review-regression, review-core-boundaries,
review-frontend-conventions, review-testing-practices, review-flow-graph (Iron Laws only);
flow-orchestrator, code-verifier, tests-creator, context-collector, job-orchestrator have
Verification but no Red Flags.

## Descriptions

- SKILL.md frontmatter: 0 "Use when <bare imperative>" hits (they use "Use when: …" or gerunds);
  1 without a trigger phrase: planning/interview ("Use to clarify …"). Max 625 chars; none > 1024.
- Catalog (BUNDLED_GDSKILLS, 78 entries): 11 carry descriptionOverride (flow 256); the other 67
  fall back to `Use when ${purpose}` (catalog.ts ~:509), and 52 of those read as
  "Use when review/run/create/…" — hookify renders "Use when use hook guidance…". The catalog
  description is what the router scores, so SKILL.md and catalog descriptions can drift: there is
  no single description per skill.

## Collisions (trigger/description level)

- interview vs interviewer: both carry "Clarify requirements", "Gather requirements"
  (interview:6-7,10; interviewer:7-8).
- test-gen vs tests-creator: "Generate tests"/"Write tests for"/"Add tests" vs "Create
  tests"/"Write tests first" — a bare "write tests" is ambiguous.
- job-orchestrator lists "Full review", "Review my code" (:11-13) — review-orchestrator owns
  "review"/"code review"; job/flow/feature-dev all fire on implement/issue/feature.
- perf-check vs review-performance: bundle size / slow.
- Not real collisions: the three security skills (disjoint scopes); claude-md-management vs
  agent-entrypoint-distiller (add vs split). hook-manager and agent-entrypoint-manager DO exist
  (rendered-only from catalog.ts), contrary to one worker's report — include them in the check.

## Runtime variants

- 102 SKILL.<runtime>.md files: 88 byte-identical to SKILL.md; 14 differ only by one
  `compatible_harnesses: "cursor,codex,zed,opencode"` line (the 7 gproject-* skills' codex+cursor
  builds, allowed by BUILD_PARITY_ALLOWANCES / BUILD_DIVERGENCE_ALLOWED_FIELDS).
- export.ts resolveSkillBuild (:54-70) already falls back to SKILL.md (reports fallback:true);
  no script generates the bundled variants — they are hand-maintained. install.ts copies the
  whole bundled dir (:65-66). npm ships src/gdskills/bundled verbatim (package.json files).
- Deleting the 88 copies breaks: build-parity.test.ts census floor (CENSUS_FLOOR=94),
  round-bound.test.ts:108-118, status-contract.test.ts:116-143 (buildsChecked), 
  agent-catalogue-xref.test.ts:194-197 (>100 files, a SKILL.codex.md exists), bundled-eval
  documents denominator and document:build-parity; export would report fallback:true for those
  skills — that must become the normal, non-warning case.

## Rejected-change ledger

Best home: rules/core/skills-storage-workflow.mdc (the skill-authoring rule), plus a ledger file.
skill-lifecycle.mdc's skill-changelog records applied learn changes only.

## Other carry-overs

- feature-dev, hookify, deploy hardcode `npx tsc --noEmit` (flow 256 journal).
- Bare `skills/gdskills/...` and 2-segment `skills/<category>/<name>` spellings are accepted by xref
  but inconsistent with `.metaproject/...` used elsewhere.

## Re-verification 2026-09-12 (dispatch 257-T1, after flow 256 merged as #533)

Corrections to the sections above; everything not listed held up.

- Routing: scorer and baseline locations unchanged; `ROUTING_BASELINE` is routing-baseline.ts:39-66
  (27 entries); the exact assertion loop is routing-baseline.test.ts:27-38. The scorer reads only the
  catalog entry — SKILL.md frontmatter triggers are a second, unscored trigger list.
- Collisions in the CATALOG (what the router scores): interview/interviewer, job-orchestrator's
  review triggers, and test-gen/tests-creator are already disjoint (catalog.ts:354-363, :88, :148,
  :295, :300); live `skills route` puts the owner first for "clarify requirements", "review my code",
  "full review", "write tests", "generate tests". The earlier collision list came from SKILL.md
  frontmatter triggers, which still overlap — fixing that is the "one trigger list" half of AC1.
- Open collision: "check performance" is a three-way tie at 20 by token overlap between perf-check,
  review-performance and review-flow-graph, no trigger hit (review-performance's trigger is
  "perf check", word order differs). "why is it slow" resolves to review-performance.
- Descriptions: all 67 fallback catalog descriptions (not 52) read "Use when <imperative>" — the
  formula at catalog.ts:509 always yields it. Max catalog description 432 chars.
- Anatomy (67 SKILL.md): NOT-for 31/67, Iron Laws 35/67, Red Flags 18/67, "When to Use" heading
  11/67; a Verification/exit/STATUS count is definition-dependent (7-35) — anatomy:sections must pin
  the definition. Largest: job-orchestrator 2233, review-orchestrator 1928, review-pr-feedback 895,
  flow-orchestrator 681, task-implementer 669, context-collector 656, review-frontend 637,
  review-highload 553, review-clean-code 546, feature-analyzer 425.
- Missing both Red Flags and Verification (31): agent-entrypoint-distiller, brainstorm, changelog,
  claude-md-management, code-ai-review, code-learned-review, code-mobx-store-review,
  code-style-review, commit, db-migrate, dependency-update, deploy, docpack-orchestrator,
  feature-analyzer, hookify, interview, interviewer, metaproject-security, perf-check, pr,
  pr-issue-documenter, prd-creator, push, review-core-boundaries, review-flow-graph,
  review-frontend-conventions, review-regression, review-testing-practices, reviewer-skill-creator,
  security-audit, test-gen. flow-orchestrator, code-verifier, tests-creator, context-collector,
  job-orchestrator have Verification but no Red Flags.
- Variants: 102 files, 88 identical, 14 differ (7 planning/* skills × cursor+codex, one
  compatible_harnesses line). build-parity CENSUS_FLOOR is 37 (declared :94, asserted :434, :566),
  not 94.
- Carry-overs still true: `npx tsc --noEmit` in feature-dev:92, deploy:44, hookify:91; xref does not
  sweep orchestrator-prompt.md; L-005 half-fixed (description via parseSkillFrontmatter, but
  frontmatter:category :803 and harness-claude :824 still regex); L-006 trailing period (:460).
