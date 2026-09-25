---
name: django-code-review
description: "Use when reviewing Django changes for correctness and safety risks -- checks N+1 queries missing select_related/prefetch_related, mark_safe/|safe on user-traceable data, raw()/extra() built by string interpolation, @csrf_exempt on a session-authenticated view, missing/hand-edited migrations, and settings.py security misconfiguration. Read-only: reports findings, does not edit code."
triggers:
  - "review this django diff"
  - "check this django pr for bugs"
  - "review django code changes"
  - "audit this django view for security issues"
  - "check this django model change for N+1"
  - "review this django migration"
metadata:
  origin: authored
  category: review
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Django code review

Review a set of Django changes for correctness, query-performance, and
security risk specific to the framework. Read-only: this skill reports
findings, it never edits code. Scoped to Django-specific defects; for
generic Python defects (mutable defaults, bare `except`, resource leaks) use
`python-code-review`, for a language-agnostic security sweep use
`review-security-code`, for fixing what this skill finds use
`django-build-fix` (checker failures) or hand the report to the author.

## Workflow

### Step 1: Scope the review

1. Identify the changed Django files (`git diff` against the review base,
   or the files the requester names) — models, views, forms/serializers,
   templates, migrations, settings.
2. Read `settings.py` for `DEBUG`, `ALLOWED_HOSTS`, and whether DRF/
   `pytest-django` are installed, so findings can be judged against the
   project's actual configuration.
3. Read enough of the surrounding view/template/serializer to judge whether
   a flagged pattern is a real bug in context (e.g. does the template
   actually dereference the relation this queryset didn't eager-load).

### Step 2: Check each changed file against these categories

**Query performance (N+1)**
- A queryset iterated in a view, template, or serializer that dereferences
  a `ForeignKey`/`OneToOneField` per row with no `select_related`, or a
  many-valued relation per row with no `prefetch_related`.
- A loop calling `.save()`/`.delete()` per row where `bulk_create`/
  `bulk_update`/`.update()`/`.delete()` on the queryset would collapse it to
  one (or a few) queries.

**Cross-site scripting**
- `mark_safe()`/the `|safe` template filter/`format_html()`'s raw-string
  form applied to a value that traces back to user input (a form field, a
  query parameter, stored user-submitted content) — Django's own
  auto-escaping is the correct default; only application-controlled markup
  should ever bypass it.

**SQL injection**
- `.raw()`/`.extra()` built with an f-string/`%`/`.format()` instead of the
  `params` argument.

**CSRF**
- `@csrf_exempt` added to a view that still relies on session/cookie
  authentication — an exemption is only correct alongside an equivalent
  protection (signed webhook signature, non-cookie token auth).

**Migrations**
- A model field/constraint change with no corresponding migration file in
  the diff, or a migration file whose `operations` look hand-edited rather
  than `makemigrations`-generated (no matching model diff for what the
  operations do).
- A `RunPython` data migration with no reverse function (or explicit
  `RunPython.noop`) when reversal is meaningful for the data being changed.

**Settings and secrets**
- `SECRET_KEY` hard-coded or the `django-insecure-` placeholder left in a
  settings module used outside local dev.
- `DEBUG = True` or an empty/`["*"]` `ALLOWED_HOSTS` in a settings module
  reachable in production.

**Forms/serializers**
- `fields = "__all__"` on a `ModelForm`/`ModelSerializer` that accepts
  user-submitted input.

### Step 3: Report

For each finding: file:line, category, what's wrong, and the safe
alternative (cite the exact API, e.g. "add `.select_related(\"author\")` to
this queryset").

```
django-code-review: 3 findings
  [n+1] views.py:22 — `Book.objects.all()` iterated with `book.author.name`
    in the template; add `.select_related("author")`
  [xss] profile.py:15 — `mark_safe(profile.bio)` on a user-submitted field;
    remove mark_safe and let auto-escaping handle it
  [csrf] webhooks.py:8 — `@csrf_exempt` on a view still using
    `SessionAuthentication`; either drop the exemption or switch to a
    signed-payload auth scheme
```

## Rules

- NEVER edit the files under review — report findings only.
- Cite the specific line and the specific safe alternative; a vague "this
  could be an issue" finding is not actionable.
- Do not duplicate a finding the project's own configured `ruff`/`mypy`/
  `manage.py check` already enforce and would catch on their own — focus on
  what static tooling misses (N+1 patterns needing template/serializer
  context, `mark_safe` on genuinely user-traceable data, migration/model
  drift).
- Distinguish a real bug from a stylistic preference; a stylistic point
  belongs in `rules/coding-style.mdc`/`rules/patterns.mdc`, not a review
  finding blocking the change.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "The `mark_safe` call is fine, it's inside an admin-only view" | An admin-only view still renders content a user submitted through some earlier form; check where the value actually originated, not just where it's rendered |
| "It's just a review, I'll add select_related myself since it's one line" | This skill is read-only; even a trivial fix belongs to the author or `django-implementation`, not a silent edit during review |
| "The N+1 loop only ever runs over 3 rows in the demo data" | Demo/test data size does not bound production data size; flag it regardless of current call sites |
| "The migration file looks fine, I don't need to check it matches the model diff" | A hand-edited or missing migration is invisible until deploy; always cross-check migration operations against the actual model change |

## Verification

Do not report the review done until all of the following hold:

- Every changed Django file in scope was checked against all seven
  categories in Step 2.
- No finding duplicates something the project's own configured linter/type
  checker/`manage.py check` already flags and enforces.
- Every finding names a file:line, the specific problem, and a specific
  fix — no vague findings.
- No file under review was modified.
