# Round-2 new findings — PR #747

Reviewer: opus narrow round-2 verification (Task tool, model opus). Ten
of twelve round-1 findings (F-001..F-010, plus F-013/F-015 which were
truncated from the round-1 package by the per-reviewer cap) confirmed
FIXED. F-004 was only PARTIALLY-FIXED: a residual instance in
fastapi-build-fix, recorded here as F-016.

- [F-016] major: fastapi-build-fix's worked example still is the eval's answer key
  - Severity: major
  - File: src/gdskills/bundled/stacks/fastapi/skills/fastapi-build-fix/SKILL.md (Step 5 worked example)
  - Problem: the round-1 rewrite kept the exact pydantic-mismatch-not-any scenario (same root cause, same fix), now even sharing the NotificationSettings model name with the eval's own known_wrong/subtle_wrong -- a skill could pass its own eval by reproducing its own example.
  - Impact: same class of defect as F-004, worse (identifier collision, not just narrative similarity) -- the behavioral gate partly measures example-copying rather than transferable judgment.
  - Suggested fix: replace with an unrelated FastAPI build-fix failure mode sharing no identifier with either scenario in this pack's evals.json.
  - Class_scope: sites: ["src/gdskills/bundled/stacks/fastapi/skills/fastapi-build-fix/SKILL.md"] enumeration_method: "round-2 reviewer diffed the SKILL.md worked example word-for-word against pydantic-mismatch-not-any's known_wrong/subtle_wrong text; this is the only remaining site of the original F-004 finding not already resolved in the three java-kotlin-spring files and django-testing"

- [F-017] minor: F-008's subtle_wrong confesses its own error
  - Severity: minor
  - File: src/gdskills/bundled/stacks/django/skills/django-implementation/evals.json#select-related-n1
  - Problem: subtle_wrong's own text stated "The relation that actually needs eager-loading was missed" -- self-diagnosing the mistake instead of presenting it with confidence, so it no longer tests subtle-error detection.
  - Suggested fix: rewrite subtle_wrong to assert the wrong-relation fix with confidence.

- [F-018] minor: F-002's rubric and fail_criteria disagreed
  - Severity: minor
  - File: src/gdskills/bundled/stacks/django/skills/django-migrate/evals.json#stage-destructive-column-drop
  - Problem: the rubric's second branch ("explicitly calls out that pipeline step order alone is not sufficient") could be satisfied by a same-release answer with added verification, which fail_criteria unconditionally rejects -- the two disagree.
  - Suggested fix: rewrite the rubric to require the separate release unconditionally, matching fail_criteria.

- [F-019] minor: django-testing residual incoherent app/view pairing
  - Severity: minor
  - File: src/gdskills/bundled/stacks/django/skills/django-testing/SKILL.md
  - Problem: F-004's InvoiceDetailView -> ArticleDetailView rename left the surrounding "billing/tests/test_views.py" path in place, an incoherent app/view pairing.
  - Suggested fix: change the path to match the renamed view (e.g. a blog app).

- [F-020] info: rust CMake negative gave away the answer
  - Severity: info
  - File: src/gdskills/bundled/stacks/rust/skills/rust-build-fix/evals.json
  - Problem: the near-miss negative ended with "this is a C++ project not a Cargo one", trivializing the collision it was meant to test.
  - Suggested fix: trim the trailing clause.
