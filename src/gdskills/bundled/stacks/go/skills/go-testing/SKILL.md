---
name: go-testing
description: "Use when a Go package's test suite needs writing, extending, or fixing -- table-driven subtests with t.Run, t.Helper/t.Cleanup/t.Context, testdata golden files, httptest, fuzz tests, -race, and b.Loop benchmarks."
triggers:
  - "write Go tests for this package"
  - "add table-driven tests"
  - "fix failing go test"
  - "add a fuzz test"
  - "write a benchmark with b.Loop"
  - "test this handler with httptest"
metadata:
  origin: authored
  category: test
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Go testing (1.23-1.25)

Write, extend, or fix a Go package's `testing`-based test suite: table-
driven subtests, helpers/cleanup, `httptest`, fuzz tests, and benchmarks.
`rules/testing.mdc` carries the full rule set this skill's checklist is
built from — read it, not just this summary, before writing tests.

## Workflow

### Step 1: Discover the project's test conventions

1. Read `go.mod`'s `go` directive to know whether `t.Context()` (1.24+)
   and `b.Loop()` (1.24+) are available on this project's toolchain.
2. Find the layout: `<file>_test.go` beside the code (package-internal)
   or a `<pkg>_test` black-box package. Match whichever the package
   already uses.
3. Read 1-2 neighboring `_test.go` files for: table shape and field
   names, whether an assertion library is already in use, `testdata/`
   fixture conventions, and whether tests already use `t.Parallel()`.

### Step 2: Plan test cases

**Functions:** happy path, edge cases (nil/empty/zero-value inputs),
error cases (assert with `errors.Is`/`errors.As`, not string matching),
boundary values.

**Table-driven:** one struct per case (`name`, inputs, `want`, `wantErr`),
run via `for _, tc := range cases { t.Run(tc.name, func(t *testing.T) {
... }) }`.

**HTTP handlers:** `httptest.NewRecorder()` + `httptest.NewServer()` for
anything exercising an `http.Handler`; assert status code, headers, and
body — never bind a real listener port.

**Concurrent code:** a test that starts goroutines under test must join
them (channel, `WaitGroup`) before asserting, and the whole suite runs
under `-race`.

### Step 3: Write

1. Create/extend the test file at the project's own convention path.
2. Mark shared setup helpers `t.Helper()` as their first line.
3. Use `t.Cleanup(...)` for teardown instead of scattered `defer`s.
4. Use `t.Context()` (when `go.mod`'s directive is >= 1.24) for a context
   that cancels at test end, instead of hand-rolled
   `context.WithCancel`/`defer cancel()`.
5. Put golden/fixture data under `testdata/`, named for the case it backs.
6. Never synchronize with `time.Sleep`; use a channel, `WaitGroup`, or a
   deadline-bounded poll. Lead every "wait for a goroutine" example with a
   `sync.WaitGroup` (`Add`/`Done`/`Wait`) or a channel send/receive as the
   actual join mechanism.

### Step 4: Fuzz and benchmark (when relevant)

- `func FuzzX(f *testing.F)` with `f.Add(...)` seed values for any parser
  or decoder touching untrusted input; note in the report that `go test
  -fuzz=FuzzX` should be run separately (fuzzing is not part of the
  default `go test` run).
- `func BenchmarkX(b *testing.B) { for b.Loop() { ... } }` (Go 1.24+) for
  new benchmarks; fall back to the classic `for i := 0; i < b.N; i++` loop
  only when `go.mod`'s directive predates 1.24.

### Step 5: Run and fix

```bash
go test -race ./...
```

Fix failing tests (max 3 iterations) — fix the test, not the source under
test, unless the test itself has correctly caught a real bug (say so in
the report rather than silently changing production code).

### Step 6: Report

```
Generated: internal/order/service_test.go
  - 8 test cases (5 table-driven), all passing under -race
```

## Rules

- ALWAYS match the project's existing table/fixture/assertion
  conventions found in Step 1, not a different project's style.
- NEVER modify source code — only test files and `testdata/`.
- NEVER use `time.Sleep` to wait for a goroutine or async result, and
  never write `time.Sleep` into example code at all -- not even to
  simulate work inside the goroutine being waited on.
- Run the suite with `-race` whenever the code under test touches
  goroutines, channels, or shared state.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll add a short `time.Sleep(100 * time.Millisecond)` so the goroutine finishes" | Non-deterministic under load; use a channel/WaitGroup/`t.Context()` deadline so the test cannot flake |
| "This test keeps failing; I'll loosen the assertion to `wantErr: true` without checking the error type" | `errors.Is`/`errors.As` exist for a reason — a loosened assertion covers nothing about *which* error, hiding a regression next time |
| "b.N is simpler, I'll skip b.Loop even though go.mod says 1.25" | Ignoring an available, more accurate benchmarking primitive for no reason; use `b.Loop()` when the toolchain supports it |
| "The handler test is flaky on a real port, I'll just retry it" | Retrying hides the actual bug (a port race); use `httptest.NewServer`/`NewRecorder`, which need no real listener port |

## Verification

Do not report the work done until all of the following hold:

- The test file sits at the project's own convention path, matching the
  table/fixture style read in Step 1.
- `go test -race ./...` exits 0 with every generated test passing.
- `git status` shows only test files (and `testdata/`, if touched) added
  or modified; no source file under test changed.
- Every new goroutine started by a test is joined before its assertions
  run.
