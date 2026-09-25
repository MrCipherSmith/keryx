---
name: php-laravel-implementation
description: "Use when implementing or extending a feature in a PHP 8.2+ / Laravel application -- controllers, Form Request validation, Eloquent models and relationships, migrations, route-model binding, middleware, queued jobs, and service container bindings. Not for writing or fixing tests (use php-laravel-testing)."
triggers:
  - "add an endpoint to this Laravel controller"
  - "implement this feature in our Laravel app"
  - "add a new Eloquent model with a migration"
  - "wire up validation for this form submission"
  - "add a queued job that sends this notification"
  - "add a new relationship between these two models"
metadata:
  origin: authored
  category: implement
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# PHP / Laravel implementation (PHP 8.2+, Laravel 11-13)

Implement or extend a feature in a Laravel application: routes,
controllers, Form Requests, Eloquent models/migrations, jobs, and service
container wiring. Scoped to PHP/Laravel specifically —
`rules/coding-style.mdc`, `rules/patterns.mdc`, and `rules/security.mdc`
carry the full stack-specific rule set this skill's checklist is built
from; read them before writing code, not just this summary.

## Workflow

### Step 1: Discover the project's own conventions

1. Read `composer.json` for the `php` and `laravel/framework` version
   constraints — do not use a language or framework feature the project's
   own constraints predate.
2. Find the existing layout: `app/Http/Controllers`,
   `app/Http/Requests`, `app/Models`, `app/Actions` or `app/Services` (if
   present), `database/migrations`, `routes/web.php`/`routes/api.php`.
   Match it; do not invent a different layout for one change.
3. Read 1-2 neighboring controllers/models for: whether Form Requests are
   already used for validation, whether an action/service layer exists,
   the project's testing framework (Pest vs PHPUnit, from
   `tests/Pest.php` or `phpunit.xml`), and whether `Pint`/`Larastan` are
   configured.

### Step 2: Design before writing

- Decide the layer for new logic: a thin controller method that
  validates (Form Request) and delegates; the actual rule lives in a
  model method, an action class, or a service (`rules/patterns.mdc`).
- For a new Eloquent model: decide `$fillable` vs `$guarded` up front
  (never leave both unset), the relationships it needs, and whether any
  attribute needs a cast (`casts()` method, or `$casts` on an
  unmigrated codebase).
- For anything touching request input, plan the Form Request's
  `rules()`/`authorize()` before writing the controller method that uses
  it.
- For a new queued job, decide its idempotency story
  (`ShouldBeUnique`/`uniqueId()`, or an explicit dedupe check) before
  writing `handle()` — queues are at-least-once by default.

### Step 3: Implement

1. Add/extend the migration (`php artisan make:migration ...`) with
   explicit column types and any needed index/foreign key — run
   `php artisan migrate` (or the project's test-database equivalent)
   locally to confirm it applies cleanly.
2. Add/extend the Eloquent model: `$fillable`/`$guarded`, typed
   relationship methods, `casts()`, scopes for reused filters.
3. Add/extend the Form Request for validation; keep the controller method
   itself limited to resolving the request, delegating to the model/
   action/service, and returning a response.
4. Register the route with route-model binding where a resource ID
   appears in the URI, and attach any route-specific middleware with
   `->middleware(...)`.
5. Use constructor property promotion and `readonly` for simple DTOs/
   value objects introduced along the way (`rules/coding-style.mdc`).
6. Eager-load (`with()`) any relationship the new code accesses inside a
   loop over a collection — do not introduce a new N+1.

### Step 4: Verify

```bash
composer install
./vendor/bin/phpstan analyse   # if configured (Larastan)
php artisan test                # or ./vendor/bin/pest / ./vendor/bin/phpunit
```

Run the project's configured formatter (`./vendor/bin/pint`) if present.
Fix findings at the root cause per `rules/security.mdc` and
`rules/coding-style.mdc`; a failing static-analysis or test run at this
step is a signal to fix the implementation, not to reach for
`php-laravel-build-fix`'s scope unless the failure is purely a build/
dependency/autoload problem unrelated to the feature logic.

### Step 5: Report

```
Implemented: app/Http/Controllers/OrderController.php,
  app/Http/Requests/StoreOrderRequest.php,
  app/Models/Order.php, database/migrations/..._create_orders_table.php
  - New Order model with $fillable allowlist and validated() request flow
  - phpstan analyse and php artisan test both pass
```

## Rules

- Every Eloquent model that can be mass-assigned declares `$fillable` or
  `$guarded` explicitly — never leave both unset.
- Build create/update calls from `$request->validated()`, never raw
  `$request->all()`/`$request->input()`.
- Eager-load a relationship before accessing it inside a loop over a
  collection; a per-row relationship access with no eager load is an N+1
  query.
- Every queued job assumes at-least-once delivery and guards its side
  effect accordingly.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll just use `$request->all()` here, the form only has a few fields" | Bypasses validation and can mass-assign any column present in the request payload, not just the form's own fields; use `validated()` |
| "This model is internal-only, it doesn't need `$fillable`" | "Internal-only" today does not prevent a future controller or API endpoint from mass-assigning it; declare the allowlist regardless |
| "The relationship is only accessed for a handful of rows, eager loading is overkill" | "A handful" in a test fixture can be thousands in production; eager-load by default and only skip it with a stated reason |
| "This job basically never gets retried, idempotency can wait" | Laravel's queues are at-least-once by design — a rare retry is still a retry, and the cost of guarding it up front is small compared to a duplicated side effect in production |

## Verification

Do not report the work done until all of the following hold:

- `php artisan test` (or the project's Pest/PHPUnit command) passes.
- The project's configured static analysis (Larastan/PHPStan), if
  present, exits clean.
- Every new/touched Eloquent model has `$fillable` or `$guarded` set.
- Every new controller path that accepts user input validates through a
  Form Request or `$request->validate([...])` before using the data.
