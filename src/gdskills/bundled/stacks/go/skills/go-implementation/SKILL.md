---
name: go-implementation
description: "Use when implementing or extending a feature in a Go service or module -- module layout under cmd/ and internal/, interface placement, context propagation, goroutine lifetimes with errgroup or WaitGroup, error wrapping with %w, and log/slog usage."
triggers:
  - "implement this feature in Go"
  - "add a Go module with layout under cmd/ and internal/"
  - "propagate context.Context correctly through this Go function"
  - "add a goroutine worker pool with errgroup"
  - "place this interface at the Go consumer"
  - "wrap this Go error with %w"
metadata:
  origin: authored
  category: implement
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Go implementation (1.23-1.25)

Implement or extend a feature in a Go codebase: module/package layout,
interface placement, error handling, context propagation, goroutine
lifetimes, and modern standard-library idiom. Scoped to Go specifically —
`rules/coding-style.mdc`, `rules/patterns.mdc`, and `rules/security.mdc`
carry the full stack-specific rule set this skill draws its checklist
from; read them before writing code, not just this summary.

## Workflow

### Step 1: Discover the project's own conventions

1. Read `go.mod` for the module path and the `go` directive (the minimum
   Go version this project targets) — do not use a language feature (like
   `WaitGroup.Go`, Go 1.25) the module's own `go` directive predates.
2. Find the existing layout: `cmd/<binary>/main.go` entry points,
   `internal/` for private packages, any top-level packages meant as a
   public API. Match it; do not invent a different layout for one change.
3. Read 1-2 neighboring files in the package you are touching for: error
   handling style, whether `log/slog` or another logger is already
   standardized, existing interface boundaries, and whether the project
   uses `errgroup`/`golang.org/x/sync` (check `go.mod`'s require block).

### Step 2: Design before writing

- Decide which new type is a struct (concrete, constructed with `New...`
  or zero-value-useful) and which is an interface (defined at the
  consumer, sized to what that consumer actually calls).
- Trace the `context.Context` path: where does it originate (an HTTP
  handler's `r.Context()`, a CLI's `signal.NotifyContext`), and does every
  function on the call path accept and forward it as the first parameter?
- For any new goroutine, decide its owner and exit condition up front —
  `errgroup.Group` when you need the first error and shared cancellation,
  `sync.WaitGroup` (or `WaitGroup.Go` when the project's `go` directive is
  >= 1.25) when you just need "all finished", explicit `ctx` cancellation
  either way.

### Step 3: Implement

1. Accept interfaces, return structs (`rules/patterns.mdc`); keep the
   interface as small as the consumer needs.
2. Wrap errors with `fmt.Errorf("doing x: %w", err)` at each meaningful
   layer boundary; compare with `errors.Is`/`errors.As`, never string
   equality.
3. Use `log/slog` with structured fields for anything worth logging in
   new code, unless the project has already standardized on a different
   logger — match what is there.
4. Reach for a generic type parameter only when it removes real
   duplication; do not generify a single-call-site function.
5. Format with `gofmt`/`goimports` as you go, not as an afterthought.

### Step 4: Verify

```bash
go build ./...
go vet ./...
go test -race ./...
```

Run the project's configured linter (`golangci-lint run ./...`) if one is
configured (a `.golangci.yml`/`.golangci.toml` present). Fix findings at
the root cause per `rules/security.mdc` and `rules/coding-style.mdc`; a
build/vet/test failure at this step is a signal to fix the implementation,
not to reach for `go-build-fix`'s scope unless the failure is purely a
build/module/import-cycle problem unrelated to the feature logic.

### Step 5: Report

```
Implemented: internal/order/service.go, internal/order/service_test.go
  - New OrderService interface consumed by cmd/api
  - go build/vet/test -race all pass
```

## Rules

- Never store a `context.Context` on a struct field; thread it as the
  first parameter instead.
- Never start a goroutine with no join point (`WaitGroup`, `errgroup`) or
  cancellation path (`ctx`) — every goroutine has a known owner and exit.
- Never swallow an error (`_ = err` with no comment, or an empty `if err
  != nil {}`); check it, wrap it, or return it.
- Match the project's declared `go` directive — do not use a stdlib
  feature newer than what `go.mod` targets.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll define the interface next to the implementation since that's where the type lives" | Interfaces belong at the consumer (`rules/patterns.mdc`); a producer-side interface with one implementation is usually unnecessary indirection that also invites import-cycle pressure |
| "This goroutine is short-lived, it doesn't need a WaitGroup" | Short-lived is not the same as guaranteed-to-finish-before-the-caller-returns; an unjoined goroutine can still leak or race with process shutdown |
| "I'll use `%v` instead of `%w` here, the caller doesn't need to unwrap it" | The caller you cannot see yet is exactly who `errors.Is`/`errors.As` serves; `%w` costs nothing and keeps the option open |
| "context.Background() is fine, this is just internal code" | Internal code still needs the caller's cancellation/deadline/values; `context.Background()` inside a call chain silently breaks cancellation propagation |

## Verification

Do not report the work done until all of the following hold:

- `go build ./...`, `go vet ./...`, and `go test -race ./...` all exit 0.
- Every new goroutine has a visible join point or cancellation path.
- Every new/touched error return is checked, wrapped with `%w`, or
  explicitly discarded with a comment explaining why.
- `gofmt -l` reports no files needing formatting.
