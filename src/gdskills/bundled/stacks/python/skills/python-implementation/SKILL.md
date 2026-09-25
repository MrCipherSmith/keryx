---
name: python-implementation
description: "Use when implementing or extending a feature in a modern Python (3.12/3.13) codebase or service -- covers project tooling discovery (pyproject.toml, uv/poetry/pip, ruff, mypy/pyright), typing (generics, Protocol, TypedDict, dataclasses), context managers, exception chaining, asyncio TaskGroup, request/event logging with the standard logging module, and src/-layout packaging."
triggers:
  - "implement this in python"
  - "add a python feature"
  - "write a python function"
  - "add a dataclass"
  - "implement asyncio taskgroup"
  - "add type hints to this module"
  - "package this as a python module"
  - "add a protocol class"
  - "log requests in this python service"
metadata:
  origin: authored
  category: implement
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Python implementation

Implement or extend a feature in a modern Python (3.12/3.13) codebase:
discovering the project's own tooling and conventions before writing code,
then applying current-practice typing, resource management, error handling,
concurrency, logging, and packaging patterns. Scoped to writing production
code — for writing/fixing tests use `python-testing`, for reviewing a diff
without editing it use `python-code-review`, for fixing a broken build/lint/
type-check without adding a feature use `python-build-fix`.

## Workflow

### Step 1: Discover the project's own tooling and conventions

1. Read `pyproject.toml` for: build backend, dependency manager (`uv`,
   `poetry`, plain `pip`+`requirements.txt`), configured tools
   (`[tool.ruff]`, `[tool.mypy]`/`[tool.pyright]`, `[tool.pytest.ini_options]`),
   and the declared minimum Python version (`requires-python`).
2. Confirm the package layout: `src/<package>/` (modern) vs. a flat
   `<package>/` at repo root — place new modules consistently with what is
   already there, don't introduce the other layout.
3. Read 1-2 neighboring modules for: docstring style, typing style (PEP 604
   `X | None` vs. `Optional[X]`), import grouping, and whether the project
   already uses `from __future__ import annotations`.
4. Check `requires-python`/CI config for the actual supported Python
   versions before using a 3.12+-only feature (type-parameter syntax
   `class Box[T]:`, `except*`) in a project that must also run on 3.11 or
   earlier.

### Step 2: Design the change

- Prefer extending an existing module/class over adding a new one for a
  small change; add a new module when the change introduces a genuinely new
  concern.
- Pick the data-modeling shape for the job: `@dataclass` for a fixed set of
  related fields your own code constructs, `TypedDict` for a dict shape
  that must stay a `dict` (e.g. JSON), `Protocol` for "anything with this
  method" instead of a concrete base class, `Generic`/type-parameter syntax
  for a container whose element type varies by call site. See
  `rules/patterns.mdc` for the full set.
- Decide error handling up front: which specific exception types the new
  code raises, and which (if any) it must catch — never plan around a bare
  `except:`/`except Exception:`.

### Step 3: Implement

1. Type-hint every new public function signature, including `| None`/
   `Optional` where a parameter or return can be absent (match the
   project's PEP 604 vs. `Optional` convention from Step 1).
2. Acquire any closable/lockable resource with `with`/`async with`; write a
   custom context manager with `@contextlib.contextmanager` unless the type
   also needs other methods.
3. Raise a specific exception type, chaining with `raise NewError(...) from
   exc` when re-raising inside an `except` block.
4. For concurrent work, group related awaitables with `asyncio.TaskGroup`
   and let `asyncio.CancelledError` propagate through cleanup rather than
   swallowing it; never call a blocking function inside `async def` (use
   the async client, `asyncio.sleep`, or `asyncio.to_thread`).
5. Log through the standard `logging` module (or the project's structured
   logger) with lazy `%s` interpolation, not `print` or an f-string passed
   to the logging call.
6. Follow `rules/coding-style.mdc` for naming/formatting/imports and
   `rules/patterns.mdc` for the rest of the idiom; check `rules/security.mdc`
   before touching subprocess calls, deserialization, SQL, file paths, or
   secrets.

### Step 4: Verify

```bash
ruff check .
ruff format --check .
mypy .   # or: pyright
pytest -x -q
```

Prefix each command with the project's own run prefix when it uses one
(`uv run ruff check .`, `poetry run pytest -x -q`) — discovered in Step 1
from `pyproject.toml`/lockfile presence, not assumed.

### Step 5: Report

```
Implemented: src/mypkg/feature.py
  - added `Widget` dataclass + `build_widget()`
  - ruff/mypy/pytest: all green
```

## Rules

- ALWAYS discover and match the project's own tooling (Step 1) before
  assuming `uv`/`poetry`/`pip`, `mypy`/`pyright`, or a specific Python
  version.
- NEVER add `# type: ignore` or `# noqa` to route around a real typing or
  lint problem — fix the underlying code, or narrow the suppression to the
  one line with a comment explaining why it is correct as written.
- NEVER use a Python version feature the project's `requires-python` does
  not support.
- Match the project's existing docstring style rather than introducing a
  second one in the same file.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll just use `Any` here, typing this properly is fiddly" | Defeats the type checker for every downstream caller; use `Protocol`/`Generic`/a union instead, or `TypeVar` if the shape is genuinely generic |
| "This helper doesn't need a `with` block, I'll just call `.close()` at the end" | Skips cleanup the moment an exception is raised before that line runs; use `with`/`try`/`finally` |
| "I'll catch `Exception` broadly so nothing crashes" | Hides bugs in unrelated code paths as silently-ignored failures; catch the specific exception type you can actually handle |
| "3.12 syntax is cleaner, I'll use it even though `requires-python` says 3.10" | Breaks on every environment still running the declared minimum version |

## Verification

Do not report the work done until all of the following hold:

- New/touched public functions are type-hinted per Step 3.1, matching the
  project's `Optional`/`| None` convention from Step 1.
- `ruff check .`, `ruff format --check .`, and `mypy .`/`pyright` (or the
  project's own configured equivalents) exit 0 on the touched files.
- `pytest -x -q` (or the project's configured runner) passes; if a feature
  needs new tests, hand off to `python-testing` rather than writing test
  files as part of this skill's own change set when out of scope.
- No bare `except:`/`except Exception:`, no unclosed resource, no blocking
  call inside `async def`, introduced by this change.
