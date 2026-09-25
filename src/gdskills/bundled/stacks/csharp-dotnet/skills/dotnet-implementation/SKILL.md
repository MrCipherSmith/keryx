---
name: dotnet-implementation
description: "Use when implementing or extending a feature in a C#/.NET service or library -- DI registration and lifetimes, async/await (Task vs ValueTask, avoiding async void), nullable reference type annotations, records vs classes, EF Core query shape, and IDisposable/IAsyncDisposable cleanup."
triggers:
  - "implement this feature in C#"
  - "add a new endpoint to this ASP.NET Core service"
  - "register this service in the DI container"
  - "design this async method's Task/ValueTask return type"
  - "add nullable annotations to this new public API"
  - "implement this as a record instead of a class"
  - "write an EF Core query for this feature"
metadata:
  origin: authored
  category: implement
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# .NET implementation

Implement or extend a feature in a C#/.NET codebase: type design (record
vs class, primary constructors), nullable reference types, async/await
shape, dependency injection lifetimes, and EF Core query design. Scoped
to C#/.NET specifically — `rules/coding-style.mdc`, `rules/patterns.mdc`,
and `rules/security.mdc` carry the full stack-specific rule set this
skill's checklist is built from; read them before writing code, not just
this summary.

## Workflow

### Step 1: Discover the project's own conventions

1. Read the `.csproj`/`Directory.Build.props` for the target framework
   (`<TargetFramework>`) and whether `<Nullable>enable</Nullable>` and
   `<ImplicitUsings>enable</ImplicitUsings>` are already set — do not use
   a language feature the project's target framework does not support.
2. Find the existing layout: where DI registration happens
   (`Program.cs`, a `ServiceCollectionExtensions` class), where
   interfaces live relative to their implementations, and whether the
   project already uses records for DTOs/commands or sticks to classes.
3. Read 1-2 neighboring files in the area you are touching for: async
   patterns already in use (`ConfigureAwait` usage, `Task` vs
   `ValueTask`), the data-access approach (EF Core, Dapper, a repository
   abstraction), and the existing test project's naming so your new code
   stays testable the same way.

### Step 2: Design before writing

- Decide record vs class per `rules/coding-style.mdc`: identity-by-value
  (DTOs, commands, events) is a `record`; identity-by-reference or
  mutable-over-time state is a `class`.
- Trace nullability: which parameters/returns can genuinely be absent
  (`?`), and which public members are promising callers a non-null
  value. Do not leave a public API unannotated "for now."
- For any async method, decide `Task` vs `Task<T>` vs `ValueTask<T>`
  (`rules/patterns.mdc`) before writing the signature, and confirm the
  method is never `async void` unless it is a genuine event handler.
- For any new service registered in DI, pick its lifetime
  (Singleton/Scoped/Transient) based on what state it holds and what it
  depends on — check whether it will end up depending on something
  `Scoped` (like a `DbContext`) before defaulting to `Singleton`.

### Step 3: Implement

1. Use a primary constructor for simple dependency-assignment
   constructors; keep an explicit constructor body once real validation
   or setup logic is needed.
2. Apply `ArgumentNullException.ThrowIfNull(value)` at public entry
   points for required reference-typed parameters.
3. Thread `CancellationToken` through async methods that call into I/O
   (HTTP, database, file) so callers can cancel; accept it as the last
   parameter, often with a default of `default`.
4. Wrap every `IDisposable`/`IAsyncDisposable` local or field in
   `using`/`await using`, or have the owning type implement
   `IDisposable`/`IAsyncDisposable` itself (`rules/patterns.mdc`).
5. For EF Core, keep filtering/projection in the `IQueryable<T>` chain
   (`.Where`, `.Select`) so it translates to SQL, and materialize with
   `.ToListAsync()`/`.SingleOrDefaultAsync()` at the point results are
   actually needed, not earlier.

### Step 4: Verify

```bash
dotnet build
dotnet test
dotnet format --verify-no-changes
```

Fix findings at the root cause per `rules/security.mdc` and
`rules/coding-style.mdc`; a build/analyzer failure at this step is a
signal to fix the implementation, not to reach for `dotnet-build-fix`'s
scope unless the failure is purely a build/package/target-framework
problem unrelated to the feature logic.

### Step 5: Report

```
Implemented: src/Orders/OrderService.cs, src/Orders/IOrderRepository.cs
  - New OrderService registered Scoped, depends on IOrderRepository
  - dotnet build/test/format all pass
```

## Rules

- Never write `async void` except for a genuine UI/event-handler method.
- Never call `.Result`/`.Wait()`/`.GetAwaiter().GetResult()` on a `Task`
  from otherwise-synchronous code — make the caller `async` instead.
- Never leave a new public API's nullability unannotated; every
  parameter and return type states whether `null` is a valid value.
- Never capture a `Scoped` service (like a `DbContext`) directly into a
  `Singleton`'s field — resolve it per-use via `IServiceScopeFactory`.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll make this handler `async void`, it's just a quick fire-and-forget call" | Only a real event handler gets `async void`; anywhere else, an exception it throws cannot be awaited or caught and crashes the process instead |
| "I'll just call `.Result` here, this one path isn't really async anyway" | Blocking on a `Task` from sync code is sync-over-async and can deadlock the moment the awaited call needs to resume on a context the blocking thread occupies |
| "Nullable warnings are noisy, I'll add `<Nullable>disable</Nullable>` to this file" | Turns off the compiler's null-safety net for the whole file instead of fixing the actual null path the warning is pointing at |
| "I'll inject this Scoped DbContext straight into my Singleton cache service" | Captures the first request's `DbContext` instance for the app's whole lifetime; resolve it per-use through `IServiceScopeFactory` instead |

## Verification

Do not report the work done until all of the following hold:

- `dotnet build`, `dotnet test`, and `dotnet format --verify-no-changes`
  all exit 0.
- Every new async method is `Task`/`Task<T>`/`ValueTask<T>`-returning,
  never `async void`, unless it is a genuine event handler.
- Every new public parameter/return type has an explicit nullability
  annotation matching its actual contract.
- Every new `IDisposable`/`IAsyncDisposable` local, field, or owning
  type is wrapped in `using`/`await using` or disposes it correctly.
