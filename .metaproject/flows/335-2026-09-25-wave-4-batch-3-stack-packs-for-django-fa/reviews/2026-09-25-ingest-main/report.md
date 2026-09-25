# Adversarial review — PR #747, round 1

Reviewer: opus adversarial review (Task tool, model opus), against the
lessons checklist in stack-pack-lessons.md.

- [F-001] major: Spring self-invocation eval fails a technically correct answer
  - Severity: major
  - File: src/gdskills/bundled/stacks/java-kotlin-spring/skills/java-kotlin-spring-implementation/evals.json (scenario `transactional-self-invocation`)
  - Problem: The prompt gives both methods `@Transactional` with no propagation stated. Under the default REQUIRED propagation, a proxied call would join the outer transaction anyway, so `subtle_wrong` ("executes inside the outer transaction... nothing to fix") is essentially correct. `fail_criteria` explicitly fails that correct reasoning, and `known_right`'s "no new transaction starts for it" wrongly implies one would otherwise start.
  - Impact: This is the program's #1 defect class -- a right answer labeled wrong, training the judge to punish accuracy.
  - Suggested fix: Give the prompt a non-default attribute on the inner method (e.g. REQUIRES_NEW or readOnly=true), or rewrite subtle_wrong/fail_criteria so they condemn something genuinely wrong.
  - Class_scope: sites: ["src/gdskills/bundled/stacks/java-kotlin-spring/skills/java-kotlin-spring-implementation/evals.json#transactional-self-invocation"] enumeration_method: "reviewer read every scenario in java-kotlin-spring-implementation/evals.json for calibration/rubric correctness against Spring's default @Transactional propagation semantics; this is the only scenario in that file with this defect"

- [F-002] major: Django column-drop subtle_wrong is a legitimate deploy pattern
  - Severity: major
  - File: src/gdskills/bundled/stacks/django/skills/django-migrate/evals.json (scenario `stage-destructive-column-drop`)
  - Problem: subtle_wrong describes running the drop migration after the rolling deploy has fully finished -- the standard post-deploy-migration pattern, and the prompt itself says migrations run as a separate step. The rubric's stated reason ("old instances still running") does not apply once rollout is complete, and known_right's "regardless of deploy order" is false. The real distinctions (rollback safety, NOT NULL handling during rollout via SeparateDatabaseAndState) go untested.
  - Impact: The judge is calibrated to fail a defensible answer, and the reference answer's own reasoning is wrong.
  - Suggested fix: Rewrite subtle_wrong as genuinely wrong (e.g. running the migration before or during rollout) or rebase the rubric on rollback safety and NOT NULL handling.
  - Class_scope: sites: ["src/gdskills/bundled/stacks/django/skills/django-migrate/evals.json#stage-destructive-column-drop"] enumeration_method: "reviewer read every scenario in django-migrate/evals.json for calibration/rubric correctness against Django's documented multi-deploy column-removal pattern; this is the only scenario in that file with this defect"

- [F-003] major: java-kotlin-spring pack installs on every JVM project, including Android
  - Severity: major
  - File: src/gdskills/bundled/stacks/java-kotlin-spring/pack.json and src/gdskills/bundled/install-manifest.json component `framework:java-kotlin-spring` (detectionMarkers: ["spring-boot","spring","java","kotlin"]); src/stack/detect.ts:662-670
  - Problem: jvmManifestSignal always emits "java" for any pom.xml/build.gradle and "kotlin" for any .kts file or kotlin mention, so plain Java libraries and every kotlin-android app (tags java+kotlin+android) pick up the Spring rules on **/*.java and **/*.kt (constructor injection, @Transactional, SecurityFilterChain) even with no Spring dependency present. The dedicated "spring" tag exists but is not required alone.
  - Impact: Framework-specific rules get applied to non-Spring code and collide with the kotlin-android pack's own guidance.
  - Suggested fix: Restrict detectionMarkers to ["spring", "spring-boot"] only.
  - Class_scope: sites: ["src/gdskills/bundled/stacks/java-kotlin-spring/pack.json#detectionMarkers", "src/gdskills/bundled/install-manifest.json#components.framework:java-kotlin-spring.detectionMarkers"] enumeration_method: "reviewer grepped every detectionMarkers array introduced or touched by this PR against src/stack/detect.ts's own per-tag emission logic; these are the only two sites listing java-kotlin-spring's detection markers"

