# PR #747 — all round-1/round-2 findings, restated for verification-in-same-round

Every finding below was originally raised in an earlier ingest for this
flow (2026-09-25-ingest-main: F-001..F-010; 2026-09-25-ingest-main-r03:
F-016..F-020) and already carries an `acted-on` disposition citing its
fixing commit SHA there. Restated here, verbatim, in the SAME round as
the accompanying `--verifications` file so the verifier's `refuted`
claims can attach (the mechanism refuses a claim against a finding not
reported in its own round).

- [F-001] major: Spring self-invocation eval failed a technically correct answer
  - Severity: major
  - File: src/gdskills/bundled/stacks/java-kotlin-spring/skills/java-kotlin-spring-implementation/evals.json#transactional-self-invocation
  - Problem: the prompt gave both methods default @Transactional propagation, under which subtle_wrong's "nothing to fix" answer was essentially correct.
  - Class_scope: sites: ["src/gdskills/bundled/stacks/java-kotlin-spring/skills/java-kotlin-spring-implementation/evals.json#transactional-self-invocation"] enumeration_method: "restated verbatim from 2026-09-25-ingest-main"

- [F-002] major: Django column-drop subtle_wrong was a legitimate deploy pattern
  - Severity: major
  - File: src/gdskills/bundled/stacks/django/skills/django-migrate/evals.json#stage-destructive-column-drop
  - Problem: subtle_wrong described the standard, legitimate post-rollout column-drop pattern.
  - Class_scope: sites: ["src/gdskills/bundled/stacks/django/skills/django-migrate/evals.json#stage-destructive-column-drop"] enumeration_method: "restated verbatim from 2026-09-25-ingest-main"

- [F-003] major: java-kotlin-spring pack installed on every JVM project, including Android
  - Severity: major
  - File: src/gdskills/bundled/stacks/java-kotlin-spring/pack.json, src/gdskills/bundled/install-manifest.json
  - Problem: detectionMarkers included bare java/kotlin tags, firing on every kotlin-android project too.
  - Class_scope: sites: ["src/gdskills/bundled/stacks/java-kotlin-spring/pack.json#detectionMarkers", "src/gdskills/bundled/install-manifest.json#components.framework:java-kotlin-spring.detectionMarkers"] enumeration_method: "restated verbatim from 2026-09-25-ingest-main"

- [F-004] major: eval answer-key content copied into 5 SKILL.md files
  - Severity: major
  - File: java-kotlin-spring-code-review/SKILL.md, java-kotlin-spring-implementation/SKILL.md, java-kotlin-spring-migrate/SKILL.md, fastapi-build-fix/SKILL.md, django-testing/SKILL.md
  - Problem: worked examples reproduced their own pack's eval scenario content near-verbatim.
  - Class_scope: sites: ["src/gdskills/bundled/stacks/java-kotlin-spring/skills/java-kotlin-spring-code-review/SKILL.md", "src/gdskills/bundled/stacks/java-kotlin-spring/skills/java-kotlin-spring-implementation/SKILL.md", "src/gdskills/bundled/stacks/java-kotlin-spring/skills/java-kotlin-spring-migrate/SKILL.md", "src/gdskills/bundled/stacks/fastapi/skills/fastapi-build-fix/SKILL.md", "src/gdskills/bundled/stacks/django/skills/django-testing/SKILL.md"] enumeration_method: "restated verbatim from 2026-09-25-ingest-main"

- [F-005] minor: Pydantic scenario premise was technically wrong
  - Severity: minor
  - File: src/gdskills/bundled/stacks/fastapi/skills/fastapi-build-fix/evals.json#pydantic-mismatch-not-any
  - Problem: adding @field_validator to a class-Config-only model is a deprecation warning in Pydantic v2, not an error.

- [F-006] minor: Clippy lint name needless_clone was not real
  - Severity: minor
  - File: src/gdskills/bundled/stacks/rust/skills/rust-build-fix/SKILL.md, evals.json
  - Problem: clippy::needless_clone does not exist as a real lint.

- [F-007] minor: Django upgrade routing pointed both ways
  - Severity: minor
  - File: src/gdskills/bundled/stacks/django/skills/django-implementation/SKILL.md, django-migrate/SKILL.md
  - Problem: the two skills' descriptions pointed a Django major-version-upgrade request at each other in a loop.

- [F-008] minor: select_related scenario contradicted its own fail_criteria
  - Severity: minor
  - File: src/gdskills/bundled/stacks/django/skills/django-implementation/evals.json#select-related-n1
  - Problem: subtle_wrong used prefetch_related on the correct relation, which passes the stated fail_criteria.

- [F-009] minor: negative triggers skipped the closest sibling pack
  - Severity: minor
  - File: src/gdskills/bundled/stacks/rust/skills/rust-build-fix/evals.json, rust-implementation/evals.json
  - Problem: no c-cpp near-miss negative existed for the cargo-vs-CMake/C++ collision; one positive trigger read awkwardly.

- [F-010] minor: Spring testing recommended deprecated @MockBean
  - Severity: minor
  - File: src/gdskills/bundled/stacks/java-kotlin-spring/skills/java-kotlin-spring-testing/SKILL.md, rules/testing.mdc, evals.json
  - Problem: @MockBean is deprecated since Spring Boot 3.4 in favor of @MockitoBean.

- [F-016] major: fastapi-build-fix's worked example still was the eval's answer key
  - Severity: major
  - File: src/gdskills/bundled/stacks/fastapi/skills/fastapi-build-fix/SKILL.md
  - Problem: the round-1 rewrite kept the exact pydantic-mismatch-not-any scenario, now sharing the NotificationSettings identifier too.
  - Class_scope: sites: ["src/gdskills/bundled/stacks/fastapi/skills/fastapi-build-fix/SKILL.md"] enumeration_method: "restated verbatim from 2026-09-25-ingest-main-r03"

- [F-017] minor: F-008's subtle_wrong confessed its own error
  - Severity: minor
  - File: src/gdskills/bundled/stacks/django/skills/django-implementation/evals.json#select-related-n1
  - Problem: subtle_wrong's own text named its mistake instead of presenting it with confidence.

- [F-018] minor: F-002's rubric and fail_criteria disagreed
  - Severity: minor
  - File: src/gdskills/bundled/stacks/django/skills/django-migrate/evals.json#stage-destructive-column-drop
  - Problem: the rubric's permissive branch conflicted with fail_criteria's unconditional rejection.

- [F-019] minor: django-testing residual incoherent app/view pairing
  - Severity: minor
  - File: src/gdskills/bundled/stacks/django/skills/django-testing/SKILL.md
  - Problem: the renamed ArticleDetailView still sat under a billing/tests/ path.

- [F-020] info: rust CMake negative gave away the answer
  - Severity: info
  - File: src/gdskills/bundled/stacks/rust/skills/rust-build-fix/evals.json
  - Problem: the near-miss negative named the language distinction outright.
