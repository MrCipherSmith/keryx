---
name: go-code-review
description: "Use when reviewing a Go change for concurrency and idiom risks -- ignored errors, goroutine leaks, data races, context misuse (stored on structs or Background() in handlers), defer in loops, nil map writes, and interface pollution. Read-only, no edits."
triggers:
  - "review this Go diff for goroutine leaks"
  - "check this Go change for goroutine leaks"
  - "review this Go pull request for data races"
  - "any nil map writes in this Go change"
  - "check context misuse in this Go code"
  - "review this Go diff for interface pollution"
metadata:
  origin: authored
  category: review
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Go code review

Read-only review of a Go change for concurrency and idiom risks specific
to Go: ignored errors, goroutine leaks, data races, context misuse, defer
in loops, nil map writes, and interface pollution. This skill never edits
code — it reports findings. `rules/coding-style.mdc`, `rules/patterns.mdc`,
and `rules/security.mdc` are the rule set findings are checked against.

## Workflow

### Step 1: Scope the review

1. Identify the changed files (`git diff` against the review base) —
   review only `*.go` files in the diff, not the whole repository.
2. Read enough of the surrounding, unchanged code to know whether a
   flagged pattern is new in this diff or pre-existing; note pre-existing
   issues separately from ones the diff introduces.

### Step 2: Check each changed function against the focus list

**Errors**
- Every `error` return value from a call is checked, or discarded with a
  visible reason (`_ = f.Close() // best-effort`) — flag a bare dropped
  error (`f()` where `f` returns an error that is never named).
- Errors crossing a layer boundary are wrapped with `%w`, not `%v` or
  string concatenation, unless the function intentionally does not want
  the caller to unwrap (rare — flag it as worth confirming).

**Goroutines and concurrency**
- Every goroutine started in the diff has a visible join point
  (`WaitGroup`, `errgroup`, channel receive) or is deliberately
  fire-and-forget with a stated reason — flag one with neither.
- Shared mutable state (a map, slice, counter, cache) touched from more
  than one goroutine is guarded by a mutex, channel, or `sync/atomic` —
  flag unsynchronized concurrent access, including a map written from one
  goroutine while read from another with no lock.
- A `nil` map is only ever read, never written — flag `m[k] = v` on a map
  that was declared as `var m map[K]V` (nil) rather than `make(map[K]V)`
  or a literal.

**Context**
- `context.Context` is never stored as a struct field — flag a struct
  with a `ctx context.Context` field populated at construction time.
- An HTTP handler or request-scoped function uses the caller's context
  (`r.Context()`), not a fresh `context.Background()`/`context.TODO()` —
  flag `context.Background()` inside a handler or any function that
  received a context from its own caller but discarded it.

**Control flow**
- `defer` inside a loop body accumulates until the function returns (file
  handles, locks, timers) — flag it; the fix is usually an extracted
  per-iteration function so `defer` fires each iteration, not once at the
  end.

**Interfaces**
- An interface defined at the producer with a single implementation, or
  an interface wider than what any one consumer actually calls — flag as
  interface pollution per `rules/patterns.mdc`.

### Step 3: Report

For each finding: file:line, the pattern, why it matters (leak, race,
silent failure), and the fix direction — but do not apply it.

```
internal/worker/pool.go:42 — goroutine started in Run() has no join point
  (no WaitGroup/errgroup, ctx not checked in the loop). Risk: leaks past
  Run()'s return under caller cancellation. Fix direction: wrap with an
  errgroup.Group or pass a WaitGroup the caller can Wait() on.
```

## Rules

- NEVER edit code — findings and fix direction only.
- Flag ignored errors, goroutine leaks, races, context misuse, defer-in-
  loop, nil-map writes, and interface pollution; do not report generic
  style nits already covered by `gofmt`/`go vet` (those are noise here).
- Distinguish a finding the diff introduces from a pre-existing one in
  code the diff merely touches.
- When a suspected race is not certain from reading alone, say
  "run `go test -race ./...` to confirm" rather than asserting a race
  exists without evidence.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "The goroutine will probably finish before the caller exits" | "Probably" is not a join point; without one there is no guarantee, and shutdown races are exactly what leaks under load |
| "It's just a config map, it's only written once at startup" | If it can be written concurrently with any read (even at startup, from an init goroutine), it needs a guard — "only once" is a claim to verify, not assume |
| "I'll just fix the ignored error myself since it's a one-line change" | This skill is read-only; report the finding and its fix direction, do not edit the file |
| "context.Background() here is fine, it's just a helper function" | A helper called from a request path still needs the caller's context for cancellation/deadline/tracing to propagate; check what calls it before excusing it |

## Verification

Do not report the review done until all of the following hold:

- Every changed `*.go` file in the diff was read, not just files named in
  the PR description.
- Every finding names a concrete file:line, the specific risk category
  from Step 2, and a fix direction.
- No source file was modified by this review.
- Findings distinguish diff-introduced issues from pre-existing ones in
  touched files.
