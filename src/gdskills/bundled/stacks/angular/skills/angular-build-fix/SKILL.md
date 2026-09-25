---
name: angular-build-fix
description: "Use when resolving an `ng build` failure, an AOT/Ivy template type-checking error (a property that doesn't exist on the bound type, an @if/@for control-flow type mismatch), a missing NgModule declaration/import error, or a NullInjectorError/'No provider for X' DI resolution error surfacing when the built app bootstraps. Applies the smallest root-cause fix and never silences the compiler with strictTemplates: false, an `any` cast in a template context, or `@Injectable` removal. Not for a plain TypeScript compile failure outside any Angular template, and not for authoring a fresh component or injectable from scratch (use angular-implementation)."
triggers:
  - "fix this ng build AOT template type error"
  - "resolve this Angular No provider for X DI error"
  - "fix this Angular NG8103/missing NgModule declaration error"
  - "ng build reports a template type-checking failure"
  - "fix this standalone Angular component import error"
  - "Angular build fails after adding an @if block referencing a signal"
metadata:
  origin: authored
  category: build-fix
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Angular build-fix (ng build / AOT / DI resolution)

Resolve an `ng build` failure: an AOT/Ivy template type-checking error, a
missing NgModule declaration/import, or a dependency-injection "No
provider for X" resolution error. Applies the smallest change that fixes
the actual root cause — never a change that only makes the compiler stop
complaining. See `rules/coding-style.mdc` and `rules/patterns.mdc` for the
typing/DI conventions a correct fix should restore.

## Workflow

### Step 1: Reproduce the failure

```bash
ng build
```

Run the project's own `package.json` build script if it wraps `ng build`
with extra flags (configuration, budgets). Capture the exact error
message, the file:line, and — for a template error — the template
expression Angular is complaining about, not just the `.ts` file it's
attributed to.

### Step 2: Classify the failure

- **Template type-checking error** (AOT/Ivy `strictTemplates`): a bound
  property/method that doesn't exist on the component's type, an
  `@if`/`@for` expression whose narrowed type doesn't match what the
  template body assumes, or a mismatched event handler signature.
- **Missing declaration/import error** (e.g. `NG8001`/`NG8103`-style
  "is not a known element" or "can't bind to X since it isn't a known
  property"): a component/directive/pipe used in a template but not
  imported into the standalone component's `imports` array (or not
  declared/exported by the right `NgModule` in an NgModule-based project).
- **DI resolution error** ("No provider for X", `NullInjectorError`): a
  service injected (via `inject()` or constructor) with no reachable
  provider — missing `providedIn: 'root'`, missing from a component's/
  route's `providers` array, or injected outside any injector context.
- **Build-tool/config error**: a genuine `angular.json`/`tsconfig.json`
  misconfiguration (a wrong path, a missing budget) rather than a code
  issue.

### Step 3: Find the root cause

**Template type errors**: trace the bound expression back to the
component class member it reads — the type Angular is checking against is
the actual declared type of that signal/field/getter, not a guess. A
template type error is usually telling the truth about a real mismatch
between the template and the class.

**Missing declaration/import**: check whether the component/directive/pipe
is standalone (needs adding to the consuming component's `imports`) or
NgModule-declared (needs adding to that module's `declarations`/`exports`,
and the consuming module needs to import it) — the fix differs by which
kind it is; check the component's own `@Component` decorator to tell.

**DI resolution**: find where the service is (or should be) provided —
check its own `@Injectable({ providedIn: ... })`, and any `providers`
array on the component/route/module in the injection path. A "No provider
for X" error means the injector tree that resolved this component/service
has no matching provider anywhere above it, not that the class itself is
broken.

### Step 4: Apply the smallest correct fix

- A template type error: fix the actual mismatch — correct the class
  member's type, or correct the template expression reading it — not a
  cast to `any` inside the template or a `$any()` template escape hatch
  used to silence the checker.
- A missing declaration/import: add the component/directive/pipe to the
  correct `imports` (standalone) or `declarations`/`exports`
  (NgModule) — not a blanket `CUSTOM_ELEMENTS_SCHEMA`/`NO_ERRORS_SCHEMA`
  addition that suppresses unknown-element checking project-wide.
- A DI resolution error: add the missing `providedIn`/`providers` entry at
  the correct scope — not a workaround that constructs the service with
  `new` instead of injecting it, which breaks DI's own singleton/testing
  benefits.
- A config error: fix the actual `angular.json`/`tsconfig.json` setting
  that's wrong — call out explicitly in the report that a config file
  changed and why.

### Step 5: Verify and report

Re-run `ng build` (the exact command from Step 1); confirm it now exits 0.
Report the root cause and the fix, not just "build passes now".

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll wrap the template expression in `$any(...)` to stop the type error" | `$any()` disables type checking for that expression entirely — it hides the real mismatch instead of fixing the class member or the template expression reading it |
| "I'll set `strictTemplates: false` in tsconfig, then this whole class of error goes away" | That silences template type checking project-wide for every component, not just the one with the error — a genuine project-wide policy change, not a fix for this build failure |
| "I'll add `NO_ERRORS_SCHEMA` to fix this unknown-element error" | That tells Angular to stop validating unknown elements/attributes anywhere in that module, masking every future typo the same way, not just resolving this one missing import |
| "No provider for X — I'll just `new X()` instead of injecting it" | That bypasses Angular's DI entirely (no testability via TestBed overrides, no respecting the service's actual provider scope); find and fix the missing provider instead |

## Verification

Do not report the fix done until all of the following hold:

- The exact command that reproduced the failure in Step 1 (`ng build` or
  the project's wrapping script) now exits 0.
- No `$any()`, template `any` cast, `NO_ERRORS_SCHEMA`/
  `CUSTOM_ELEMENTS_SCHEMA` addition, or `strictTemplates`/`fullTemplateTypeCheck`
  downgrade was added to silence the error.
- No dependency was constructed with `new` in place of a fixed DI
  provider.
- The report states the actual root cause, not just "build passes now".
- `git status` shows changes confined to the files the root cause
  required.
