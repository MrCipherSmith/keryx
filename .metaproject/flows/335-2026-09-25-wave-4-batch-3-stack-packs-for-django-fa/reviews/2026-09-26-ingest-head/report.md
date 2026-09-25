# PR #747 — final verification round at the merged PR head

Every finding below was originally raised in an earlier ingest for this
flow (2026-09-25-ingest-main: F-001..F-010; 2026-09-25-ingest-main-r03:
F-016..F-020) and was already restated + verified as `refuted` (citing
the real fixing commit SHAs) in 2026-09-25-ingest-main-r05 — which ran
against 2ba72932, a commit BEFORE the final `origin/main` merge landed
on this PR. `git diff 2ba72932 a6164669e03c3f32f21b69a9ec0d7a6bc7cef560
-- src/gdskills` is empty: the merge changed no file this flow touched.
Restated here again, verbatim, targeting the actual PR head
(a6164669e03c3f32f21b69a9ec0d7a6bc7cef560) so the completion gate's
head-commit condition has a round that ran against the real head, not a
stale one.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "review-orchestrator",
    "severity": "major",
    "problem": "the prompt gave both methods default @Transactional propagation, under which subtle_wrong's \"nothing to fix\" answer was essentially correct.",
    "impact": "not recorded: derived from a markdown review report, which carried no impact field",
    "suggested_fix": "not recorded: derived from a markdown review report, which carried no suggested_fix field",
    "evidence": "not recorded: derived from a markdown review report, which carried no evidence field",
    "confidence": "low",
    "file": "src/gdskills/bundled/stacks/java-kotlin-spring/skills/java-kotlin-spring-implementation/evals.json",
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/stacks/java-kotlin-spring/skills/java-kotlin-spring-implementation/evals.json#transactional-self-invocation"
      ],
      "enumeration_method": "restated verbatim from 2026-09-25-ingest-main, via 2026-09-25-ingest-main-r05"
    },
    "global_id": "2026-09-25-ingest-main#F-001"
  },
  {
    "id": "F-002",
    "reviewer": "review-orchestrator",
    "severity": "major",
    "problem": "subtle_wrong described the standard, legitimate post-rollout column-drop pattern.",
    "impact": "not recorded: derived from a markdown review report, which carried no impact field",
    "suggested_fix": "not recorded: derived from a markdown review report, which carried no suggested_fix field",
    "evidence": "not recorded: derived from a markdown review report, which carried no evidence field",
    "confidence": "low",
    "file": "src/gdskills/bundled/stacks/django/skills/django-migrate/evals.json",
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/stacks/django/skills/django-migrate/evals.json#stage-destructive-column-drop"
      ],
      "enumeration_method": "restated verbatim from 2026-09-25-ingest-main, via 2026-09-25-ingest-main-r05"
    },
    "global_id": "2026-09-25-ingest-main#F-002"
  },
  {
    "id": "F-003",
    "reviewer": "review-orchestrator",
    "severity": "major",
    "problem": "detectionMarkers included bare java/kotlin tags, firing on every kotlin-android project too.",
    "impact": "not recorded: derived from a markdown review report, which carried no impact field",
    "suggested_fix": "not recorded: derived from a markdown review report, which carried no suggested_fix field",
    "evidence": "not recorded: derived from a markdown review report, which carried no evidence field",
    "confidence": "low",
    "file": "src/gdskills/bundled/stacks/java-kotlin-spring/pack.json",
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/stacks/java-kotlin-spring/pack.json#detectionMarkers",
        "src/gdskills/bundled/install-manifest.json#components.framework:java-kotlin-spring.detectionMarkers"
      ],
      "enumeration_method": "restated verbatim from 2026-09-25-ingest-main, via 2026-09-25-ingest-main-r05"
    },
    "global_id": "2026-09-25-ingest-main#F-003"
  },
  {
    "id": "F-004",
    "reviewer": "review-orchestrator",
    "severity": "major",
    "problem": "worked examples reproduced their own pack's eval scenario content near-verbatim.",
    "impact": "not recorded: derived from a markdown review report, which carried no impact field",
    "suggested_fix": "not recorded: derived from a markdown review report, which carried no suggested_fix field",
    "evidence": "not recorded: derived from a markdown review report, which carried no evidence field",
    "confidence": "low",
    "file": "java-kotlin-spring-code-review/SKILL.md",
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/stacks/java-kotlin-spring/skills/java-kotlin-spring-code-review/SKILL.md",
        "src/gdskills/bundled/stacks/java-kotlin-spring/skills/java-kotlin-spring-implementation/SKILL.md",
        "src/gdskills/bundled/stacks/java-kotlin-spring/skills/java-kotlin-spring-migrate/SKILL.md",
        "src/gdskills/bundled/stacks/fastapi/skills/fastapi-build-fix/SKILL.md",
        "src/gdskills/bundled/stacks/django/skills/django-testing/SKILL.md"
      ],
      "enumeration_method": "restated verbatim from 2026-09-25-ingest-main, via 2026-09-25-ingest-main-r05"
    },
    "global_id": "2026-09-25-ingest-main#F-004"
  },
  {
    "id": "F-005",
    "reviewer": "review-orchestrator",
    "severity": "minor",
    "problem": "adding @field_validator to a class-Config-only model is a deprecation warning in Pydantic v2, not an error.",
    "impact": "not recorded: derived from a markdown review report, which carried no impact field",
    "suggested_fix": "not recorded: derived from a markdown review report, which carried no suggested_fix field",
    "evidence": "not recorded: derived from a markdown review report, which carried no evidence field",
    "confidence": "low",
    "file": "src/gdskills/bundled/stacks/fastapi/skills/fastapi-build-fix/evals.json",
    "global_id": "2026-09-25-ingest-main#F-005"
  },
  {
    "id": "F-006",
    "reviewer": "review-orchestrator",
    "severity": "minor",
    "problem": "clippy::needless_clone does not exist as a real lint.",
    "impact": "not recorded: derived from a markdown review report, which carried no impact field",
    "suggested_fix": "not recorded: derived from a markdown review report, which carried no suggested_fix field",
    "evidence": "not recorded: derived from a markdown review report, which carried no evidence field",
    "confidence": "low",
    "file": "src/gdskills/bundled/stacks/rust/skills/rust-build-fix/SKILL.md",
    "global_id": "2026-09-25-ingest-main#F-006"
  },
  {
    "id": "F-007",
    "reviewer": "review-orchestrator",
    "severity": "minor",
    "problem": "the two skills' descriptions pointed a Django major-version-upgrade request at each other in a loop.",
    "impact": "not recorded: derived from a markdown review report, which carried no impact field",
    "suggested_fix": "not recorded: derived from a markdown review report, which carried no suggested_fix field",
    "evidence": "not recorded: derived from a markdown review report, which carried no evidence field",
    "confidence": "low",
    "file": "src/gdskills/bundled/stacks/django/skills/django-implementation/SKILL.md",
    "global_id": "2026-09-25-ingest-main#F-007"
  },
  {
    "id": "F-008",
    "reviewer": "review-orchestrator",
    "severity": "minor",
    "problem": "subtle_wrong used prefetch_related on the correct relation, which passes the stated fail_criteria.",
    "impact": "not recorded: derived from a markdown review report, which carried no impact field",
    "suggested_fix": "not recorded: derived from a markdown review report, which carried no suggested_fix field",
    "evidence": "not recorded: derived from a markdown review report, which carried no evidence field",
    "confidence": "low",
    "file": "src/gdskills/bundled/stacks/django/skills/django-implementation/evals.json",
    "global_id": "2026-09-25-ingest-main#F-008"
  },
  {
    "id": "F-009",
    "reviewer": "review-orchestrator",
    "severity": "minor",
    "problem": "no c-cpp near-miss negative existed for the cargo-vs-CMake/C++ collision; one positive trigger read awkwardly.",
    "impact": "not recorded: derived from a markdown review report, which carried no impact field",
    "suggested_fix": "not recorded: derived from a markdown review report, which carried no suggested_fix field",
    "evidence": "not recorded: derived from a markdown review report, which carried no evidence field",
    "confidence": "low",
    "file": "src/gdskills/bundled/stacks/rust/skills/rust-build-fix/evals.json",
    "global_id": "2026-09-25-ingest-main#F-009"
  },
  {
    "id": "F-010",
    "reviewer": "review-orchestrator",
    "severity": "minor",
    "problem": "@MockBean is deprecated since Spring Boot 3.4 in favor of @MockitoBean.",
    "impact": "not recorded: derived from a markdown review report, which carried no impact field",
    "suggested_fix": "not recorded: derived from a markdown review report, which carried no suggested_fix field",
    "evidence": "not recorded: derived from a markdown review report, which carried no evidence field",
    "confidence": "low",
    "file": "src/gdskills/bundled/stacks/java-kotlin-spring/skills/java-kotlin-spring-testing/SKILL.md",
    "global_id": "2026-09-25-ingest-main#F-010"
  },
  {
    "id": "F-016",
    "reviewer": "review-orchestrator",
    "severity": "major",
    "problem": "the round-1 rewrite kept the exact pydantic-mismatch-not-any scenario, now sharing the NotificationSettings identifier too.",
    "impact": "not recorded: derived from a markdown review report, which carried no impact field",
    "suggested_fix": "not recorded: derived from a markdown review report, which carried no suggested_fix field",
    "evidence": "not recorded: derived from a markdown review report, which carried no evidence field",
    "confidence": "low",
    "file": "src/gdskills/bundled/stacks/fastapi/skills/fastapi-build-fix/SKILL.md",
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/stacks/fastapi/skills/fastapi-build-fix/SKILL.md"
      ],
      "enumeration_method": "restated verbatim from 2026-09-25-ingest-main-r03, via 2026-09-25-ingest-main-r05"
    },
    "global_id": "2026-09-25-ingest-main-r03#F-016"
  },
  {
    "id": "F-017",
    "reviewer": "review-orchestrator",
    "severity": "minor",
    "problem": "subtle_wrong's own text named its mistake instead of presenting it with confidence.",
    "impact": "not recorded: derived from a markdown review report, which carried no impact field",
    "suggested_fix": "not recorded: derived from a markdown review report, which carried no suggested_fix field",
    "evidence": "not recorded: derived from a markdown review report, which carried no evidence field",
    "confidence": "low",
    "file": "src/gdskills/bundled/stacks/django/skills/django-implementation/evals.json",
    "global_id": "2026-09-25-ingest-main-r03#F-017"
  },
  {
    "id": "F-018",
    "reviewer": "review-orchestrator",
    "severity": "minor",
    "problem": "the rubric's permissive branch conflicted with fail_criteria's unconditional rejection.",
    "impact": "not recorded: derived from a markdown review report, which carried no impact field",
    "suggested_fix": "not recorded: derived from a markdown review report, which carried no suggested_fix field",
    "evidence": "not recorded: derived from a markdown review report, which carried no evidence field",
    "confidence": "low",
    "file": "src/gdskills/bundled/stacks/django/skills/django-migrate/evals.json",
    "global_id": "2026-09-25-ingest-main-r03#F-018"
  },
  {
    "id": "F-019",
    "reviewer": "review-orchestrator",
    "severity": "minor",
    "problem": "the renamed ArticleDetailView still sat under a billing/tests/ path.",
    "impact": "not recorded: derived from a markdown review report, which carried no impact field",
    "suggested_fix": "not recorded: derived from a markdown review report, which carried no suggested_fix field",
    "evidence": "not recorded: derived from a markdown review report, which carried no evidence field",
    "confidence": "low",
    "file": "src/gdskills/bundled/stacks/django/skills/django-testing/SKILL.md",
    "global_id": "2026-09-25-ingest-main-r03#F-019"
  },
  {
    "id": "F-020",
    "reviewer": "review-orchestrator",
    "severity": "info",
    "problem": "the near-miss negative named the language distinction outright.",
    "impact": "not recorded: derived from a markdown review report, which carried no impact field",
    "suggested_fix": "not recorded: derived from a markdown review report, which carried no suggested_fix field",
    "evidence": "not recorded: derived from a markdown review report, which carried no evidence field",
    "confidence": "low",
    "file": "src/gdskills/bundled/stacks/rust/skills/rust-build-fix/evals.json",
    "global_id": "2026-09-25-ingest-main-r03#F-020"
  }
]
```
