---
name: python-build-fix
description: "Use when a Python project fails to import, build, type-check, or lint -- resolves ModuleNotFoundError/ImportError, packaging or editable-install failures, dependency resolver conflicts (pip/uv/poetry), mypy/pyright type errors, ruff failures, and pytest collection errors with the smallest root-cause fix."
triggers:
  - "fix this ModuleNotFoundError"
  - "python import is failing"
  - "mypy is failing"
  - "ruff check is failing"
  - "pip dependency conflict"
  - "pytest collection error"
  - "editable install is broken"
metadata:
  origin: authored
  category: build-fix
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Python build-fix

Resolve a broken Python build, import, dependency, type-check, or lint
failure with the smallest change that fixes the actual cause. Scoped to
making the toolchain green again — for adding a feature use
`python-implementation`, for writing/fixing test *content* (not a collection
error) use `python-testing`, for reviewing without fixing use
`python-code-review`.

## Workflow

### Step 1: Reproduce and classify the failure

Run the project's own configured commands (from `pyproject.toml`, discover
the run prefix — `uv run`, `poetry run`, or none):

```bash
ruff check .
ruff format --check .
mypy .   # or: pyright
pytest -x -q
```

Read the *first* error in each tool's output — later errors are often
downstream of the first. Classify:

- **Import/ModuleNotFoundError** — package not installed, wrong environment
  active, circular import, or a typo'd module path.
- **Packaging/editable install** — `pip install -e .` fails, or an installed
  package's modules aren't importable (missing `__init__.py`, wrong `src/`
  layout declared in `pyproject.toml`'s `[tool.hatch.build]`/
  `[build-system]`).
- **Dependency resolver conflict** — `pip`/`uv`/`poetry` reports
  incompatible version constraints between two dependencies.
- **Type errors** — `mypy`/`pyright` reports a real type mismatch.
- **Lint failures** — `ruff check` reports a rule violation.
- **Pytest collection errors** — a test file fails to import (distinct from
  a test that runs and fails).

### Step 2: Find the root cause

- **ModuleNotFoundError**: is the package installed in the active
  environment (`pip show <pkg>` / `uv pip show <pkg>`)? Is the import path
  correct relative to the project's `src/`-layout or flat layout? Is this a
  circular import (`A` imports `B` which imports `A`) that needs a
  restructure (move the shared symbol, or import inside the function) — not
  a `try/except ImportError` wrapper.
- **Packaging/editable install**: check `[build-system]` and the package
  discovery config (`[tool.setuptools.packages.find]` or `[tool.hatch.build]`)
  actually points at the real package directory; a missing `__init__.py` in
  a namespace-package-by-mistake is a common cause.
- **Dependency conflict**: read the resolver's own explanation of which two
  constraints collide; find the actual compatible version range (check the
  conflicting packages' own changelogs/release notes) rather than force-
  installing with `--no-deps` or pinning to an arbitrary older version.
- **Type errors**: read the exact mismatch mypy/pyright reports; fix the
  signature or the call site — whichever is actually wrong given the
  function's real contract, not whichever silences the error fastest.
- **Lint failures**: apply `ruff check --fix .` for genuinely mechanical
  fixes (unused imports, import order); for a substantive rule (unused
  variable that indicates a real bug, `S`-prefixed security rule) fix the
  code, don't suppress the rule.
- **Pytest collection errors**: usually an import error in the test file or
  `conftest.py` itself — apply the same import-error diagnosis above to the
  test file's own imports.

### Step 3: Apply the smallest fix

- Fix the actual cause identified in Step 2 — the missing dependency, the
  wrong import path, the real type mismatch, the actual lint violation.
- When a version conflict is genuinely unresolvable without a larger
  upgrade, say so explicitly in the report rather than silently pinning
  around it.
- Touch only what the failure requires; do not refactor unrelated code
  while fixing a build failure.

### Step 4: Verify

Re-run every command from Step 1 in order; all must exit 0. Also run
`pytest -x -q` even when the original failure was only a lint/type error —
a fix can introduce a runtime regression the linter/type-checker won't see.

### Step 5: Report

```
Fixed: ModuleNotFoundError: No module named 'mypkg.util'
  Root cause: src/mypkg/util.py existed but pyproject.toml's package-find
    config excluded src/mypkg/, so the editable install never linked it.
  Fix: added "mypkg*" to [tool.setuptools.packages.find].include
  Verified: ruff check, mypy, pytest -x -q all green
```

## Rules

- NEVER add `# type: ignore` or `# noqa` as a blanket suppression to make a
  real error disappear without fixing or explicitly justifying it inline.
- NEVER pin, downgrade, or `--no-deps` install a dependency to route around
  a real conflict without stating in the report that this is a workaround
  and why a proper fix wasn't available.
- NEVER wrap a real ImportError in `try/except ImportError: pass` to hide a
  missing dependency — install/declare it, or fix the import path.
- Fix the root cause with the smallest change; do not refactor beyond what
  the failure requires.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll just add `# type: ignore` here, the real fix is bigger" | Hides the type hole permanently; if the real fix is out of scope, say so in the report and leave the error visible rather than silently suppressing it |
| "I'll pin this package to the old version that worked" | Papers over an incompatibility that will resurface; identify the actual compatible range or report that a larger upgrade is needed |
| "The test file won't import, I'll just skip it with `pytest.mark.skip`" | A collection error means the test never runs at all; skipping hides that permanently instead of fixing the import |
| "`ruff check --fix` didn't fix everything, I'll disable the rule in `pyproject.toml`" | Disabling a rule project-wide silences it for all future code, not just this failure; fix the flagged code instead |

## Verification

Do not report the fix done until all of the following hold:

- The originally failing command now exits 0.
- `ruff check .`, `ruff format --check .`, `mypy .`/`pyright`, and
  `pytest -x -q` (the project's own configured equivalents) all exit 0.
- No new `# type: ignore`/`# noqa` was added without an inline reason, and
  none was added as a blanket suppression.
- `git status` shows only the files whose actual cause was diagnosed in
  Step 2 — no unrelated refactor.
- The report names the root cause, not just the symptom that was fixed.