- [F-004] major: Eval scenarios and answer keys copied into SKILL.md
  - Severity: major
  - File: src/gdskills/bundled/stacks/java-kotlin-spring/skills/java-kotlin-spring-code-review/SKILL.md (around lines 86-94), src/gdskills/bundled/stacks/java-kotlin-spring/skills/java-kotlin-spring-implementation/SKILL.md (around line 129), src/gdskills/bundled/stacks/java-kotlin-spring/skills/java-kotlin-spring-migrate/SKILL.md (around line 120), src/gdskills/bundled/stacks/fastapi/skills/fastapi-build-fix/SKILL.md (around lines 111-119), src/gdskills/bundled/stacks/django/skills/django-testing/SKILL.md (around line 94)
  - Problem: java-kotlin-spring-code-review's example report reproduces the eval's known_right almost word for word (OrderService.placeOrder() -> this.chargePayment(), "extract chargePayment() into its own bean... injected reference"). The implementation and migrate SKILL.md files carry the eval-specific identifiers this.processPayment() and V7__add_users_table.sql, which are also the anti_patterns tokens (satisfying I6 by construction rather than by genuine coverage). fastapi-build-fix's example reproduces the eval's UserRead/class Config/field_validator scenario. django-testing names InvoiceDetailView from its own eval. All of this predates the honest gate run (verified separately), so it is not post-gate prompt-chasing -- it is answer-key leakage from authoring, which the lessons file separately forbids ("Never paste eval prompts into SKILL.md; no answer-key instructions in SKILL.md").
  - Impact: The behavioral gate partly measures whether the model copies the SKILL.md's own worked example rather than whether the skill teaches transferable judgment.
  - Suggested fix: Replace the specific examples and identifiers in these five SKILL.md files with different, generic ones not drawn from any evals.json scenario.
  - Class_scope: sites: ["src/gdskills/bundled/stacks/java-kotlin-spring/skills/java-kotlin-spring-code-review/SKILL.md", "src/gdskills/bundled/stacks/java-kotlin-spring/skills/java-kotlin-spring-implementation/SKILL.md", "src/gdskills/bundled/stacks/java-kotlin-spring/skills/java-kotlin-spring-migrate/SKILL.md", "src/gdskills/bundled/stacks/fastapi/skills/fastapi-build-fix/SKILL.md", "src/gdskills/bundled/stacks/django/skills/django-testing/SKILL.md"] enumeration_method: "reviewer cross-referenced every SKILL.md worked-example section against every evals.json calibration/scenario string across all four new packs (19 skills), diffing shared identifiers and phrasing; these five are every SKILL.md found reusing an eval's own scenario identifiers or answer text"

- [F-005] minor: Pydantic scenario premise is technically wrong
  - Severity: minor
  - File: src/gdskills/bundled/stacks/fastapi/skills/fastapi-build-fix/evals.json (scenario `pydantic-mismatch-not-any`) and SKILL.md (around lines 111-119)
  - Problem: In Pydantic v2, adding @field_validator to a model that still has class Config only raises a deprecation warning, not an error. The real error occurs only when class Config and model_config are both defined, with different wording than the scenario states. The SKILL.md example also misattributes an "Invalid args for response field" startup failure to this mixing.
  - Suggested fix: Change the premise to "someone added model_config = ConfigDict(...) next to the old class Config" and fix the SKILL.md example accordingly.

- [F-006] minor: Clippy lint name needless_clone is probably not real
  - Severity: minor
  - File: src/gdskills/bundled/stacks/rust/skills/rust-build-fix/SKILL.md (around line 127) and evals.json (around lines 42-70)
  - Problem: clippy::needless_clone does not appear to be a real lint name; the closest real lint (redundant_clone) is nursery-only and off by default.
  - Suggested fix: Use a real default-enabled lint such as clone_on_copy, or redundant_clone with an accurate note on its lint group, and verify against current clippy docs.

