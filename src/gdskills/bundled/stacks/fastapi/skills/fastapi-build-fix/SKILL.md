---
name: fastapi-build-fix
description: "Use when a FastAPI app itself fails to start, import, or register a router -- app-startup failures, dependency-injection wiring errors (Depends() on the wrong callable, a missing sub-dependency), Pydantic v1/v2 model/validation errors, and a checker flagging a path-operation signature or response_model specifically, with the smallest root-cause fix. For a generic Python ModuleNotFoundError/packaging/dependency-resolver failure not specific to FastAPI's own app wiring, use python-build-fix."
triggers:
  - "fix this FastAPI app startup error"
  - "the FastAPI app fails to import after adding a new router"
  - "this Depends() dependency is failing to resolve"
  - "this FastAPI path operation's response_model is rejecting valid data"
  - "the linter flags this FastAPI router file specifically"
  - "this Pydantic model keeps raising an unexpected validation error"
  - "fix this FastAPI router registration error causing a 404"
metadata:
  origin: authored
  category: build-fix
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# FastAPI build-fix

Resolve a broken FastAPI app startup, dependency-injection wiring, type-
check, or lint failure with the smallest change that fixes the actual
cause. Scoped to FastAPI's own framework layer — for a generic Python
`ModuleNotFoundError`, packaging, or dependency-resolver failure not
specific to FastAPI's own app wiring, use `python-build-fix`; for adding a
feature use `fastapi-implementation`; for writing/fixing test content (not
a collection error) use `fastapi-testing`; for reviewing without fixing use
`fastapi-code-review`.

## Workflow

### Step 1: Reproduce and classify the failure

Run the project's own configured commands (discover the run prefix — `uv
run`, `poetry run`, or none — from `pyproject.toml`):

```bash
ruff check .
ruff format --check .
mypy .   # or: pyright
pytest -x -q
python -c "import <app_module>"   # or: uvicorn <app_module>:app --port 0
```

Read the *first* error in each tool's output. Classify:

- **App startup/import** — `app = FastAPI(...)` module fails to import, or
  `uvicorn` fails to start the app (distinct from a generic Python
  `ModuleNotFoundError` unrelated to FastAPI wiring — that goes to
  `python-build-fix`).
- **Router registration** — `app.include_router(...)` raises, a route
  conflict (duplicate path + method), or a route silently 404s because it
  was never registered.
- **Dependency-injection wiring** — `Depends(...)` resolves to the wrong
  callable, a sub-dependency is missing, or FastAPI reports it cannot
  determine how to resolve a dependency's own parameters.
- **Pydantic model errors** — a `BaseModel` raises at class-definition time
  (bad field type, invalid `Field(...)` constraint) or at request-parse
  time in a way that shouldn't be a validation error at all (a v1/v2
  syntax mismatch is a common cause).
- **Type errors** — `mypy`/`pyright` reports a real mismatch on a path
  operation's parameters, return type, or a `Depends(...)`-injected value.
- **Lint failures** — `ruff check` reports a rule violation.

### Step 2: Find the root cause

- **App startup/import**: does `app = FastAPI(...)` fail because a router
  module it imports itself fails to import (circular import between
  `main.py` and a router, or a router importing something not yet
  defined)? Read the actual traceback's innermost frame, not just the
  outermost "app failed to start" message.
- **Router registration**: check `app.include_router(router, prefix=...,
  tags=[...])` — a duplicated `prefix` across two routers, or a path
  operation decorated on the wrong router variable, are the common causes
  of a route that 404s despite the code appearing correct.
- **Dependency-injection wiring**: read FastAPI's own error message about
  which parameter it couldn't resolve; check whether the dependency
  function's own parameters are all themselves either request data
  (query/path/body) or other `Depends(...)` — a parameter with no default
  and no `Depends(...)`/request-data annotation is what breaks resolution.
- **Pydantic model errors**: confirm the pinned Pydantic version
  (`pyproject.toml`) and whether the failing syntax is v1-only (`class
  Config:`, `@validator`) or v2-only (`model_config = ConfigDict(...)`,
  `@field_validator`) — mixing the two is the most common cause of a
  confusing model-definition error.
- **Type errors**: read the exact mismatch; a `Depends(...)`-injected
  parameter's annotated type must match what the dependency function
  actually returns — fix whichever side is actually wrong given the
  dependency's real contract.
- **Lint failures**: apply `ruff check --fix .` for mechanical fixes; for a
  substantive rule, fix the flagged code.

### Step 3: Apply the smallest fix

- Fix the actual cause identified in Step 2 — the wrong `Depends(...)`
  target, the router registered on the wrong variable, the v1/v2 syntax
  mismatch, the real type mismatch.
- Touch only what the failure requires; do not refactor unrelated
  path operations or schemas while fixing a build failure.

### Step 4: Verify

Re-run every command from Step 1 in order; all must exit 0, including the
app-import/startup check — a fix that satisfies `mypy`/`ruff` can still
leave the app failing to start if a router or dependency wiring mistake
remains.

### Step 5: Report

```
Fixed: FastAPI app failed to start with `PydanticUserError` because a
  model defined both `Config` and `model_config`
  Root cause: schemas/notifications.py's `NotificationSettings` model still
    had its original v1-style `class Config:` block, and someone added a
    v2-style `model_config = ConfigDict(...)` alongside it -- Pydantic v2
    rejects a model that carries both configuration mechanisms at once,
    which surfaced as an import-time failure, not just a warning.
  Fix: removed the old `class Config:` block and migrated its one setting
    (`orm_mode` -> `from_attributes`) into `model_config =
    ConfigDict(from_attributes=True)`, leaving the model with exactly one
    config mechanism.
  Verified: ruff check, mypy, pytest -x -q, and app import all green
```

## Rules

- NEVER add `# type: ignore` or `# noqa` as a blanket suppression to make a
  real error disappear without fixing or explicitly justifying it inline.
- NEVER move a blocking call into an `async def` path operation (or leave
  one there) to make an error disappear — if the fix requires the function
  to stay blocking, keep it `def` so FastAPI's threadpool handles it.
- NEVER widen a Pydantic field's type to `Any`/`dict` to make a validation
  error stop, when the actual cause is a v1/v2 syntax mismatch or a genuine
  schema bug.
- Fix the root cause with the smallest change; do not refactor beyond what
  the failure requires.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "This Pydantic validation error is annoying, I'll just type the field `Any`" | Hides the real schema mismatch (often a v1/v2 syntax mix) instead of fixing it; find and fix the actual cause |
| "The dependency resolution error is confusing, I'll just remove the `Depends(...)` and call the function directly" | Removes dependency injection entirely, losing `dependency_overrides` testability and any caching FastAPI provided; fix the actual parameter FastAPI couldn't resolve |
| "I'll add `# type: ignore` here, the real fix is bigger" | Hides the type hole permanently; if the real fix is out of scope, say so in the report and leave the error visible |
| "ruff flagged something in this router, I'll disable the rule in `pyproject.toml`" | Disables it project-wide for all future code, not just this failure; fix the flagged code instead |

## Verification

Do not report the fix done until all of the following hold:

- The originally failing command now exits 0.
- `ruff check .`, `ruff format --check .`, `mypy .`/`pyright`, `pytest -x
  -q`, and the app import/startup check all exit 0.
- No new `# type: ignore`/`# noqa` was added without an inline reason, and
  none was added as a blanket suppression.
- `git status` shows only the files whose actual cause was diagnosed in
  Step 2 — no unrelated refactor.
- The report names the root cause, not just the symptom that was fixed.
