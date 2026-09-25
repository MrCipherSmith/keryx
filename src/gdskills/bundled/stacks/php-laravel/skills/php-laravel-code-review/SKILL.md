---
name: php-laravel-code-review
description: "Use when reviewing a PHP / Laravel change for framework-specific risks -- mass assignment from unvalidated input, N+1 queries, raw SQL interpolation, unescaped Blade output, missing CSRF protection, and non-idempotent queue jobs. Read-only, no edits."
triggers:
  - "review this Laravel diff for mass assignment issues"
  - "check this Eloquent change for N+1 queries"
  - "review this Laravel pull request for security issues"
  - "any raw SQL string building in this PHP change"
  - "check this Blade template for unescaped output"
  - "review this queue job for idempotency"
metadata:
  origin: authored
  category: review
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# PHP / Laravel code review

Read-only review of a PHP/Laravel change for framework-specific risks:
mass assignment, N+1 queries, raw SQL interpolation, unescaped Blade
output, missing CSRF protection, and non-idempotent queue jobs. This
skill never edits code — it reports findings. `rules/coding-style.mdc`,
`rules/patterns.mdc`, and `rules/security.mdc` are the rule set findings
are checked against.

## Workflow

### Step 1: Scope the review

1. Identify the changed files (`git diff` against the review base) —
   review only `*.php` files in the diff (controllers, models, Form
   Requests, jobs, migrations, Blade templates), not the whole repository.
2. Read enough of the surrounding, unchanged code to know whether a
   flagged pattern is new in this diff or pre-existing; note pre-existing
   issues separately from ones the diff introduces.

### Step 2: Check each changed file against the focus list

**Mass assignment**
- An Eloquent `create()`/`update()`/`fill()` call built from
  `$request->all()`/`$request->input()` with no validation step ahead of
  it — flag it; the fix is `$request->validated()` from a Form Request.
- A model touched by the diff with neither `$fillable` nor `$guarded` set
  (or `$guarded = []`) — flag as mass-assignment exposure.

**N+1 queries**
- A relationship accessed inside a loop (`foreach`, `->map()`, a Blade
  `@foreach`) over a collection with no preceding `with()`/`load()` for
  that relationship — flag it as a likely N+1.
- A paginated/listing query that will be iterated for a relationship
  display but omits `with([...])` in the query itself.

**Raw SQL and injection**
- `DB::select`/`DB::statement`/`whereRaw`/`selectRaw`/`DB::raw` with a
  variable interpolated directly into the SQL string instead of passed as
  a binding — flag as SQL injection risk regardless of how trusted the
  input currently looks.

**Blade output**
- `{!! $value !!}` rendering a value that traces back to user input
  (request data, a stored field a user can edit) without a stated
  sanitization step — flag as an XSS risk; `{{ }}` is the default unless
  there is a concrete reason for unescaped output.

**CSRF**
- A new POST/PUT/PATCH/DELETE route added to, or a route removed from,
  the CSRF-exempt list (`VerifyCsrfToken`'s `$except`, or an
  `ValidateCsrfToken` exclusion) with no stated reason — flag it as worth
  confirming, especially for a browser-facing form route.

**Queue jobs**
- A new `ShouldQueue` job whose `handle()` performs a side effect
  (charging a card, sending a one-time notification, creating a record)
  with no `ShouldBeUnique`/`uniqueId()` or idempotency check — flag as a
  duplicate-delivery risk given Laravel's at-least-once queue semantics.

### Step 3: Report

For each finding: file:line, the pattern, why it matters (mass
assignment, N+1, injection, XSS, CSRF, duplicate side effect), and the
fix direction — but do not apply it.

```
app/Http/Controllers/OrderController.php:24 — Order::create($request->all())
  with no prior validation. Risk: any field in the request payload that
  matches a fillable column can be mass-assigned. Fix direction: add a
  StoreOrderRequest Form Request and call Order::create($request->validated()).
```

## Rules

- NEVER edit code — findings and fix direction only.
- Flag mass assignment, N+1 queries, raw SQL interpolation, unescaped
  Blade output on user-influenced data, missing/loosened CSRF protection,
  and non-idempotent queue jobs; do not report generic style nits already
  covered by `Pint`/PSR-12 (those are noise here).
- Distinguish a finding the diff introduces from a pre-existing one in
  code the diff merely touches.
- When a suspected N+1 is not certain from reading alone (a relationship
  might already be eager-loaded further up the call chain), say "confirm
  with `DB::enableQueryLog()`/a query-count assertion" rather than
  asserting it as fact without evidence.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "The form only has a few fields, `$request->all()` is fine here" | The request payload is not bounded by the form's own fields — an attacker can add extra keys; validate and use `validated()` regardless of form size |
| "This raw SQL is only reachable from an admin route" | Admin-only is a claim about the current deployment, not a property of the code; interpolated SQL is still injectable if that assumption ever changes |
| "I'll just fix the mass-assignment issue myself since it's a one-line change" | This skill is read-only; report the finding and its fix direction, do not edit the file |
| "The queue job basically never gets retried in practice" | Laravel's queues are at-least-once by design; "basically never" is not a guarantee, flag the missing idempotency guard regardless |

## Verification

Do not report the review done until all of the following hold:

- Every changed `*.php` file in the diff was read, not just files named
  in the PR description.
- Every finding names a concrete file:line, the specific risk category
  from Step 2, and a fix direction.
- No source file was modified by this review.
- Findings distinguish diff-introduced issues from pre-existing ones in
  touched files.