- [F-007] minor: Django upgrade routing points both ways
  - Severity: minor
  - File: src/gdskills/bundled/stacks/django/skills/django-implementation/SKILL.md and src/gdskills/bundled/stacks/django/skills/django-migrate/SKILL.md (description fields)
  - Problem: django-implementation's description says a a version upgrade spanning Django major releases is out of scope and points to django-migrate; django-migrate's description says it is not for a framework upgrade and points back to django-implementation. Neither skill owns the case.
  - Suggested fix: Pick one owner for a Django cross-version upgrade request and make both descriptions agree.

- [F-008] minor: select_related scenario contradicts its own fail_criteria
  - Severity: minor
  - File: src/gdskills/bundled/stacks/django/skills/django-implementation/evals.json (scenario `select-related-n1`)
  - Problem: fail_criteria only fails a queryset with no select_related/prefetch_related at all, which accepts prefetch_related -- but subtle_wrong IS a prefetch_related("author") answer, which for a single foreign key is 2 queries, not N+1, so it is not actually wrong under the stated fail_criteria.
  - Suggested fix: Use a genuinely wrong subtle_wrong (e.g. select_related on a reverse/many-to-many relation, or .only() without the relation), or require the join explicitly in fail_criteria.

- [F-009] minor: Negative triggers skip the closest sibling pack; one positive reads oddly
  - Severity: minor
  - File: src/gdskills/bundled/stacks/java-kotlin-spring/skills/*/evals.json, src/gdskills/bundled/stacks/rust/skills/*/evals.json (including rust-implementation)
  - Problem: java-kotlin-spring's negatives include no kotlin-android/Gradle-Android near-miss despite that being the real collision (see F-003); rust's negatives include no c-cpp near-miss (cargo vs CMake). rust-implementation's positive "What's the right Rust trait size for this new client -- who should it be defined for?" does not read like a realistic user request.
  - Suggested fix: Add kotlin-android and c-cpp near-miss negatives where relevant, and reword the odd rust-implementation positive.

- [F-010] minor: Spring testing recommends deprecated @MockBean
  - Severity: minor
  - File: src/gdskills/bundled/stacks/java-kotlin-spring/skills/java-kotlin-spring-testing/SKILL.md (lines ~52, 71), rules/testing.mdc (~line 42), and evals.json pass_criteria
  - Problem: @MockBean has been deprecated since Spring Boot 3.4 in favor of @MockitoBean and is removed in Boot 4.x.
  - Suggested fix: Recommend @MockitoBean, noting @MockBean only applies below Boot 3.4.

- [F-011] info: python's governance/eval.json retains stale pass verdicts
  - Severity: info
  - File: src/gdskills/bundled/stacks/python/governance/eval.json
  - Problem: still records 4 verdict:"pass" entries under the pre-demotion catalogDigest. Matches the ts-js-node precedent (stability gates, not the stale report), but reads confusingly next to the demotion note.

- [F-012] info: recorded trigger accuracy predates the batch-4/5/6 merge
  - Severity: info
  - File: src/gdskills/bundled/stacks/{django,fastapi,rust,java-kotlin-spring}/governance/eval.json
  - Problem: catalogDigest is from before the merge with origin/main's batches 4/5/6, so trigger accuracy was measured against the pre-merge catalog. Not a defect while all four packs stay experimental.

- [F-013] info: redundant globs in Spring security rule
  - Severity: info
  - File: src/gdskills/bundled/stacks/java-kotlin-spring/rules/security.mdc
  - Problem: the *Controller*.java/kt globs are already covered by the file's own broader **/*.java and **/*.kt entries.

- [F-014] info: no written reason for empty migrate categories
  - Severity: info
  - File: src/gdskills/bundled/stacks/fastapi/pack.json, src/gdskills/bundled/stacks/rust/pack.json
  - Problem: both leave "migrate": [] with no inline comment/reason field, though this is consistent with the existing go/python precedent.

- [F-015] info: Cargo.lock scenario premise imprecise
  - Severity: info
  - File: src/gdskills/bundled/stacks/rust/skills/rust-build-fix/evals.json (scenario `lockfile-mismatch`)
  - Problem: plain `cargo build` rewrites a stale Cargo.lock itself; the stated error only appears with --locked/--frozen, which the prompt should say explicitly.
