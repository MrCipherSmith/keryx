---
name: python-code-review
description: "Use when reviewing Python changes for correctness and safety risks -- checks mutable default arguments, broad except clauses, resource leaks missing a with block, blocking calls inside async functions, typing holes (Any, missing Optional), N+1/ORM query misuse, and security sinks. Read-only: reports findings, does not edit code."
triggers:
  - "review this python diff"
  - "check this python pr for bugs"
  - "review python code changes"
  - "audit this python module"
  - "check for python security issues"
  - "review this async python code"
metadata:
  origin: authored
  category: review
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Python code review

Review a set of Python changes for correctness, resource-safety, typing, and
security risk. Read-only: this skill reports findings, it never edits code.
Scoped to Python-specific defects; for generic architecture/style review use
the catalog's `review-*` skills, for a language-agnostic security sweep use
`review-security-code`, for fixing what this skill finds use
`python-build-fix` (checker failures) or hand the report to the author.

## Workflow

### Step 1: Scope the review

1. Identify the changed Python files (`git diff` against the review base,
   or the files the requester names).
2. Read `pyproject.toml` for the project's configured `ruff`/`mypy`/
   `pyright` rules — a finding this skill would raise that the project's
   own linter already enforces and passes on is lower priority than one the
   linter cannot catch (logic, resource, or security issues).
3. Read enough of the surrounding module (call sites, class definition) to
   judge whether a flagged pattern is actually a bug in context, not just a
   pattern match.

### Step 2: Check each changed file against these categories

**Mutable defaults and shared state**
- `def f(items=[])`/`def f(config={})` — a mutable default is shared and
  mutated across every call that omits the argument.
- A module-level or class-level mutable used as implicit shared state
  across requests/calls without synchronization.

**Exception handling**
- Bare `except:` or `except Exception:` that swallows an error the caller
  needed to see, especially one that also catches
  `asyncio.CancelledError`/`KeyboardInterrupt`/`SystemExit`.
- A re-raise that drops the original traceback (`raise NewError(...)`
  inside an `except` block with no `from exc`).
- An `except` block that logs and continues where the correct behavior was
  to propagate.

**Resource management**
- A file, socket, DB connection, lock, or temp resource opened without
  `with`/`async with`, or closed only on the happy path (no `finally`/
  context manager covering the exception path).
- A context manager whose `__exit__`/`finally` doesn't actually run cleanup
  when the body raises.

**Async correctness**
- A blocking call (`requests.get`, `time.sleep`, synchronous file I/O, a
  CPU-bound loop) directly inside an `async def` instead of the async
  client, `asyncio.sleep`, or `asyncio.to_thread`.
- A coroutine created but never awaited (`asyncio.create_task` result
  discarded with no reference kept, or a bare `coro()` call with no
  `await`).
- `asyncio.gather`/manual task tracking where a `TaskGroup` would give
  correct sibling-cancellation semantics, if the project targets 3.11+.

**Typing**
- A new/touched public function with no type hints, or a hint that is
  `Any` where a `Protocol`/union/`TypeVar` would express the real
  constraint.
- A parameter or return that can be `None` at some call site but is typed
  without `Optional`/`| None`.
- A type: ignore/noqa added to silence a real typing/lint issue rather than
  fixing it.

**Data access**
- A loop that issues one query per iteration (N+1) where a single
  batched/joined query or `select_related`/`prefetch_related` (Django) or
  equivalent eager-load would do.
- An ORM query built by interpolating a value into a raw SQL string instead
  of using parameter binding or the ORM's query builder.

**Security** (full list: `rules/security.mdc`)
- `subprocess` with `shell=True` or a string command.
- `eval`/`exec` on anything that could carry untrusted input.
- `pickle.load`/`yaml.load` (not `safe_load`) on data not fully controlled
  by the project.
- SQL built by string interpolation instead of parameters.
- A network call with no `timeout`, or `verify=False`.
- A hard-coded secret, or a token generated with `random` instead of
  `secrets`.

### Step 3: Report

For each finding: file:line, category, what's wrong, and the safe
alternative (cite the exact API/pattern, e.g. "use `secrets.token_urlsafe`
instead of `random.random()`"). Group by severity — a security sink or a
resource leak outranks a missing type hint.

```
python-code-review: 3 findings
  [security] auth.py:42 — `subprocess.run(cmd, shell=True)`; pass an
    argument list instead
  [resource] client.py:18 — `open()` with no `with`; the handle leaks if
    `json.load` raises
  [typing] models.py:9 — `def find(id) -> User:` has no param type and can
    return `None`; add `id: int` and `-> User | None`
```

## Rules

- NEVER edit the files under review — report findings only.
- Cite the specific line and the specific safe alternative; a vague "this
  could be an issue" finding is not actionable.
- Do not duplicate a finding the project's own configured `ruff`/`mypy`
  rules already enforce and would catch on their own — focus on what static
  tooling misses (resource lifetime across exception paths, N+1 patterns,
  logic bugs, security sinks needing call-site context).
- Distinguish a real bug from a stylistic preference; a stylistic point
  belongs in `rules/coding-style.mdc`/`rules/patterns.mdc`, not a review
  finding blocking the change.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "The `except Exception` here is fine, it just logs" | Logging and continuing after swallowing an exception still hides the failure from the caller and from any monitoring keyed off the exception propagating |
| "It's just a review, I'll fix the mutable default myself since it's a one-liner" | This skill is read-only; even a trivial fix belongs to the author or `python-build-fix`, not a silent edit during review |
| "The N+1 loop only ever runs over 3 items in tests" | Test data size does not bound production data size; flag it regardless of the loop's current call sites |

## Verification

Do not report the review done until all of the following hold:

- Every changed Python file in scope was checked against all seven
  categories in Step 2.
- No finding duplicates something the project's own configured linter/type
  checker already flags and enforces.
- Every finding names a file:line, the specific problem, and a specific
  fix — no vague findings.
- No file under review was modified.
