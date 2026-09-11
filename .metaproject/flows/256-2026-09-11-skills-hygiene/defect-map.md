# Verified defect map (dispatch 252-T1, 2026-09-11)

Verified in the current tree by a read-only worker. `bun ./src/cli.ts skills verify --bundled`:
exit 0, 67 skills, 169 documents, 0 findings — every defect below passes today's gate.
Rules mirror is byte-identical to bundled; skills mirror identical except 11 rendered-only
dirs (catalog.ts). Every bundled edit must be mirrored and applied to all runtime builds.

Pinning tests: install.test.ts:99-120 (rule mirror identity), enforcement-claims.test.ts:25-26,
build-parity.test.ts:129-169, installed-registry-integrity.test.ts:72,112,
lockfile-detection.test.ts:16,36-38 (code-verifier lockfile lines), destructive-git.test.ts:25,65,
task-implementer-contract.test.ts:355-357, review-skills-iron-laws.test.ts:231 (expects "review-strict"),
routing-baseline / skills-route / trigger-reachability tests (score BUNDLED_GDSKILLS).

- D1 CONFIRMED: rules/core/review-agent-profile.mdc == code-review-ai-assistant.mdc; zero references.
  install.ts:91-97 copies the rules dir and never prunes, so installs keep retired rules.
- D2 CONFIRMED: review-orchestrator SKILL.md :163 default `current`, :655/:666 current-model rules,
  `current` allowed at :1602/:1756/:1797; "strict synthesis" :649/:663; new rule at :61, :77-93;
  job-orchestrator :1080-1081 says `current` is gone. review-strict-profile.mdc: no live references.
- D3 CONFIRMED: code-verifier :301 "after 2 iterations" (job-orchestrator :1227 and test-gen :61 say 3);
  code-verifier :86-87 npx eslint/biome + tsc/jest table; test-gen :59 `npx jest`;
  tests-creator :67 `cat | grep`, :70 `ls`, :73 `find`. Prescribed: task-implementer :343-358 §5.1
  (`keryx health run --changed --source eslint,typescript`, `keryx test run --changed --strict`).
- D4 CONFIRMED: job-orchestrator :613-624,:648 writes `<job>/context_v<N>.md`; 24 files incl. the
  producer context-collector use `<job>/ai/context.md` (context-collector :42,:127 + output schema
  :27-28,:143,:168; task-implementer :161,:647 + input schema :136; review-orchestrator :160,:1887;
  review-pr-feedback; review-style/backend/security-code; code-ai-review :194; issue-analyzer :364;
  pr-issue-documenter :371,:378). No code writes either (src/job/service.ts:90-128). Target: ai/context.md.
- D5 CONFIRMED: skills-storage-workflow.mdc :86 dead `.metaproject/rules/schemas/`, :71 antigravity in
  mapping but not layout :24-28, duplicate step 3 :78-79; rule-management-workflow.mdc :2,:17,:31
  AGENTS.mdc / "AGENTS.md catalog", :15 wrong source of truth; execution-metrics.md :41 nonexistent
  post-commit metrics hook (update.ts:439-477); `.cursor/rules/core` in feature-analyzer :278 (+codex),
  task-implementer :225 (+zed); `skills/shared/git-merge-base.md` in 11 review skills;
  `skills/review/review-orchestrator/*.schema.json` at review-orchestrator :457,:1315,:1338.
  bundled-eval.ts:402-435 rewrites `skills/gdskills/`→`skills/` and resolves in the bundled root, so
  source-only paths pass; the sweep (:455-513) reads skill documents only, never rules.
  Check sync.ts:27 and sync-global.test.ts:16 when editing the sync section.
- D6 PARTIAL: duplicated frontmatter keys REFUTED (none). `claude` missing from compatible_harnesses
  on 12 SKILL.md (tests-creator, pr-issue-documenter, prd-creator, code-style-review, code-learned-review,
  code-mobx-store-review, code-ai-review, code-verifier, feature-analyzer, context-collector,
  issue-analyzer, job-documenter) against build-parity.test.ts:129-136; 17 have no field.
  23 metadata.category values differ from catalog.ts. compatible_harnesses read only by
  bundled-eval.ts:297-302 and tests.
- D7 CONFIRMED: catalog.ts:481-498 (:492 `Use when ${purpose}`), 11 rendered skills affected.
- D8 CONFIRMED: src/lib/templates.ts:1736-1788 extractAgentRuleBody strips keryx:index; heading-only
  body is non-empty so fallback (:1747) never fires. Generator: src/rules/agent-entrypoints.ts:24-64.
- D9 CONFIRMED: error-handling.mdc:100 vs async-patterns.mdc:80; layouts: requirements-package-standard
  :11-21 (followed by docpack-orchestrator :22,:40,:64, templates.ts:234, real docs/requirements/*) vs
  documentation-management :43-44,:63 dated vs implementation-plans :39 ru/en/ai;
  skill-lifecycle.mdc:47-48 vs model-selection.mdc:115-134.
- D10 CONFIRMED: no rule on stash/pathspecs/git -C/worktrees; task-implementer :401 bans reset/clean;
  job-orchestrator uses git -C (:188,:677-680); flow-orchestrator has no destructive-git guidance;
  destructive-git.test.ts:4-30,:65 patterns.
- D11 CONFIRMED: 8 stack rules carry only description + alwaysApply:false; nothing reads alwaysApply/globs;
  src/review/stack.ts:190-222 reads skill metadata.stack_requires (review skills only);
  .metaproject/rules/README.md says nothing about core/.
- D12 CONFIRMED: entity-skill-verifier (catalog.ts:64) claims claim-vs-code comparison; verify.ts:293-311
  is structural; project-skills SKILL.md :104 "not verified" static footer (project-skills.ts:550) vs
  verification.md "fresh".

Related existing infra for flow 253: routing-baseline.test.ts, skills-route.test.ts,
trigger-reachability.test.ts already score BUNDLED_GDSKILLS routing.
