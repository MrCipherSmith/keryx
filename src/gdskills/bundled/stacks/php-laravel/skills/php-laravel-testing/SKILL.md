---
name: php-laravel-testing
description: "Use when a Laravel application's test suite needs writing, extending, or fixing -- Pest or PHPUnit feature/unit tests, model factories, RefreshDatabase, HTTP testing helpers, and Queue/Mail/Event/Http fakes."
triggers:
  - "write a Pest test for this controller"
  - "add feature tests for this API endpoint"
  - "fix this failing PHPUnit test"
  - "add a factory and test coverage for this model"
  - "write tests that assert this job gets queued"
  - "test this form's validation errors"
metadata:
  origin: authored
  category: test
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# PHP / Laravel testing (Pest / PHPUnit)

Write, extend, or fix a Laravel application's test suite: Pest or PHPUnit
feature/unit tests, model factories, database isolation, HTTP assertions,
and framework fakes. `rules/testing.mdc` carries the full rule set this
skill's checklist is built from — read it, not just this summary, before
writing tests.

## Workflow

### Step 1: Discover the project's test conventions

1. Check whether the project uses Pest (`tests/Pest.php` present) or
   PHPUnit (test classes extending `Tests\TestCase`); match whichever is
   already in use, do not introduce the other framework into an existing
   suite.
2. Find the layout: `tests/Feature` for anything touching the framework
   (routes, database, queue, auth), `tests/Unit` for an isolated class.
   Match it for the code under test.
3. Read 1-2 neighboring test files for: factory usage patterns,
   `RefreshDatabase`/`DatabaseTransactions` usage, whether fakes
   (`Queue::fake()`, `Mail::fake()`) are already the project's norm, and
   naming style.

### Step 2: Plan test cases

**Feature tests (HTTP):** happy path, validation failures
(`assertInvalid`), authorization failures (`assertForbidden`/
`assertUnauthorized`), not-found cases (`assertNotFound`).

**Model/unit tests:** relationships resolve to the right type, casts
produce the right PHP type, scopes filter correctly, computed
accessors/mutators behave at their boundaries (empty/zero/null inputs).

**Jobs/events/mail:** dispatched with the right arguments
(`Queue::fake()` + `Queue::assertPushed(...)`), not that they actually
ran — assert on the fake, don't let a test send real mail or hit a real
queue/HTTP endpoint.

### Step 3: Write

1. Create/extend the test file at the project's own convention path
   (Pest script or PHPUnit class, matching Step 1).
2. Use model factories (`Model::factory()->create([...])`) for test data;
   override only the fields the test cares about.
3. Apply `RefreshDatabase` (or the project's existing trait) on any test
   touching the database.
4. Use `actingAs($user)` for authenticated routes; use a factory-built
   user with the right role/permissions rather than mocking auth
   internals.
5. Fake external effects (`Queue::fake()`, `Mail::fake()`, `Event::fake()`,
   `Http::fake([...])`, `Storage::fake('disk')`) instead of letting a
   test perform a real side effect.
6. Never wait on an async/queued effect with `sleep()`; assert against
   the fake, or dispatch/handle the job synchronously in the test.

### Step 4: Run and fix

```bash
php artisan test
# or: ./vendor/bin/pest    /    ./vendor/bin/phpunit
```

Fix failing tests (max 3 iterations) — fix the test, not the source under
test, unless the test itself has correctly caught a real bug (say so in
the report rather than silently changing production code).

### Step 5: Report

```
Generated: tests/Feature/OrderControllerTest.php
  - 6 cases: happy path, validation failure, unauthorized, N+1-safe listing
  - php artisan test passes
```

## Rules

- ALWAYS match the project's existing framework (Pest vs PHPUnit) and
  factory/fixture conventions found in Step 1, not a different project's
  style.
- NEVER modify source code — only test files and factories.
- NEVER let a test send a real email, dispatch to a real queue connection,
  or make a real outbound HTTP call — fake it.
- NEVER use `sleep()` to wait for a queued job or async effect.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll add a short `sleep(1)` so the queued job has time to run" | Non-deterministic and slow; use `Queue::fake()` and assert what was pushed, or run the job handler directly in the test |
| "This test keeps failing on validation, I'll just assert the response isn't a 500" | Loses the actual signal — assert the specific status (`assertInvalid`, `assertForbidden`) the endpoint should return, not just "didn't crash" |
| "I'll call the controller method directly instead of hitting the route" | Skips routing, middleware, and validation the real request path goes through — use the HTTP testing helpers (`$this->postJson(...)`) for a feature test |
| "Let's just call the real Mailgun sandbox in this test, it's fast enough" | Introduces network flakiness and an external dependency into the suite; `Mail::fake()` asserts the same intent without a real send |

## Verification

Do not report the work done until all of the following hold:

- The test file sits at the project's own convention path (Pest or
  PHPUnit), matching the style read in Step 1.
- `php artisan test` (or the project's Pest/PHPUnit command) exits 0 with
  every generated test passing.
- `git status` shows only test files and factories added or modified; no
  source file under test changed.
- Every external side effect (mail, queue, outbound HTTP, storage) in a
  new test is faked, not real.
