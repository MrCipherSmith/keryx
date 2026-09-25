---
name: angular-implementation
description: "Use when implementing a new Angular component, service, directive, or pipe -- standalone component structure, signal-based (signal()/computed()/effect()) state, inject()-based dependency injection, and typed Reactive Forms. Wires RxJS-to-signal interop (toSignal/takeUntilDestroyed) correctly and follows the project's own routing conventions. Not for Vue/React component implementation, not for writing unit specs for an Angular component (use angular-testing), and not for repairing an already-failing Angular compiler error (use angular-build-fix)."
triggers:
  - "create a new standalone Angular component for"
  - "add an Angular service with inject()"
  - "implement this feature using Angular signals"
  - "build a typed reactive form in Angular for"
  - "wire up a new Angular component using inject() and signal state"
  - "add an Angular route guard for"
  - "convert this to a standalone Angular component"
metadata:
  origin: authored
  category: implement
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Angular implementation

Implement a new Angular component, service, directive, or pipe using
current Angular idiom: standalone by default, signal-based state,
`inject()` for dependency injection, and `OnPush` change detection. See
`rules/coding-style.mdc` for naming/typing conventions and
`rules/patterns.mdc` for the change-detection and RxJS-interop patterns a
correct implementation should follow.

## Workflow

### Step 1: Discover the project's own conventions

Before writing a new component/service, check:

- `angular.json` for the project's Angular version, builder, and whether
  strict template type checking (`strictTemplates`) is on.
- A handful of existing components for: standalone vs. NgModule-based,
  `*ngIf`/`*ngFor` vs. `@if`/`@for`, `inject()` vs. constructor injection,
  signal inputs (`input()`) vs. `@Input()` decorators, and the file-suffix
  convention (`.component.ts` vs. plain `.ts`).
- Whether the project uses a state-management library (NgRx, a signal
  store) beyond plain component/service signals — match it rather than
  introducing a second, competing pattern.

Match the project's existing convention even where it differs from the
newest Angular idiom described below, unless the task explicitly asks for
a migration.

### Step 2: Scaffold with the Angular CLI when available

Prefer `ng generate component <name>` / `ng generate service <name>` (or
the project's own schematics/collection) over hand-writing boilerplate —
it wires the file into `angular.json`'s conventions and produces a
standalone component by default on current Angular. Adjust the generated
file to match the task, don't leave placeholder content.

### Step 3: Design the component/service

- **State**: model changing state with `signal()`; derive values with
  `computed()`; use `input()`/`model()` for component inputs (typed
  explicitly), `output()` for events. Keep `computed()` pure — no HTTP
  calls or writes to other signals inside it (`rules/patterns.mdc`).
- **DI**: use `inject()` at the field-initializer/constructor level for
  every dependency, consistently within the class (`rules/coding-style.mdc`).
- **Change detection**: set `changeDetection: ChangeDetectionStrategy.OnPush`
  on new components; with signal-based state this needs no extra wiring —
  reading a signal in the template registers the dependency automatically.
- **RxJS boundaries**: when a dependency (HTTP, router events, a form's
  `valueChanges`) is naturally an `Observable`, convert once with
  `toSignal()` for template/computed use, or pipe a manual subscription
  through `takeUntilDestroyed()` — never leave a subscription with no
  teardown path.
- **Templates**: use `@if`/`@for` (with an explicit `track`)/`@switch`
  unless the surrounding file already uses structural directives
  throughout.

### Step 4: Forms (when the task involves user input)

Use typed Reactive Forms (`FormGroup<{...}>`/`FormControl<T>`) with
`ValidatorFn`s on the controls, per `rules/patterns.mdc` — not template-driven
forms or ad-hoc validation in a submit handler, unless the project's
existing forms are template-driven and the task is a small addition to one.

### Step 5: Verify

Run the project's own build/lint/test scripts (see Verification below).
Fix any new template type error or lint finding by correcting the actual
mismatch — do not loosen `strictTemplates` or add a suppression to make a
new component's own code pass.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll just use `@Input()` with a plain field, signals are extra ceremony for one input" | A codebase that has otherwise moved to signal inputs (`input()`) gets fine-grained reactivity and `OnPush` compatibility for free; mixing the two styles in the same component is the actual added ceremony |
| "I'll call `inject()` inside this `setTimeout` callback, it's simpler than passing the service through" | `inject()` only works inside an injection context; calling it later throws at runtime, not compile time -- inject the dependency in the constructor/field initializer and capture it in a closure instead |
| "I'll subscribe directly and skip `takeUntilDestroyed`, the component doesn't live long anyway" | An unbounded subscription is a real leak the moment that assumption stops holding (a modal reused, a route revisited); tear it down explicitly every time |
| "I'll leave `ChangeDetectionStrategy.Default` since OnPush might miss an update" | With signal-reads in the template, `OnPush` tracks the real dependency automatically; `Default` just means the component re-checks on every application-wide change detection pass for no benefit |

## Verification

Do not report the implementation done until all of the following hold:

- `ng build` (or the project's build script) succeeds with no new template
  type errors.
- The project's lint script (`ng lint` or its `eslint` equivalent) passes
  on the new/changed files.
- Any new signal-based input/output is explicitly typed, and any
  RxJS subscription created in the new code has an explicit teardown
  (`takeUntilDestroyed`, `async` pipe, or `toSignal()`).
- `git status` shows changes confined to the component/service the task
  asked for, plus any routing/module registration it genuinely needs.
