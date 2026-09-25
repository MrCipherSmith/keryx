---
name: rust-testing
description: "Use when a Rust crate's test suite needs writing, extending, or fixing -- #[cfg(test)] unit tests, tests/ integration tests, table-style cases, #[tokio::test] async tests joined properly, proptest/quickcheck, cargo fuzz, and criterion benchmarks."
triggers:
  - "write Rust tests for this module"
  - "add unit tests in a #[cfg(test)] block"
  - "fix this failing cargo test"
  - "add a proptest for this Rust parser"
  - "write a criterion benchmark for this function"
  - "test this async fn with #[tokio::test]"
  - "add integration tests under tests/ for this crate"
metadata:
  origin: authored
  category: test
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Rust testing (2021/2024 edition)

Write, extend, or fix a Rust crate's test suite: unit tests, integration
tests, async tests, property-based tests, and benchmarks. `rules/testing.mdc`
carries the full rule set this skill's checklist is built from — read it,
not just this summary, before writing tests.

## Workflow

### Step 1: Discover the project's test conventions

1. Read `Cargo.toml`'s `edition`/`rust-version` and dev-dependencies to
   know what's already available: `tokio` (and its `test-util`/`macros`
   features for `#[tokio::test]`), `proptest`/`quickcheck`, `criterion`,
   `serial_test`, `pretty_assertions`.
2. Find the layout: `#[cfg(test)] mod tests` blocks beside the code, or a
   `tests/` integration directory. Match whichever the crate already uses
   for the kind of test you're adding.
3. Read 1-2 neighboring test modules for: case/table shape, whether an
   assertion crate is already in use, fixture conventions
   (`tests/fixtures/` or a local `testdata/`), and whether async tests are
   already wired with `#[tokio::test]`.

### Step 2: Plan test cases

**Functions:** happy path, edge cases (empty/zero-value/boundary inputs),
error cases (assert the specific error variant, not just `is_err()`).

**Table-style:** a `Vec`/slice of a local case struct (name, input,
expected) iterated in one `#[test]` function when several cases share the
same assertion shape, rather than many near-duplicate test functions.

**Async code:** `#[tokio::test]` for an `async fn` test body; a spawned
task is joined via `.await` on its `JoinHandle` (or a channel) before
assertions run.

**Untrusted-input-shaped code (parsers, decoders):** consider `proptest`/
`quickcheck` for the input space, and note where `cargo fuzz` would apply.

### Step 3: Write

1. Create/extend the test module or `tests/` file at the project's own
   convention path.
2. Name each test for the behavior it verifies, not `test1`/`test_x`.
3. Assert the specific error variant on a `Result`-returning function
   (`matches!(err, MyError::NotFound { .. })` or `assert_eq!` when the
   error implements `PartialEq`), not only `result.is_err()`.
4. Put fixture/golden data under the project's existing convention
   (`tests/fixtures/` or `testdata/`).
5. Never synchronize with `std::thread::sleep`/`tokio::time::sleep` to
   "give a spawned task time to finish" — join its `JoinHandle` or a
   channel instead.

### Step 4: Property tests and benchmarks (when relevant)

- `proptest!` (or `quickcheck`) macros for a parser/serializer with a
  large structured input space, generating cases instead of hand-writing
  dozens of near-identical examples.
- `criterion`-based benchmarks (`fn bench(c: &mut Criterion)` registered
  via `criterion_group!`/`criterion_main!`) for anything needing
  statistical rigor; the unstable built-in `#[bench]` needs nightly and is
  not the default choice.

### Step 5: Run and fix

```bash
cargo test
```

Fix failing tests (max 3 iterations) — fix the test, not the source under
test, unless the test itself has correctly caught a real bug (say so in
the report rather than silently changing production code).

### Step 6: Report

```
Generated: src/order/service.rs (tests module), tests/order_integration.rs
  - 7 test cases (4 table-style), all passing under cargo test
```

## Rules

- ALWAYS match the project's existing test-location/table/assertion
  conventions found in Step 1, not a different crate's style.
- NEVER modify source code — only test modules, `tests/` files, and
  fixture data.
- NEVER use `std::thread::sleep`/`tokio::time::sleep` to wait for a
  spawned task or async result instead of joining it.
- Assert the specific error variant for a `Result`-returning function, not
  only `is_err()`/`is_ok()`.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll add a short `tokio::time::sleep(Duration::from_millis(50)).await` so the spawned task finishes" | Non-deterministic under load; `.await` the task's `JoinHandle` (or a channel) so the test cannot flake |
| "This test keeps failing; I'll loosen the assertion to `result.is_err()` without checking which error" | An `is_err()`-only check passes for the wrong failure just as readily as the right one, hiding a regression next time |
| "criterion is overkill for this, I'll just time it with `std::time::Instant` in a test" | Loses warm-up handling, outlier detection, and run-to-run regression comparison that `criterion` provides for free |
| "I'll modify the function slightly so this test passes" | This skill only touches test files; a source change belongs in `rust-implementation` or a stated, separately-reported bug fix, not a silent edit while writing tests |

## Verification

Do not report the work done until all of the following hold:

- The test module/file sits at the project's own convention path, matching
  the table/fixture style read in Step 1.
- `cargo test` exits 0 with every generated test passing.
- `git status` shows only test files (and fixture data, if touched) added
  or modified; no source file under test changed.
- Every spawned task in a new test is joined (`.await` on its `JoinHandle`,
  or a channel) before its assertions run.
