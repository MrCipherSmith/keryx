---
name: python-testing
description: "Use when you write, extend, or fix a Python project's pytest suite -- add pytest.mark.parametrize cases, design conftest.py fixtures at the right scope, use pytest.mark.asyncio for coroutines, and patch external calls with mocker.patch/monkeypatch to close coverage gaps in a failing or incomplete test file. Not for auditing test conventions without changing files (see review-testing-practices)."
triggers:
  - "write pytest tests"
  - "add python test coverage"
  - "fix failing pytest test"
  - "pytest fixture"
  - "parametrize test"
metadata:
  origin: authored
  category: test
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Python testing (pytest)

Write, extend, or fix a Python project's `pytest` test suite. Scoped to
pytest specifically — its fixture system, `parametrize`, and `monkeypatch`/
`unittest.mock` conventions differ enough from a generic test-generation
workflow (`quality/test-gen`) that a pytest-specific one earns its own
skill; see `governance/scout.json` for why a fork of an existing skill was
not enough.

## Workflow

### Step 1: Discover the project's pytest conventions

1. Read `pyproject.toml`/`setup.cfg`/`pytest.ini` for `[tool.pytest.ini_options]`
   or `[pytest]` — test paths, markers, `addopts` (e.g. `--strict-markers`,
   coverage flags already configured).
2. Find the test layout: `tests/` mirroring `src/`, or co-located
   `test_*.py`/`*_test.py` next to the module under test. Match whichever
   the project already uses.
3. Read 1-2 neighboring test files for: fixture style (local `conftest.py`
   vs. inline), naming (`test_<behavior>`), assertion style (plain
   `assert` vs. a matcher library), and how mocks are constructed.

### Step 2: Plan fixtures before test cases

- A fixture belongs in the narrowest `conftest.py` that covers every test
  needing it — the test file's own directory, not the suite root, unless
  siblings already need it too.
- Prefer a fixture's natural scope (`function` is the pytest default) over
  widening to `module`/`session` for convenience; a wider-scoped fixture
  that mutates state leaks between tests that assumed isolation.
- Use `pytest.fixture(params=[...])` or a `@pytest.mark.parametrize` on the
  test itself for input variations — parametrize the test when only the
  inputs vary, use a fixture when setup/teardown logic itself varies.

### Step 3: Plan test cases

**Functions:** happy path, edge cases (empty/`None`/zero/negative),
exception cases (`pytest.raises(SpecificError)`), boundary values.

**Fixtures/context managers:** setup ran, teardown ran even when the body
raises, correct value yielded.

**Async code:** `pytest.mark.asyncio` (or the project's configured async
plugin) — do not write a sync test that silently never awaits the coroutine
under test.

**Mocks:** patch at the point of use (`mocker.patch("mypkg.mod.dep")`, not
the definition site), and only external dependencies — an internal
collaborator mocked away stops the test verifying real integration.

### Step 4: Write

1. Create/extend the test file at the project's own convention path.
2. Import fixtures via `conftest.py` discovery, not manual re-import.
3. One assertion concept per test; a multi-assertion test states in its
   name what single behavior it verifies.
4. Use `pytest.mark.parametrize` with explicit `ids=` when parameter tuples
   are not self-describing in pytest's default output.

### Step 5: Run and fix

```bash
keryx test run --changed --strict
```

`src/testing/service.ts` detects the project's own test runner from its
lockfile/scripts — do not hard-code `pytest` invocation flags here beyond
what Step 1 already discovered. On a project with no keryx testing config,
run the project's own configured `pytest` invocation instead.

Fix failing tests (max 3 iterations) — fix the test, not the source under
test.

### Step 6: Report

```
Generated: tests/test_helper.py
  - 9 test cases (3 parametrized), all passing
```

## Rules

- ALWAYS match the project's existing fixture/parametrize/mock conventions
  found in Step 1-2, not a different project's pytest style.
- NEVER modify source code — only test files and `conftest.py`.
- Mock external dependencies (network, filesystem, other services), not
  internal modules under the same package.
- If no `pytest` is configured, suggest adding it; do not add it
  unasked.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "This fixture is only used once but I'll put it in the root `conftest.py` anyway" | Widens its visible scope and discoverability for no reason; a fixture used by one test file belongs in that directory's own `conftest.py` |
| "The assertion keeps failing; I'll patch the source under test to make it pass" | This skill writes test files only. A source change buried in a test-authoring run is an unreviewed fix that also hides the real bug |
| "I'll mock the internal helper so the test is simpler" | Mock external dependencies, not internal ones — a test whose internal collaborators are all mocked only checks that the mocks agree with each other |
| "Still failing after three iterations; I'll loosen the assertion" | A test that asserts nothing covers nothing while reporting coverage. After 3 iterations, stop and report the failing case instead |

## Verification

Do not report the work done until all of the following hold:

- The test file sits at the project's own convention path, matching the
  fixture/parametrize/mock style read in Step 1-2.
- `keryx test run --changed --strict` — or, with no keryx testing config,
  the project's own discovered `pytest` command — exits 0 with every
  generated test passing.
- `git status` shows only test files (and `conftest.py`, if touched)
  added or modified; no source file under test changed.
- Every exported function/class/endpoint identified in Step 1 that lacked
  coverage now has at least one test, or the report says why it does not.
