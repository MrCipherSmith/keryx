---
name: c-cpp-testing
description: "Use when a C or C++ test suite needs writing, extending, or fixing -- GoogleTest TEST/TEST_F/TEST_P, death tests, fixture setup/teardown, and verifying a memory-safety or concurrency fix under AddressSanitizer/UndefinedBehaviorSanitizer/ThreadSanitizer."
triggers:
  - "write GoogleTest cases for this C++ class"
  - "add a TEST_F fixture for this component"
  - "fix this failing ctest"
  - "add a death test for this assertion"
  - "verify this fix under AddressSanitizer"
  - "add a parameterized test with TEST_P"
metadata:
  origin: authored
  category: test
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# C / C++ testing (GoogleTest, sanitizers)

Write, extend, or fix a C/C++ test suite: GoogleTest cases and fixtures,
death tests, parameterized tests, and sanitizer-backed verification for
memory-safety and concurrency fixes. `rules/testing.mdc` carries the full
rule set this skill's checklist is built from — read it, not just this
summary, before writing tests.

## Workflow

### Step 1: Discover the project's test conventions

1. Find the test tree (`tests/`, `test/`, or `*_test.cpp` beside the
   source) and the test framework already wired into the build
   (GoogleTest is assumed unless the project's `CMakeLists.txt`/build
   files show Catch2 or another framework — match whichever is there).
2. Read 1-2 neighboring test files for: fixture naming, assertion style
   (`ASSERT_*` vs `EXPECT_*` usage pattern), whether mocks
   (`gmock`) are already in use, and whether sanitizer builds are already
   configured as a separate CMake preset/target.
3. Check whether the project's CI or build scripts already run an ASan/
   UBSan/TSan build — reuse that configuration rather than inventing a
   new one.

### Step 2: Plan test cases

**Functions:** happy path, edge cases (empty/zero/null inputs, boundary
values), error cases (an exception thrown, an error code returned, or —
for a hard invariant — a process-terminating `CHECK`/`assert`).

**Fixtures:** `TEST_F` with a fixture class deriving from
`::testing::Test`, shared setup in `SetUp()`/teardown in `TearDown()`,
not the constructor/destructor, when setup can fail in a way the test
should assert on.

**Parameterized:** `TEST_P` + `INSTANTIATE_TEST_SUITE_P` for the same
case body run across a range of inputs, instead of copy-pasted `TEST`s
with different literals.

**Memory-safety/UB fixes:** a regression test that reproduces the bug
(use-after-free, buffer overflow, signed overflow, data race) under the
relevant sanitizer before the fix, and passes clean under that same
sanitizer after it.

**Concurrent code:** a test that starts threads under test joins them
(`std::thread::join`, a future, a condition variable) before asserting —
never `sleep`-synchronized — and the whole suite runs at least once under
ThreadSanitizer.

### Step 3: Write

1. Create/extend the test file at the project's own convention path.
2. Name suites/cases for the behavior under test (`ParsesEmptyInput`,
   not `Test1`).
3. Use `ASSERT_*` when a failure means the rest of the test cannot
   meaningfully continue (a null result every later line dereferences);
   `EXPECT_*` otherwise, so later checks still report.
4. For a death test, set the death test style explicitly
   (`GTEST_FLAG_SET(death_test_style, "threadsafe")`) when the binary is
   multi-threaded — the default `fast` style can misbehave forking a
   process with more than one live thread.
5. Release any resource a fixture owns (temp files, mock servers,
   threads) in `TearDown()`, not just at the end of a passing test body.

### Step 4: Run and fix

```bash
ctest --test-dir build --output-on-failure
```

Fix failing tests (max 3 iterations) — fix the test, not the source under
test, unless the test itself has correctly caught a real bug (say so in
the report rather than silently changing production code).

### Step 5: Sanitizer verification (when relevant)

For any test covering manual memory management, buffers, pointer
arithmetic, or shared concurrent state, also run:

```bash
cmake -S . -B build-asan -DCMAKE_BUILD_TYPE=Debug \
  -DCMAKE_CXX_FLAGS='-fsanitize=address,undefined -fno-omit-frame-pointer -g'
cmake --build build-asan && ctest --test-dir build-asan --output-on-failure

cmake -S . -B build-tsan -DCMAKE_BUILD_TYPE=Debug \
  -DCMAKE_CXX_FLAGS='-fsanitize=thread -fno-omit-frame-pointer -g'
cmake --build build-tsan && ctest --test-dir build-tsan --output-on-failure
```

ASan/UBSan and TSan are separate runtimes and must not be linked into the
same binary — build them as distinct configurations.

### Step 6: Report

```
Generated: tests/token_stream_test.cpp
  - 9 cases (3 TEST_F, 2 TEST_P instances), ctest all passing
  - Regression case for the reported use-after-free passes clean under ASan
```

## Rules

- ALWAYS match the project's existing framework, fixture, and assertion
  conventions found in Step 1, not a different project's style.
- NEVER modify source code under test — only test files (and fixtures/
  mocks/testdata).
- NEVER synchronize a concurrent test with `sleep`/`usleep`/
  `std::this_thread::sleep_for`; join the thread or wait on a
  condition variable/future instead.
- Run the relevant sanitizer(s) before reporting a memory-safety,
  UB, or concurrency fix verified.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll add a short `sleep_for(100ms)` so the worker thread finishes" | Non-deterministic under load; join the thread or wait on a condition variable so the test cannot flake |
| "The fix looks right by inspection, I don't need to run ASan again" | Memory-safety and UB bugs are exactly the class of defect that "looks right" while still being wrong; sanitizer re-verification is the actual check |
| "This test keeps failing; I'll change EXPECT_EQ to EXPECT_NE so it's easier to satisfy" | Weakening the assertion covers nothing about *what* the correct behavior is; find out why the actual value differs from what's expected |
| "It's just a background thread, TSan is overkill for one test" | A single unguarded shared access is enough to be a data race; TSan is the tool built to catch exactly that at low cost |

## Verification

Do not report the work done until all of the following hold:

- The test file sits at the project's own convention path, matching the
  fixture/assertion style read in Step 1.
- `ctest --test-dir build --output-on-failure` exits 0 with every
  generated test passing.
- For a memory-safety, UB, or concurrency fix: the regression test also
  passes under the relevant sanitizer build (ASan+UBSan, or TSan for a
  race).
- Every thread started by a test is joined before its assertions run; no
  test synchronizes with `sleep`.
