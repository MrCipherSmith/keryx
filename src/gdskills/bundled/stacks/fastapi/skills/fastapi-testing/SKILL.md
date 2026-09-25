---
name: fastapi-testing
description: "Use when you write, extend, or fix a FastAPI project's test suite -- covers TestClient/httpx.AsyncClient requests against the real app, app.dependency_overrides for auth/DB fixtures, asserting response status codes and response_model filtering, and mocking external HTTP calls. Not for testing plain Python functions with no HTTP layer (see python-testing) or auditing test conventions without changing files (see review-testing-practices)."
triggers:
  - "write a pytest test for this FastAPI endpoint"
  - "test this FastAPI route with TestClient"
  - "add dependency_overrides for the current user in this test"
  - "test that this endpoint returns a 422 on bad input"
  - "mock the external API call in this FastAPI test"
  - "add test coverage for this FastAPI router"
metadata:
  origin: authored
  category: test
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# FastAPI testing

Write, extend, or fix a FastAPI project's test suite: exercising path
operations through the real `app` instance via `TestClient`/
`httpx.AsyncClient`, overriding dependencies the FastAPI-supported way, and
asserting the response contract (status code, body shape, `response_model`
filtering) rather than just that a call didn't raise. Scoped to FastAPI's
own test-client and dependency-override conventions — for testing a plain
Python function with no HTTP layer use `python-testing`; for reviewing test
conventions without changing files use `review-testing-practices`.

## Workflow

### Step 1: Discover the project's FastAPI test conventions

1. Read `pyproject.toml`/`pytest.ini` for pytest config, and check whether
   `httpx`'s `ASGITransport` or `fastapi.testclient.TestClient` is already
   in use — match whichever the project already uses rather than
   introducing the other.
2. Find the existing `app`/`client` fixture (usually in `conftest.py`) and
   any existing `dependency_overrides` pattern for auth or the DB session —
   reuse it rather than building a parallel one.
3. Read 1-2 neighboring endpoint tests for: how the DB is set up for tests
   (throwaway SQLite, a test-scoped Postgres schema, a fixture-provided
   session), how auth is faked, and the project's assertion style.

### Step 2: Plan fixtures before test cases

- A `client`/`app` fixture belongs in the narrowest `conftest.py` that
  covers every test file needing it, matching `python`'s own fixture-scope
  guidance.
- Plan `dependency_overrides` per test (or per fixture, yielding and
  clearing) rather than setting them once at module import time with no
  teardown — an override left set leaks into unrelated tests.
- Decide the DB fixture strategy: a real throwaway test database behind a
  `get_db` override for integration-level coverage, reserving a mocked
  session only for the rare case where isolating from the DB entirely is
  the actual point of the test.

### Step 3: Plan test cases

**Per path operation:** the success path (status code + body shape),
the validation-failure path (a `422` when the request body fails Pydantic
validation), any documented error path (a `404`/`403`/`409` the endpoint
raises deliberately), and — when the endpoint requires auth — both an
authenticated and an unauthenticated case via `dependency_overrides`.

**`response_model` filtering:** when a path operation declares
`response_model`, at least one test asserts that a field the model
excludes (e.g. a password hash) is actually absent from the response body.

**External calls:** mock at the client boundary (`httpx`/`requests` mock,
or the project's configured HTTP-mocking library) — never mock an internal
collaborator in the same package, matching `python-testing`'s own rule.

### Step 4: Write

1. Build the request through `TestClient(app)`/`AsyncClient(transport=
   ASGITransport(app=app), base_url="http://test")`, matching the
   project's own style from Step 1.
2. Override dependencies with `app.dependency_overrides[real_dep] =
   fake_dep`, clearing them in teardown (fixture `yield` + cleanup, or an
   explicit `.clear()`), never by monkeypatching the dependency's module
   attribute.
3. Assert `response.status_code` and the parsed `response.json()` body,
   not merely that the call completed without raising.
4. Use `pytest.mark.parametrize` for input variations across the same
   endpoint (e.g. several invalid-body shapes that should each 422).

### Step 5: Run and fix

```bash
keryx test run --changed --strict
```

`src/testing/service.ts` detects the project's own test runner — do not
hard-code `pytest` invocation flags beyond what Step 1 discovered. With no
keryx testing config, run the project's own configured `pytest` invocation.

Fix failing tests (max 3 iterations) — fix the test, not the source under
test.

### Step 6: Report

```
Generated: tests/routers/test_users.py
  - 6 test cases: success, 422 on bad body, 404 on missing user,
    401 without auth override, 200 with auth override, response_model
    excludes hashed_password
```

## Rules

- ALWAYS test through `TestClient`/`AsyncClient` against the real `app`,
  not by calling the path operation function directly.
- ALWAYS clear any `app.dependency_overrides` entry the test set, so it
  cannot leak into a later test in the same process.
- NEVER modify source code — only test files and `conftest.py`.
- Mock genuinely external dependencies (a third-party HTTP API, an email
  provider), not internal modules under the same package.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll call `read_user(user_id=1, db=fake_db)` directly, it's faster than spinning up TestClient" | Skips FastAPI's own request parsing, dependency resolution, and response filtering — exactly where most path-operation bugs live |
| "I'll set `app.dependency_overrides[get_current_user] = fake_user` once at the top of the file" | With no teardown, this override leaks into every other test in the same process, including ones that meant to test the unauthenticated path |
| "I'll use `mocker.patch(\"myapp.dependencies.get_current_user\", ...)` instead of `dependency_overrides`" | Patches the function at its module attribute instead of using FastAPI's own supported override mechanism; `app.dependency_overrides` is what keeps the fake scoped to requests actually routed through the app |
| "The endpoint didn't raise, so the test passes" | A wrong status code or a malformed body with no exception is a real bug a bare no-exception check misses; assert the actual response contract |
| "I'll mock the DB session so the test doesn't need a real database" | A mocked ORM session only checks the code called the mock the way the mock expects; use a real throwaway test database behind a `get_db` override for anything beyond the simplest unit test |

## Verification

Do not report the work done until all of the following hold:

- Every new/extended test exercises the path operation through
  `TestClient`/`AsyncClient` against the real `app`, not the function
  directly.
- Any `app.dependency_overrides` entry set by a test is cleared afterward
  (fixture teardown or explicit `.clear()`).
- `keryx test run --changed --strict` — or, with no keryx testing config,
  the project's own discovered `pytest` command — exits 0.
- `git status` shows only test files (and `conftest.py`, if touched)
  added or modified; no source file under test changed.
- Every new/touched path operation identified in Step 1 has coverage for
  its success path, its validation-failure path, and, when it requires
  auth, both an authenticated and unauthenticated case — or the report
  says why one is missing.
