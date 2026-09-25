---
name: django-testing
description: "Use when writing Django TestCase/SimpleTestCase classes, simulating browser requests against a view with Django's own request-simulation helper, wiring pytest-django fixtures (db, django_user_model), building factory_boy model factories, or asserting on permission/form/queryset behavior in a Django app's own test suite. Django-specific: ORM assertions, migration-aware test databases, and DRF serializer/view tests, scoped to code that actually imports Django."
triggers:
  - "write a django test for..."
  - "add pytest-django coverage for this view"
  - "fix this failing django test after a model field rename"
  - "test this django model's clean method"
  - "write a factory_boy factory for..."
  - "test this django rest framework endpoint"
  - "add a test for this permission-gated view"
metadata:
  origin: authored
  category: test
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Django testing

Write, extend, or fix a Django project's test suite: `TestCase`/
`SimpleTestCase`, the test `Client`, `pytest-django` fixtures, and
`factory_boy` model factories. Scoped to Django's own test tooling — a
generic `pytest` suite with no Django import belongs to `python-testing`;
auditing existing test conventions without changing files belongs to
`review-testing-practices`.

## Workflow

### Step 1: Discover the project's test conventions

1. Check whether the project uses plain `django.test.TestCase` (via
   `python manage.py test`) or `pytest-django` (`pytest.ini`/`pyproject.toml`
   `[tool.pytest.ini_options]` with `DJANGO_SETTINGS_MODULE` set, `pytest-django`
   in dependencies) — match whichever is already there.
2. Find the test layout: each app's own `tests.py`/`tests/` package, or a
   top-level `tests/` mirroring the app structure.
3. Read 1-2 neighboring test files for: base class/fixture style, whether
   `factory_boy` is used for model data, how the client logs a user in
   (`force_login` vs `login`), and assertion style.

### Step 2: Plan fixtures/factories before test cases

- A factory or fixture needed by just one test module belongs in that
  module (or the app's own `conftest.py`/`factories.py`); promote to a
  shared location only once a second test file needs the same data shape.
- Build a factory with only the fields the test asserts on or a model
  constraint requires — a factory hard-coding every field is brittle to
  unrelated schema changes.
- Prefer `pytest-django`'s `db`/`django_db` fixture scope defaults; widen
  only for expensive, read-only setup, never for a fixture that mutates
  shared state.

### Step 3: Plan test cases

**Models:** field defaults/`choices`, `clean()`/`full_clean()` validation,
`Meta.constraints` actually rejecting a violating row, `Manager`/`QuerySet`
custom methods.

**Views:** the authorized case (200, or 302 to the expected page) AND the
unauthorized case (302 to login, or 403) for anything permission-gated —
happy-path-only coverage never proves the permission check runs.

**Forms/serializers:** `is_valid()`/`.errors` for both a valid and an
invalid payload, including any cross-field `clean()`/`validate()` rule.

**Migrations (only when the migration itself has data-transform logic):**
forward `RunPython` behavior against representative pre-migration rows.

### Step 4: Write

1. Create/extend the test file at the project's own convention path.
2. Drive request/response behavior through `self.client`/the `client`
   fixture — never call a view function directly with a hand-built request.
3. Use `force_login(user)` when the auth mechanism itself isn't under test;
   use `login(username=..., password=...)` when it is.
4. One assertion concept per test; name the test after the single behavior
   it verifies.

### Step 5: Run and fix

```bash
python manage.py test   # or: pytest, if pytest-django is configured
```

Fix failing tests (max 3 iterations) — fix the test, not the source under
test.

### Step 6: Report

```
Generated: billing/tests/test_views.py
  - 6 test cases (authorized + unauthorized paths for InvoiceDetailView)
  - all passing via pytest-django
```

## Rules

- ALWAYS match the project's existing `TestCase`/`pytest-django` style found
  in Step 1 — do not mix both styles in the same suite.
- ALWAYS test both the authorized and unauthorized path for a
  permission-gated view.
- NEVER modify source code — only test files, factories, and
  `conftest.py`.
- NEVER call a view function directly to bypass the test client — this
  skips URL resolution, middleware, and template rendering the real request
  path exercises.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I only tested the happy path, the permission check is obviously right" | A permission bug is exactly what a happy-path-only test can't catch; assert the unauthorized case explicitly |
| "I'll call `my_view(request)` directly, it's faster than going through the client" | Skips URL resolution, middleware, and template rendering the real request path exercises |
| "The assertion keeps failing; I'll patch the view to make it pass" | This skill writes test files only. A source change buried in a test-authoring run is an unreviewed fix that also hides the real bug |
| "I'll disable migrations for the suite, it's just for speed" | A suite that skips migrations can pass while a real deploy's migration path is broken; don't make that tradeoff silently |

## Verification

Do not report the work done until all of the following hold:

- The test file sits at the project's own convention path, matching the
  `TestCase`/`pytest-django` style read in Step 1.
- `python manage.py test`/`pytest` (whichever the project configures) exits
  0 with every generated test passing.
- Every permission-gated view under test has both an authorized and an
  unauthorized case asserted.
- `git status` shows only test files/factories/`conftest.py` added or
  modified — no source file under test changed.
