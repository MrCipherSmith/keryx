# Context map for flow 253 (dispatch 253-T1, 2026-09-11)

Collected read-only while flow 252 was in review. Line numbers are as of the
skills/quality-program branch after flow 252's round-1 fixes; re-locate before editing.

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

- Checks are ids in `BUNDLED_SKILL_CHECKS` (:97-114, 16 ids incl. flow 252's
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
- Info carry-overs from flow 252 review: L-005 harness/category values read by single-line regex
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
- Catalog (BUNDLED_GDSKILLS, 78 entries): 11 carry descriptionOverride (flow 252); the other 67
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

- feature-dev, hookify, deploy hardcode `npx tsc --noEmit` (flow 252 journal).
- Bare `skills/gdskills/...` and 2-segment `skills/<category>/<name>` spellings are accepted by xref
  but inconsistent with `.metaproject/...` used elsewhere.
