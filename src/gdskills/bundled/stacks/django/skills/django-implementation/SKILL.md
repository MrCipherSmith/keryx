---
name: django-implementation
description: "Use when implementing or extending a feature in a Django (5.x) project -- covers models and migrations, class-based/function-based views, forms and serializers, querysets with select_related/prefetch_related to avoid N+1, the framework's CSRF/escaping defaults, and the code-level changes for a Django major-version upgrade (e.g. 4.x to 5.x; pair with django-migrate for any accompanying schema migration discipline). Not for plain Python with no Django import (see python-implementation)."
triggers:
  - "add a django model for..."
  - "write a django rest view that..."
  - "implement this django feature"
  - "add a new django app for..."
  - "write a class-based view for..."
  - "add a form/serializer that validates..."
  - "implement a django queryset that..."
  - "add a manager method to this django model"
metadata:
  origin: authored
  category: implement
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Django implementation

Implement or extend a feature in a Django (5.x) project: models and
migrations, views (class-based or function-based), forms/serializers, and
query patterns that avoid the framework's most common performance and
security pitfalls. Scoped to writing production code in a Django project —
for plain Python with no Django import use `python-implementation`, for
writing/fixing tests use `django-testing`, for reviewing a diff without
editing it use `django-code-review`, for fixing a broken build/check use
`django-build-fix`, for a Django-version-major upgrade use `django-migrate`.

## Workflow

### Step 1: Discover the project's own conventions

1. Read `settings.py`/`settings/` to find: installed apps, the configured
   database backend, `AUTH_USER_MODEL`, whether Django REST Framework is
   installed, and whether `pytest-django` is configured.
2. Identify the target app (or whether a new app is warranted) — one app per
   cohesive domain concern, per `rules/coding-style.mdc`.
3. Read 1-2 neighboring `models.py`/`views.py`/`forms.py` in the same app
   for: CBV vs FBV convention, `related_name` style, how validation is
   split between model/form/serializer, and response-shape conventions
   (plain Django views + templates vs. a DRF API).
4. Check `requires-python`/CI config and the pinned Django version before
   using a feature specific to a recent Django release.

### Step 2: Design the change

- Model layer: choose fields, `related_name`, `Meta.constraints`
  (`UniqueConstraint`, `CheckConstraint`) for invariants the database itself
  should enforce, not only a form's `clean()`. See `rules/patterns.mdc`.
- Decide the view shape: a generic class-based view (`ListView`,
  `DetailView`, `CreateView`, or a DRF `APIView`/`ViewSet`) for standard
  CRUD, a function-based view or a CBV method override when the logic
  doesn't map onto a generic view's hooks.
- Plan the query path before writing the view body: which related objects
  will be accessed per row, and whether `select_related`/`prefetch_related`
  is needed to avoid N+1 (see `rules/patterns.mdc`).
- Decide validation ownership: a per-field/cross-field rule that must hold
  for every write path goes on the model (`Meta.constraints`,
  `clean()`/`full_clean()`); a rule specific to one submission path goes on
  that `Form`/`Serializer`.

### Step 3: Implement

1. Add/update the model, then generate the migration:
   ```bash
   python manage.py makemigrations
   ```
   Review the generated migration file; never hand-write `operations` to
   match a model edit by guesswork.
2. Write the view, applying `select_related`/`prefetch_related` on the
   queryset for every relation the view or its template/serializer accesses
   per row.
3. Write the form/serializer with an explicit `fields = [...]` list (never
   `"__all__"` on user-submitted input) and a `clean_<field>`/`validate_<field>`
   method for interdependent validation.
4. Wire the URL with `path()`, namespaced under the app, reversed with
   `reverse()`/`{% url %}` rather than a hand-built path string.
5. Follow `rules/coding-style.mdc` for naming/layout, `rules/patterns.mdc`
   for query/migration idiom; check `rules/security.mdc` before touching
   `mark_safe`/`|safe`, `.raw()`/`.extra()`, CSRF decorators, or settings.

### Step 4: Verify

```bash
python manage.py check
python manage.py makemigrations --check --dry-run
ruff check .
ruff format --check .
mypy .   # with django-stubs, if configured
python manage.py test   # or: pytest, if pytest-django is configured
```

Prefix each command with the project's own run prefix (`uv run`, `poetry
run`) when it uses one — discovered in Step 1.

### Step 5: Report

```
Implemented: billing/models.py, billing/views.py, billing/migrations/0007_add_invoice_status.py
  - added `Invoice.status` field + `Status` choices, migration generated and reviewed
  - `InvoiceListView` uses select_related("customer") to avoid N+1
  - manage.py check / makemigrations --check / ruff / mypy / test: all green
```

## Rules

- ALWAYS discover and match the project's own conventions (Step 1) before
  assuming DRF, `pytest-django`, or a specific Django version's features.
- ALWAYS run `makemigrations` to generate a migration from a model change;
  never hand-write migration `operations` to match an edit by guesswork.
- NEVER apply `mark_safe()`/`|safe` to a value that traces back to user
  input, and never add `@csrf_exempt` to make a failing request succeed
  without confirming an equivalent protection exists first (`rules/security.mdc`).
- NEVER build a `.raw()`/`.extra()` query by interpolating a value into the
  SQL string; pass it through the `params` argument.
- NEVER leave `fields = "__all__"` on a `ModelForm`/`ModelSerializer` that
  accepts user-submitted data.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll just loop and call `.save()` per row, it's simpler than `bulk_create`" | An N+1 on the write side; use `bulk_create`/`bulk_update` for a batch write |
| "This template value is safe, I'll mark it `\|safe` to stop the escaping" | If the value ever traces back to user input, this reintroduces XSS; escape it properly or sanitize before rendering instead |
| "`@csrf_exempt` makes the POST succeed, I'll leave it" | A passing request after exempting CSRF proves the exemption works, not that it's safe on a session-authenticated endpoint |
| "I'll hand-edit the migration file, `makemigrations` produced something odd" | The generated file reflects the real model diff; fix the model or the migration's logic, don't paper over a mismatch by hand |

## Verification

Do not report the work done until all of the following hold:

- Every model change has a corresponding migration generated by
  `makemigrations` and reviewed, not hand-written.
- A queryset the view/serializer iterates and dereferences per row uses
  `select_related`/`prefetch_related` for the relations it accesses.
- `python manage.py check`, `makemigrations --check --dry-run`, `ruff
  check .`, `ruff format --check .`, `mypy .` (or the project's configured
  equivalents) all exit 0.
- `python manage.py test`/`pytest` (whichever the project configures)
  passes; if the feature needs new tests, hand off to `django-testing`
  rather than writing test files as part of this skill's own change set.
- No `mark_safe`/`|safe` on user-traceable data, no `.raw()`/`.extra()`
  built by string interpolation, and no `@csrf_exempt` added, introduced by
  this change.
