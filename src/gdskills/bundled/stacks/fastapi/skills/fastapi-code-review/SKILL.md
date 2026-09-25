---
name: fastapi-code-review
description: "Use when reviewing FastAPI changes for correctness and safety risks -- checks blocking calls inside async def path operations/dependencies, request bodies accepted as dict/Any instead of Pydantic models, missing response_model filtering, missing or misplaced auth dependencies, unsafe CORS configuration, and hard-coded secrets. Read-only: reports findings, does not edit code. For generic Python-level review (mutable defaults, broad except, resource leaks) not specific to FastAPI's own request lifecycle, use python-code-review."
triggers:
  - "review this FastAPI diff"
  - "check this FastAPI pull request for bugs"
  - "review this FastAPI endpoint for security issues"
  - "audit this FastAPI router"
  - "review this async FastAPI code for blocking calls"
  - "check this FastAPI code for missing response_model"
metadata:
  origin: authored
  category: review
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# FastAPI code review

Review a set of FastAPI changes for correctness, resource-safety, and
security risk specific to FastAPI's own request lifecycle. Read-only: this
skill reports findings, it never edits code. Scoped to FastAPI-specific
defects; for generic Python correctness/resource/typing review (mutable
defaults, broad `except`, unclosed resources) use `python-code-review`, for
a language-agnostic security sweep use `review-security-code`, for fixing
what this skill finds use `fastapi-build-fix` (checker failures) or hand
the report to the author.

## Workflow

### Step 1: Scope the review

1. Identify the changed FastAPI files (`git diff` against the review base,
   or the files the requester names) — path operations, dependencies,
   Pydantic schemas, middleware/app setup.
2. Read `pyproject.toml` for the project's configured `ruff`/`mypy` rules
   and pinned FastAPI/Pydantic versions — a finding this skill would raise
   that the project's own linter already enforces and passes is lower
   priority than one static tooling cannot catch.
3. Read enough of the surrounding router/dependency graph to judge whether
   a flagged pattern is actually a bug in context (e.g. whether a
   dependency really is meant to be public, or whether a sync call really
   has no async alternative available).

### Step 2: Check each changed file against these categories

**Async correctness**
- A blocking call (sync DB driver, `requests.get`, `time.sleep`, blocking
  file I/O) directly inside an `async def` path operation or `async def`
  dependency, instead of `def` (which FastAPI threadpools automatically) or
  an async client.
- A `def` path operation declared `async def` purely for "consistency"
  where its body has no actual async work — not a bug, but worth a note if
  it invites a future blocking call to land inside it unnoticed.

**Request validation**
- A request body accepted as raw `dict`/`Any`, or read manually via `await
  request.json()`, where a Pydantic `BaseModel` should validate it instead.
- A Pydantic field with no shape constraint (`Field(...)` bounds,
  `Literal`, `pattern`) where an unconstrained value flows into something
  size- or shape-sensitive downstream (a file path, a numeric calculation,
  a SQL parameter).

**Response modeling**
- A path operation returning a model/ORM object with no `response_model`
  (or return-type annotation FastAPI can use as one), especially when the
  underlying object carries a field the response should not expose (a
  password hash, an internal flag).
- A `response_model` that includes a field it shouldn't, or omits a field
  callers actually need — read the model definition, not just its
  presence.

**Dependency injection and auth**
- A path operation that should require authentication with no
  `Depends(get_current_user)`-equivalent dependency present.
- Auth logic duplicated inline in a path operation instead of factored into
  a shared dependency, making it easy for a future endpoint to omit it by
  accident.
- A dependency missing `yield`-based teardown for a resource that needs
  closing (a DB session, a lock).

**Security** (full list: `rules/security.mdc`)
- `CORSMiddleware` configured with `allow_origins=["*"]` combined with
  `allow_credentials=True`.
- A hard-coded `SECRET_KEY`, API key, or database URL in source instead of
  read through `pydantic-settings`/environment.
- Password verification skipped on an unknown-username lookup (a username-
  enumeration timing gap), or a token generated with `random` instead of a
  real JWT/`secrets`-based mechanism.
- SQL built by interpolating a (even Pydantic-validated) field into a raw
  string instead of parameter binding or the ORM's query builder.

**Background work**
- Work that must not be lost (payment capture, an email the user depends
  on) handled with `BackgroundTasks` instead of a real task queue with
  retries.

### Step 3: Report

For each finding: file:line, category, what's wrong, and the safe
alternative (cite the exact pattern, e.g. "declare `response_model=UserRead`
so `hashed_password` is filtered from the response"). Group by severity — a
missing auth dependency or an unsafe CORS config outranks a missing
`Field` constraint.

```
fastapi-code-review: 3 findings
  [security] routers/users.py:22 — `GET /users/{id}` has no auth
    dependency; add `Depends(get_current_user)`
  [async] routers/orders.py:40 — `requests.get(...)` called directly
    inside `async def create_order`; make the function `def` or use
    `httpx.AsyncClient`
  [response-modeling] routers/users.py:15 — no `response_model` declared;
    the returned `User` carries `hashed_password`, which will leak into
    the response body
```

## Rules

- NEVER edit the files under review — report findings only.
- Cite the specific line and the specific safe alternative; a vague "this
  could leak data" finding is not actionable.
- Do not duplicate a finding the project's own configured `ruff`/`mypy`
  rules already enforce and would catch on their own — focus on what
  static tooling misses (blocking-call placement, response-model gaps,
  auth-dependency omissions, security sinks needing call-site context).
- Distinguish a real bug from a stylistic preference; a stylistic point
  belongs in `rules/coding-style.mdc`, not a review finding blocking the
  change.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "The endpoint is `async def` but the blocking call is quick, it's fine" | A "quick" blocking call still runs on the shared event loop and stalls every other concurrent request for its full duration; flag it regardless of expected latency |
| "No `response_model` needed, the frontend only reads the fields it wants" | The frontend not reading a leaked field doesn't stop it from being present in the response body for anything else (a proxy log, a browser devtools inspection, a different client) to see |
| "It's just a review, I'll add the missing `Depends(get_current_user)` myself since it's one line" | This skill is read-only; even a trivial fix belongs to the author or `fastapi-build-fix`, not a silent edit during review |

## Verification

Do not report the review done until all of the following hold:

- Every changed FastAPI file in scope was checked against all six
  categories in Step 2.
- No finding duplicates something the project's own configured linter/type
  checker already flags and enforces.
- Every finding names a file:line, the specific problem, and a specific
  fix — no vague findings.
- No file under review was modified.
