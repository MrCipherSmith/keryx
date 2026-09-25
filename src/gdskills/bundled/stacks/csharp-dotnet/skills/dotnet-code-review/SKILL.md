---
name: dotnet-code-review
description: "Use when reviewing a C#/.NET change for async and resource-safety risks -- async void outside event handlers, sync-over-async (.Result/.Wait()), swallowed/blanket exception catches, missing IDisposable/IAsyncDisposable cleanup, and nullable-annotation gaps. Read-only, no edits."
triggers:
  - "review this C# diff for async void misuse"
  - "check this .NET change for sync-over-async deadlock risk"
  - "review this C# pull request for swallowed exceptions"
  - "any missing IDisposable cleanup in this C# change"
  - "check nullable annotation gaps in this C# diff"
  - "review this ASP.NET Core diff for DI lifetime mistakes"
metadata:
  origin: authored
  category: review
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# .NET code review

Read-only review of a C#/.NET change for async-safety, resource-safety,
and idiom risks specific to C#/.NET: `async void` misuse, sync-over-async
blocking, blanket exception handling, missing disposal, nullable-
annotation gaps, and DI lifetime mistakes. This skill never edits code —
it reports findings. `rules/coding-style.mdc`, `rules/patterns.mdc`, and
`rules/security.mdc` are the rule set findings are checked against.

## Workflow

### Step 1: Scope the review

1. Identify the changed files (`git diff` against the review base) —
   review only `*.cs` files in the diff, not the whole repository.
2. Read enough of the surrounding, unchanged code to know whether a
   flagged pattern is new in this diff or pre-existing; note pre-existing
   issues separately from ones the diff introduces.

### Step 2: Check each changed member against the focus list

**Async**
- A method declared `async void` that is not a genuine event handler —
  flag it; any exception it throws bypasses normal `try`/`catch` at the
  call site and crashes the process instead.
- A blocking `.Result`, `.Wait()`, or `.GetAwaiter().GetResult()` call on
  a `Task` from otherwise-synchronous code — flag as sync-over-async
  deadlock risk.
- `ValueTask`/`ValueTask<T>` awaited or converted more than once, or
  stored for later awaiting — flag it; a `ValueTask` supports exactly one
  await/consumption.

**Exception handling**
- A broad `catch (Exception)` (or bare `catch`) that swallows the
  exception (no rethrow, no logging, no narrowing to the specific type
  actually expected) — flag it; the diff should catch the specific
  exception type a call can throw, or let an unexpected one propagate.
- `catch (Exception ex) { }` with an empty or no-op body — flag as a
  silent failure regardless of whether the outer catch is otherwise
  reasonable.

**Nullability**
- A new public parameter/return type with no nullable annotation that is
  later dereferenced without a null check, or a `!` null-forgiving
  operator used to bypass a nullability warning without a comment
  justifying why the value is provably non-null there — flag either.

**Resources**
- An `IDisposable`/`IAsyncDisposable` local or field created without a
  `using`/`await using` and with no corresponding `Dispose`/`DisposeAsync`
  call on the owning type — flag it as a resource leak.

**Dependency injection**
- A `Scoped` service (most commonly a `DbContext`) captured directly into
  a `Singleton`'s field or constructor parameter — flag it; the
  `Singleton` will hold the first-resolved instance for the app's whole
  lifetime instead of a fresh one per request/scope.

### Step 3: Report

For each finding: file:line, the pattern, why it matters (crash, deadlock,
leak, silent failure), and the fix direction — but do not apply it.

```
src/Orders/OrderNotifier.cs:18 — async void SendAsync() is not an event
  handler. Risk: any exception it throws bypasses the caller's try/catch
  and crashes the process. Fix direction: return Task and await it from
  the caller.
```

## Rules

- NEVER edit code — findings and fix direction only.
- Flag `async void` misuse, sync-over-async blocking, blanket exception
  swallowing, nullable-annotation gaps, missing disposal, and Scoped-
  into-Singleton DI captures; do not report generic style nits already
  covered by `dotnet format`/analyzers (those are noise here).
- Distinguish a finding the diff introduces from a pre-existing one in
  code the diff merely touches.
- When a suspected deadlock or leak is not certain from reading alone,
  say "reproduce under load / run with a resource profiler to confirm"
  rather than asserting it with certainty absent evidence.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "This `.Result` call is on a path that never actually deadlocks in practice" | "Never in practice" is not a guarantee; sync-over-async deadlocks are timing- and load-dependent, and the fix (making the caller `async`) costs little |
| "The blanket `catch (Exception)` here is fine, it's just cleanup code" | Cleanup code failing silently still hides a real bug; catch the specific exception type expected, or log and rethrow |
| "I'll just fix the missing `using` myself since it's a one-line change" | This skill is read-only; report the finding and its fix direction, do not edit the file |
| "Injecting the DbContext straight into this Singleton is fine, it's only used for one query" | Every future request reuses that same first-resolved DbContext instance regardless of scope; the lifetime mismatch is the bug, not how it's currently used |

## Verification

Do not report the review done until all of the following hold:

- Every changed `*.cs` file in the diff was read, not just files named in
  the PR description.
- Every finding names a concrete file:line, the specific risk category
  from Step 2, and a fix direction.
- No source file was modified by this review.
- Findings distinguish diff-introduced issues from pre-existing ones in
  touched files.
