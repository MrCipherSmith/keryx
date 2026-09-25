---
name: fastapi-implementation
description: "Use when implementing or extending a FastAPI path operation, dependency, or Pydantic schema -- covers async vs. sync path operations and FastAPI's threadpool behavior, Depends()-based dependency injection, Pydantic v2 request/response models, response_model filtering, background tasks, and OpenAPI/router conventions. FastAPI projects are Python projects; for generic Python idiom (typing, resource management, asyncio.TaskGroup) not specific to FastAPI's own request lifecycle, use python-implementation."
triggers:
  - "add a FastAPI path operation for..."
  - "implement this endpoint in FastAPI"
  - "write a Pydantic model that validates..."
  - "add a FastAPI dependency for the current user"
  - "add background task support to this FastAPI endpoint"
  - "create a new APIRouter for this resource"
  - "implement OAuth2 login in FastAPI"
  - "add response_model filtering to this endpoint"
metadata:
  origin: authored
  category: implement
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# FastAPI implementation

Implement or extend a path operation, dependency, or schema in a FastAPI
service: discovering the project's own router/schema layout and Pydantic
version before writing code, then applying current-practice async/sync
path-operation semantics, dependency injection, request/response modeling,
and background-work patterns. Scoped to FastAPI's own framework layer — for
generic Python idiom not specific to FastAPI (typing, `asyncio.TaskGroup`,
context managers, packaging) use `python-implementation`; for tests use
`fastapi-testing`; for reviewing a diff without editing it use
`fastapi-code-review`; for fixing a broken build/lint/type-check without
adding a feature use `fastapi-build-fix`.

## Workflow

### Step 1: Discover the project's own conventions

1. Read `pyproject.toml`/`requirements.txt` for the FastAPI and Pydantic
   versions pinned (Pydantic v1 vs. v2 changes model syntax significantly —
   confirm before assuming `model_config`/`field_validator` v2 syntax
   applies).
2. Confirm the project layout: routers under `routers/`/`api/`, schemas
   under `schemas/`/`models/`, a `dependencies.py`, and where `app =
   FastAPI(...)` and `app.include_router(...)` live — place new code
   consistently with what's already there.
3. Read 1-2 neighboring routers for: how auth is injected (a shared
   `Depends(get_current_user)`), how DB sessions are obtained, whether
   `Annotated[...]` or bare default-value `Depends()` is the project's own
   style, and the existing `response_model`/status-code conventions.
4. Check whether the project uses a real task queue (Celery, arq) already —
   if so, a new "run this after the response" need probably belongs there,
   not in `BackgroundTasks`, unless it's genuinely best-effort/in-process
   work.

### Step 2: Design the change

- Decide `async def` vs. plain `def` per `rules/patterns.mdc`: `async def`
  only when the body awaits something async; plain `def` when it calls a
  blocking library, since FastAPI runs a `def` path operation (and `def`
  dependency) in its own threadpool automatically.
- Design the request/response schema first: what does the client send
  (input model), what does the client get back (output model, via
  `response_model`) — these are usually two different `BaseModel`s, not
  one reused for both.
- Decide which existing dependency this change reuses (auth, DB session,
  pagination) vs. what new dependency it needs to add, and whether that
  new dependency needs `yield`-based teardown.

### Step 3: Implement

1. Define/extend the Pydantic `BaseModel`(s) for the request body and
   response, with `Field(...)` constraints for anything with a real shape
   constraint, and `field_validator`/`model_validator` (Pydantic v2) for
   cross-field or custom validation — never accept the body as
   `dict`/`Any`.
2. Write the path operation with `Annotated[<type>, Depends(...)]`
   parameters (matching the project's existing style from Step 1), a
   declared `response_model`, and the correct `async def`/`def` choice
   from Step 2.
3. Add or reuse a `Depends(...)` dependency for anything the path
   operation needs but shouldn't construct itself; use `yield` in the
   dependency if it owns a resource needing teardown.
4. For post-response, best-effort work only, inject `BackgroundTasks` and
   call `.add_task(...)`; for anything needing retries or durability past
   the process lifetime, use the project's real task queue instead.
5. Register a new router with `app.include_router(...)` (or add to the
   existing router file) with `tags=[...]` and a `summary`/docstring for
   non-trivial endpoints.
6. Follow `rules/coding-style.mdc` and `rules/patterns.mdc` for the rest of
   the idiom; check `rules/security.mdc` before touching auth, CORS,
   secrets, or anything building SQL from a validated field. For anything
   not FastAPI-specific (typing, exception chaining, logging), follow
   `python`'s own `rules/coding-style.mdc`/`rules/patterns.mdc`.

### Step 4: Verify

```bash
ruff check .
ruff format --check .
mypy .   # or: pyright
pytest -x -q
python -c "import <app_module>"   # confirms the app still imports/assembles cleanly
```

Prefix each command with the project's own run prefix (`uv run`, `poetry
run`) discovered in Step 1. When the project has an app-startup smoke test
or a `uvicorn <module>:app` check already configured, run that too — a
router registration or dependency wiring mistake can pass every unit test
and still fail at app startup.

### Step 5: Report

```
Implemented: routers/items.py, schemas/item.py
  - added `ItemCreate`/`ItemRead` Pydantic models
  - added `POST /items` path operation with `response_model=ItemRead`
  - ruff/mypy/pytest: all green
```

## Rules

- ALWAYS discover and match the project's own router/schema layout and
  Pydantic version (Step 1) before assuming a structure or v1/v2 syntax.
- NEVER put a blocking call (sync DB driver, `requests`, `time.sleep`,
  blocking file I/O) inside an `async def` path operation or dependency —
  use `def` so FastAPI's threadpool handles it, or use an async client.
- NEVER accept a request body as raw `dict`/`Any`/`await request.json()`
  when a Pydantic `BaseModel` is the correct, validated way to receive it.
- NEVER skip declaring `response_model` on an endpoint returning a model or
  ORM object that carries any field the response should not expose.
- Match the project's existing `Annotated[...]` vs. default-value
  `Depends()` style rather than introducing a second one in the same file.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll make this `async def` since async is the modern way" | If the body calls a blocking library, `async def` blocks the whole event loop for every concurrent request; use plain `def` and let FastAPI's threadpool handle it |
| "I'll just read `await request.json()` here, adding a Pydantic model feels like overkill for one field" | Skips FastAPI's own validation, error responses, and OpenAPI schema generation for that endpoint; even a one-field body gets a `BaseModel` |
| "No `response_model` needed, the ORM object already has the right fields" | `response_model` is what filters the response to the declared fields; without it, a field added to the ORM model later (a password hash, an internal flag) leaks straight into the API response |
| "I'll use `BackgroundTasks` for this, it's simpler than setting up the task queue" | Fine for best-effort, in-process work; wrong for anything that must survive a process restart or needs retries — use the project's real task queue instead |

## Verification

Do not report the work done until all of the following hold:

- The request body and response are modeled as Pydantic `BaseModel`s (not
  `dict`/`Any`), matching the project's Pydantic version from Step 1.
- Every new/touched path operation declares `async def` or `def` correctly
  per Step 2, and `response_model` where the return value can carry fields
  the response should not expose.
- `ruff check .`, `ruff format --check .`, `mypy .`/`pyright`, and
  `pytest -x -q` (or the project's own configured equivalents) exit 0.
- The app still imports/assembles cleanly (Step 4's import/startup check),
  so a router or dependency wiring mistake doesn't slip past unit tests
  alone.
- No blocking call introduced inside an `async def`, and no auth/CORS/
  secrets change made without checking `rules/security.mdc`.
