---
name: go-build-fix
description: "Use when go build/go vet fails, or go.mod/go.sum are out of sync -- resolves module/toolchain mismatches, import cycles, generic type inference errors, staticcheck/golangci-lint failures, and a failing go test -race, with the smallest root-cause fix."
triggers:
  - "go build is failing"
  - "fix go.mod go.sum mismatch"
  - "resolve this import cycle in Go"
  - "go vet error"
  - "golangci-lint is failing"
  - "go test -race is failing"
metadata:
  origin: authored
  category: build-fix
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Go build fix

Resolve a `go build`/`go vet` failure, a `go.mod`/`go.sum` mismatch, an
import cycle, a generic type-inference error, a `staticcheck`/
`golangci-lint` failure, or a failing `go test -race` — with the smallest
change that fixes the actual root cause. `rules/coding-style.mdc` and
`rules/security.mdc` govern what a "correct" fix looks like; this skill
never reaches for a suppression instead of a fix.

## Workflow

### Step 1: Reproduce and classify

```bash
go build ./...
go vet ./...
```

Run the project's configured linter if present (`golangci-lint run
./...`, checked via a `.golangci.yml`/`.golangci.toml`). Read the exact
error text and classify it:

- **Compile error** (undefined symbol, type mismatch, wrong arg count).
- **Module/toolchain** (`go.mod`/`go.sum` mismatch, missing `go mod
  tidy`, a `replace` directive pointing somewhere stale, a `go` /
  `toolchain` directive older than a feature the code uses).
- **Import cycle** (`import cycle not allowed`).
- **Generic inference** (`cannot infer T`, a type parameter that cannot
  be resolved from the call site).
- **Vet/lint finding** (`go vet`'s own checks, or a `staticcheck`/
  `golangci-lint` rule).
- **Race** (`go test -race` reports a `DATA RACE`).

### Step 2: Fix by category

**Module/toolchain:** run `go mod tidy` when `go.sum` is simply stale
against `go.mod`'s requirements. For a genuine version conflict, check
`go mod why -m <module>` and `go mod graph` before bumping a version by
hand. Only add/edit a `replace` directive when it points at a real,
intentional local override (a monorepo sibling, a patched fork) — never
to paper over a version conflict without understanding it, and say so in
the report either way.

**Import cycle:** find the shared type/function both packages need and
extract it into a third package both can depend on, or invert one
dependency by defining the needed interface at the consumer (per
`rules/patterns.mdc`) instead of importing the concrete producer package.
Do not "fix" a cycle by merging the two packages into one unless they
were genuinely one responsibility already.

**Generic inference failure:** check whether the call site can supply the
type argument explicitly (`Func[T](...)`) before restructuring the
generic signature; if inference is failing because the type parameter
does not actually vary at the call sites, consider whether generics are
buying anything here at all.

**Vet/lint finding:** fix the underlying issue the finding names (e.g. a
real `printf`-format mismatch, an unreachable branch, an unused
`context.Context` parameter meant to be used). Never add `//nolint` or a
`_ = ` discard whose only purpose is to make the checker stop complaining
without addressing what it found.

**Race:** read the reported access pair (`go test -race`'s output names
both goroutines and lines). Add the missing synchronization (mutex,
channel handoff, `sync/atomic`) at the actual shared-state access point —
do not just serialize the whole test or add a `time.Sleep` to hide the
timing window.

### Step 3: Verify

```bash
go build ./...
go vet ./...
go test -race ./...
```

Re-run the project's linter if it was part of the original failure. All
must exit 0 before reporting done.

### Step 4: Report

```
Fixed: go.mod/go.sum toolchain mismatch (ran `go mod tidy`)
  - Root cause: go.sum predated a dependency bump in go.mod
  - go build/vet/test -race all pass
```

State the root cause in one sentence, not just "fixed the error."

## Rules

- Find and fix the smallest change that addresses the actual root cause —
  never widen a fix beyond what the failure requires.
- NEVER add `//nolint` or a blank `_ =` discard to silence a vet/lint
  finding instead of fixing what it found.
- NEVER change the `go` directive or a major dependency version just to
  make an error disappear without understanding why it changed.
- NEVER add a `replace` directive to route around a real compile error
  without confirming it is an intentional, documented override.
- NEVER delete or skip a failing test to reach a green build.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll add `//nolint:errcheck` here so the linter stops complaining" | Silences the finding without fixing the ignored error it caught; check the error instead |
| "Bumping the go directive to 1.25 makes this compile" | Changes the module's declared minimum toolchain for every consumer to dodge one error; understand why the code needs 1.25 first, or fix the code to work at the declared version |
| "This test is flaky under -race, I'll just run it without -race in CI" | Hides a real data race instead of fixing the missing synchronization; add the mutex/channel instead |
| "I'll merge these two packages to kill the import cycle" | A cycle usually means a shared piece belongs in a third package, not that the two packages were never separate — check the actual dependency shape first |

## Verification

Do not report the fix done until all of the following hold:

- `go build ./...`, `go vet ./...`, and `go test -race ./...` all exit 0.
- The project's linter (if configured) exits 0.
- The change is the smallest one that addresses the stated root cause —
  no unrelated files touched.
- The report states the root cause in one sentence, not just "build now
  passes."
