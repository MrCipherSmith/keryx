---
name: dotnet-build-fix
description: "Use when dotnet build/dotnet test fails, or a NuGet restore is broken -- resolves package/target-framework mismatches, compiler errors, nullable-annotation warnings, analyzer/StyleCop findings, and a failing test, with the smallest root-cause fix rather than a suppression."
triggers:
  - "dotnet build is failing"
  - "fix this NuGet package restore error"
  - "resolve this nullable reference type warning"
  - "dotnet build analyzer warning"
  - "StyleCop is failing on this C# file"
  - "dotnet test is failing, fix the build"
metadata:
  origin: authored
  category: build-fix
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# .NET build fix

Resolve a `dotnet build`/`dotnet test` failure, a NuGet restore error, a
compiler error, a nullable-reference-type warning, an analyzer/StyleCop
finding, or a failing test — with the smallest change that fixes the
actual root cause. `rules/coding-style.mdc` and `rules/security.mdc`
govern what a "correct" fix looks like; this skill never reaches for a
suppression instead of a fix.

## Workflow

### Step 1: Reproduce and classify

```bash
dotnet build
dotnet test
```

Read the exact error/warning text and classify it:

- **Compile error** (undefined symbol, type mismatch, wrong overload
  resolution).
- **Package/restore** (NuGet version conflict, a `PackageReference`
  pointing at a version that does not exist, a target-framework
  mismatch between a project and one of its package dependencies).
- **Nullable warning** (`CS8600`-`CS8655` range — a possible null
  reference, an unannotated parameter used where `?` was expected).
- **Analyzer/style finding** (a Roslyn analyzer, StyleCop, or an
  `.editorconfig`-driven `IDE`/`CA` rule).
- **Failing test** (an assertion failure or unhandled exception under
  `dotnet test`).

### Step 2: Fix by category

**Package/restore:** run `dotnet restore` when the lock file is simply
stale. For a genuine version conflict, check `dotnet list package
--include-transitive` to see what is pulling in the conflicting version
before bumping anything by hand. Only pin a package to an explicit
version for a real, understood reason (a known-bad release, an
intentional hold) — never to make a conflict disappear without
understanding it, and say so in the report either way.

**Compile error:** read the exact overload/type the compiler expected
versus what was supplied; fix the call site or the signature, whichever
is actually wrong relative to the feature's intent — do not change a
public signature just to make one call site compile if other callers
would break.

**Nullable warning:** fix the actual null path — add a real null check,
give the value a non-null initializer, or restructure so the compiler's
flow analysis can see the invariant. Only annotate the type `?` if the
value can genuinely be null by design. Never resolve the warning with
the null-forgiving operator (`value!`) as a substitute for an actual
guard, and never widen the fix into `<Nullable>disable</Nullable>` for
the file or project.

**Analyzer/StyleCop finding:** fix the underlying issue the rule names
(the real formatting/ordering/pattern it wants). Never add
`#pragma warning disable` or a `[SuppressMessage(...)]` attribute whose
only purpose is to make the analyzer stop complaining without addressing
what it found.

**Failing test:** read the assertion failure or stack trace; fix the
production code if the test correctly caught a real bug, or fix the test
if its expectation was wrong — state which one you concluded and why in
the report, never silently delete or skip the test to reach green.

### Step 3: Verify

```bash
dotnet build
dotnet test
dotnet format --verify-no-changes
```

All must exit 0 before reporting done.

### Step 4: Report

```
Fixed: NuGet version conflict between Package.A 3.0 and Package.B's
  transitive dependency on Package.A 2.5
  - Root cause: Package.B pinned an older Package.A that Package.A 3.0's
    breaking change conflicted with; updated Package.B instead of
    downgrading Package.A
  - dotnet build/test/format all pass
```

State the root cause in one sentence, not just "fixed the error."

## Rules

- Find and fix the smallest change that addresses the actual root
  cause — never widen a fix beyond what the failure requires.
- NEVER add `#pragma warning disable` or `[SuppressMessage(...)]` to
  silence an analyzer/StyleCop finding instead of fixing what it found.
- NEVER add `<Nullable>disable</Nullable>` (project- or file-wide) or
  reach for the null-forgiving operator (`value!`) as a substitute for
  an actual null-safety fix.
- NEVER pin or downgrade a NuGet package to route around a real
  incompatibility without understanding and stating why in the report.
- NEVER delete or skip a failing test to reach a green build.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll add `#pragma warning disable CS8602` around this block" | Silences the finding without fixing the possible-null-dereference it caught; add the actual null check instead |
| "This nullable warning is annoying, I'll just add `!` here" | The null-forgiving operator tells the compiler to trust you without verifying anything; use it only at a boundary you can justify in a comment, never as a default fix |
| "I'll just downgrade this package to the version that used to work" | Papers over whatever actually changed without understanding it; check `dotnet list package --include-transitive` and fix the real conflict |
| "This test keeps failing, I'll mark it `[Fact(Skip = \"flaky\")]`" | Hides a real regression instead of fixing it; find out whether the test or the code is wrong before touching either |

## Verification

Do not report the fix done until all of the following hold:

- `dotnet build`, `dotnet test`, and `dotnet format --verify-no-changes`
  all exit 0.
- The change is the smallest one that addresses the stated root cause —
  no unrelated files touched.
- No `#pragma warning disable`, `[SuppressMessage(...)]`,
  `<Nullable>disable</Nullable>`, or unexplained null-forgiving operator
  was added as part of the fix.
- The report states the root cause in one sentence, not just "build now
  passes."
