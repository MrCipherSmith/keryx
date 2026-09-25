---
name: nestjs-build-fix
description: "Use when a NestJS app itself won't boot because of its own dependency graph: `Nest can't resolve dependencies` / UnknownDependenciesException, a circular-dependency warning naming @Module()-decorated NestJS modules or @Injectable() providers requiring each other directly, a missing @Injectable() decorator, or a provider that isn't exported from the module owning it. Applies the smallest root-cause fix to the module/provider graph and never widens scope or blindly registers another module to silence the startup failure. Excludes a TypeScript compiler mismatch or module-loader failure with no Nest dependency-injection angle at all (use the ts-js-node build-fix skill), and excludes authoring behavior in a module that already boots cleanly (use nestjs-implementation)."
triggers:
  - "Nest can't resolve dependencies of this provider"
  - "fix this NestJS UnknownDependenciesException"
  - "circular dependency warning naming these NestJS @Module()-decorated modules"
  - "NestJS app won't bootstrap, dependency injection error"
  - "this provider isn't found, NestJS DI error"
  - "NestJS app throws at startup over its own module graph"
metadata:
  origin: authored
  category: build-fix
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# NestJS build-fix (DI resolution / circular dependency / bootstrap errors)

Resolve a NestJS-specific compile or startup failure in the module/provider
dependency graph -- not a generic `tsc` type error (see the `ts-js-node`
build-fix skill for that). Applies the smallest change that fixes the
actual root cause in the module graph. See `rules/patterns.mdc` for the
module/provider design a correct fix should restore.

## Workflow

### Step 1: Reproduce the failure

```bash
npx tsc --noEmit
nest build
npm run start:dev
```

Run the project's own `package.json` build/start scripts if they differ.
Most Nest DI errors only surface at **application bootstrap**, not at
`tsc` type-check time -- `tsc --noEmit` can pass while the app still fails
to start with an `UnknownDependenciesException`. Capture the exact error
message: it names the provider that could not be resolved and, often, the
module Nest was trying to resolve it inside.

### Step 2: Classify the failure

- **`UnknownDependenciesException` / "Nest can't resolve dependencies of
  X"**: a provider's constructor asks for a dependency Nest cannot find in
  the current module's own providers or its imported modules' exports.
- **Circular dependency warning**: two modules (or two providers) depend on
  each other, forming a cycle Nest cannot resolve without `forwardRef()`.
- **Missing `@Injectable()`**: a class used as a provider or injected as a
  dependency has no `@Injectable()` decorator, so Nest cannot construct it
  through DI at all -- a different failure shape from the two above, often
  reported as the same "can't resolve dependencies" message.
- **Bootstrap failure with no clear provider name**: often a lifecycle hook
  (`OnModuleInit`) throwing during app startup, not a DI graph problem at
  all -- check the actual thrown error before assuming it's a wiring issue.

### Step 3: Find the root cause

**Unknown dependency**: read the exact index Nest reports (it names which
constructor argument position failed) and trace that dependency back to its
own `@Injectable()`/provider declaration. Check three things in order: (1)
is the dependency listed in the current module's `providers`? (2) if it
lives in another module, is that module in the current module's `imports`,
**and** does that other module `export` the provider? (3) is the injected
class itself decorated with `@Injectable()`?

**Circular dependency**: identify the two modules or providers that
reference each other. Confirm it is a genuine mutual need, not an
accidental import that could instead go one direction -- see
`rules/patterns.mdc` on treating `forwardRef()` as a signal to reconsider
the boundary first.

**Missing `@Injectable()`**: check the class definition directly; a class
with no decorator that is still listed in `providers` or injected
elsewhere is the exact shape of this failure.

### Step 4: Apply the smallest correct fix

- Missing export: add the provider to the owning module's `exports` array
  -- do not instead re-declare the same provider in the consuming module's
  own `providers` array, which creates two separate instances of what
  should be one shared provider.
- Missing import: add the owning module to the consuming module's
  `imports` array -- only after confirming the provider is actually
  exported from it (step 3); adding the import alone does not fix a
  missing export.
- Genuine circular dependency: apply `forwardRef()` on **both** sides of
  the reference (the module-level `imports: [forwardRef(() => OtherModule)]`
  and, if it's providers rather than modules, the constructor parameter's
  `@Inject(forwardRef(() => OtherService))`) -- one-sided `forwardRef()`
  does not resolve a genuine cycle.
- Missing `@Injectable()`: add the decorator to the class.
- A lifecycle-hook throw: fix the actual condition it's failing on (e.g. a
  config value that's genuinely missing), not by swallowing the exception
  inside the hook.

### Step 5: Verify and report

Re-run the exact command from Step 1 (the app must actually boot, not just
type-check) and confirm no DI/circular-dependency warning appears in the
startup log. Report the root cause and the fix, not just "resolved".

```
Fixed: src/orders/orders.module.ts
  Root cause: OrdersService injects PricingService, but PricingModule
  never exported PricingService -- it was only declared in PricingModule's
  own `providers` array.
  Fix: added PricingService to PricingModule's `exports` array.
  Verified: npm run start:dev boots with no UnknownDependenciesException.
```

## Rules

- Follow `rules/patterns.mdc` for the module/provider design a fix should
  restore, not just silence.
- ALWAYS fix the actual module-graph gap (missing export/import/decorator,
  or a genuine `forwardRef()` cycle) -- never widen the fix beyond the
  module(s) the failure actually touches.
- NEVER change a provider's scope (e.g. to `Scope.DEFAULT`) just to make a
  resolution error disappear without confirming the provider doesn't
  genuinely need request-scoped state.
- NEVER add a module to another module's `imports` purely to silence an
  `UnknownDependenciesException` without first confirming that module
  actually `export`s the provider being injected -- an import with no
  matching export does not fix the error and just adds noise to the graph.
- NEVER re-declare the same provider in a second module's own `providers`
  array as a workaround for a missing `exports` entry -- that creates two
  separate instances of what the codebase intends to be one shared
  provider.
- NEVER delete or skip a failing test to reach a green build.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll just add PricingModule to imports, that usually fixes these" | Without confirming PricingModule actually exports PricingService, the import alone does nothing -- verify the export exists before adding the import |
| "I'll re-declare PricingService in this module's own providers instead of fixing the export" | Creates a second, separate instance of the provider instead of sharing the one PricingModule owns -- state and side effects diverge silently |
| "I'll wrap just the failing side in forwardRef() and leave the other side as a normal import" | A genuine cycle needs forwardRef() on both sides; a one-sided fix still resolves in the wrong order and fails the same way |
| "This OnModuleInit hook throws, I'll wrap it in try/catch and swallow the error" | Bootstrap fails for a reason -- swallowing it lets the app start in a broken state instead of surfacing what's actually missing (e.g. a required config value) |

## Verification

Do not report the fix done until all of the following hold:

- The app actually boots (`npm run start:dev` or the project's equivalent)
  with no DI resolution error or circular-dependency warning, not just
  that `tsc --noEmit` exits 0.
- No provider's scope was changed, and no module/provider was duplicated,
  as a workaround.
- Every `forwardRef()` added for a genuine cycle appears on both sides of
  the reference.
- The report states the actual root cause (missing export, missing
  decorator, genuine cycle) and the fix, not just "DI error fixed".
- `git status` shows changes confined to the module(s)/provider(s) the
  root cause required.
