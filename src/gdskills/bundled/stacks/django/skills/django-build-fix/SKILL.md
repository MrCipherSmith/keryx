---
name: django-build-fix
description: "Use when a Django project fails manage.py check, makemigrations/migrate, the test suite, or lint/type-check -- resolves migration conflicts and inconsistent migration history, ImproperlyConfigured settings errors, app-loading/circular-import errors, mypy/django-stubs type errors, and ruff failures with the smallest root-cause fix. Not for adding a feature (see django-implementation) or fixing test content (see django-testing)."
triggers:
  - "manage.py check is failing"
  - "fix this django migration conflict"
  - "django ImproperlyConfigured error"
  - "django app isn't loading, circular import"
  - "mypy is failing on this django model"
  - "makemigrations wants to make a conflicting migration"
  - "django test suite won't even start"
metadata:
  origin: authored
  category: build-fix
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Django build-fix

Resolve a broken Django `check`/migration/settings/import/type-check/lint
failure with the smallest change that fixes the actual cause. Scoped to
making the Django toolchain green again — for adding a feature use
`django-implementation`, for writing/fixing test *content* (not a collection
or startup error) use `django-testing`, for reviewing without fixing use
`django-code-review`.

## Workflow

### Step 1: Reproduce and classify the failure

Run the project's own configured commands (discover the run prefix from
`pyproject.toml`/lockfile presence):

```bash
python manage.py check
python manage.py makemigrations --check --dry-run
ruff check .
ruff format --check .
mypy .   # with django-stubs, if configured
python manage.py test   # or: pytest, if pytest-django is configured
```

Read the *first* error in each tool's output. Classify:

- **`ImproperlyConfigured`** — a required setting missing/misconfigured
  (`SECRET_KEY`, `DATABASES`, `AUTH_USER_MODEL` pointing at a model that
  doesn't exist), or an app used before `AppConfig.ready()`/app registry is
  populated.
- **Migration conflict** — two migrations in the same app both claim the
  same `dependencies` leaf (usually from two branches adding migrations in
  parallel), or `makemigrations --check` reports an unmigrated model change.
- **App-loading / circular import** — a model or app imports another app's
  model at module import time before Django's app registry is ready, or two
  apps import each other's models directly instead of via a string reference
  (`"otherapp.Model"`) in a `ForeignKey`.
- **Type errors** — `mypy`/`django-stubs` reports a real mismatch, often
  around manager/queryset generics or a model field's inferred type.
- **Lint failures** — `ruff check` reports a rule violation.
- **Test suite won't start** — an import error in a test file, `conftest.py`,
  or a fixture referencing a model/setting that doesn't exist.

### Step 2: Find the root cause

- **`ImproperlyConfigured`**: read the exact message — it names the missing/
  bad setting. Check the correct settings module is active
  (`DJANGO_SETTINGS_MODULE`) before assuming the setting itself is wrong.
- **Migration conflict**: run `python manage.py makemigrations --merge` to
  generate a merge migration when two branches added divergent migrations
  from the same parent — review the generated merge, don't hand-edit
  `dependencies` to force a resolution. For an unmigrated model change,
  run `makemigrations` for the actual diff instead of skipping the check.
- **App-loading/circular import**: use a string reference
  (`models.ForeignKey("otherapp.Model", ...)`) for a cross-app relation
  instead of importing the model class directly; move an import that only
  needs to run inside a function body (e.g. inside a signal handler) out of
  module level if it's the actual cycle.
- **Type errors**: read the exact mismatch; check `django-stubs` is
  installed and configured (`mypy_django_plugin` in `mypy.ini`/
  `pyproject.toml`) before assuming the type itself is wrong — a missing
  plugin config produces spurious errors on manager/queryset types.
- **Lint failures**: apply `ruff check --fix .` for mechanical fixes; fix
  the code for a substantive rule, don't suppress it.
- **Test suite won't start**: apply the same import-error diagnosis above to
  the failing test/`conftest.py`'s own imports.

### Step 3: Apply the smallest fix

- Fix the actual cause identified in Step 2 — the missing setting, the
  merge migration, the string-reference relation, the real type mismatch.
- Touch only what the failure requires; do not refactor unrelated code
  while fixing a build failure.
- When a migration conflict needs a merge, generate it with
  `makemigrations --merge` and review the result; never hand-edit
  `dependencies`/`operations` to force a resolution.

### Step 4: Verify

Re-run every command from Step 1 in order; all must exit 0. Also run
`python manage.py test`/`pytest` even when the original failure was only a
lint/type error — a fix can introduce a runtime regression static tooling
won't see.

### Step 5: Report

```
Fixed: ImproperlyConfigured: AUTH_USER_MODEL refers to model 'accounts.Member'
  that has not been installed
  Root cause: settings.py set AUTH_USER_MODEL = "accounts.Member" but
    "accounts" was missing from INSTALLED_APPS.
  Fix: added "accounts" to INSTALLED_APPS
  Verified: manage.py check, makemigrations --check, ruff, mypy, test all green
```

## Rules

- NEVER hand-edit a migration's `dependencies`/`operations` to force past a
  conflict — generate a merge migration with `makemigrations --merge` and
  review it.
- NEVER add `# type: ignore`/`# noqa` as a blanket suppression to make a
  real error disappear without fixing or explicitly justifying it inline.
- NEVER wrap a real settings/import error in a broad `try/except` to hide
  it — fix the actual misconfiguration or import cycle.
- Fix the root cause with the smallest change; do not refactor beyond what
  the failure requires.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll hand-edit the migration's `dependencies` to skip the conflict" | Desyncs the migration graph from what actually ran in other environments; generate a proper merge migration instead |
| "I'll import the model directly instead of using a string reference to dodge the circular import" | Papers over the app-loading order problem instead of fixing it; use `\"otherapp.Model\"` string references for cross-app relations |
| "mypy is noisy on Django models, I'll just add `# type: ignore` everywhere" | Usually means `django-stubs`'s mypy plugin isn't configured; fix the plugin config instead of suppressing every resulting error |
| "`makemigrations --check` fails, I'll just skip the check in CI" | Hides real model/migration drift instead of fixing it; generate the missing migration |

## Verification

Do not report the fix done until all of the following hold:

- The originally failing command now exits 0.
- `python manage.py check`, `makemigrations --check --dry-run`, `ruff
  check .`, `ruff format --check .`, `mypy .`, and the test suite (the
  project's own configured equivalents) all exit 0.
- No new `# type: ignore`/`# noqa` was added without an inline reason.
- No migration file's `dependencies`/`operations` was hand-edited; a
  conflict was resolved with a generated merge migration.
- `git status` shows only the files whose actual cause was diagnosed in
  Step 2 — no unrelated refactor.
