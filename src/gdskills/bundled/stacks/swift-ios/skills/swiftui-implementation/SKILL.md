---
name: swiftui-implementation
description: "Use when implementing or extending a feature in a SwiftUI/iOS app -- state ownership (@State/@Binding/@Environment/@Observable), Swift concurrency (async/await, actors, @MainActor, TaskGroup, Sendable), and view composition."
triggers:
  - "implement this feature in SwiftUI"
  - "add a new screen to this iOS app"
  - "wire up state for this SwiftUI view"
  - "add an async network call from this view"
  - "make this model observable in SwiftUI"
  - "extend this iOS feature with a new view"
  - "add a view model for this SwiftUI screen"
metadata:
  origin: authored
  category: implement
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# SwiftUI/iOS implementation

Implement or extend a feature in a SwiftUI/iOS codebase: state ownership,
Swift concurrency structuring, and view composition. Scoped to
Swift/SwiftUI specifically — `rules/coding-style.mdc`, `rules/patterns.mdc`,
and `rules/security.mdc` carry the full stack-specific rule set this
skill's checklist is built from; read them before writing code, not just
this summary.

## Workflow

### Step 1: Discover the project's own conventions

1. Find the deployment target (the Xcode project's iOS Deployment
   Target, or a Swift Package's platform requirement) — it decides
   whether `@Observable` (iOS 17+) is available or the project is still
   on `ObservableObject`/`@Published`.
2. Read 1-2 neighboring views/view models for: how state is currently
   owned (`@State` + `@Observable`, or `@StateObject` + `ObservableObject`),
   how dependencies are injected (`@Environment`, initializer injection),
   and whether the project already defines protocol boundaries for
   networking/persistence.
3. Check whether the project has adopted the Swift 6 language mode
   (`swift-tools-version: 6.0` in `Package.swift`, or the Xcode build
   setting) — this decides how strictly `Sendable`/actor-isolation
   errors are enforced at compile time versus only warned about.

### Step 2: Design before writing

- For each new piece of state, decide ownership before writing the
  view: does this view create and own it (`@State`), does a parent own
  it and this view only needs to mutate it (`@Binding`), or is it
  ambient to a subtree (`@Environment`)? Match the deployment target's
  supported pattern (`@Observable`/`@State` on iOS 17+,
  `ObservableObject`/`@StateObject` on an older target).
- For anything asynchronous (a network call, a database read), decide
  where it runs and how it is isolated: `@MainActor` for anything
  touching view state directly, `async`/`await` through a protocol-typed
  dependency, and how the call's `Task` is scoped (tied to a view's
  `.task` modifier when it should cancel with the view, or owned by a
  longer-lived object when it should outlive one screen).
- Sketch the protocol boundary for any new external dependency
  (network client, persistence) even if only one concrete
  implementation exists yet — it is what `swift-testing` mocks against
  later.

### Step 3: Implement

1. Model new state per `rules/patterns.mdc`'s state-ownership rules —
   `@State` for view-owned, `@Binding` for child-mutates-parent,
   `@Environment` for ambient/shared, `@Bindable` when a child needs
   bindings into an `@Observable` model it does not own.
2. Mark any `@Observable` class (or other UI-touching mutable type)
   `@MainActor`; thread `async`/`await` through the call chain instead
   of nesting completion handlers.
3. Use `guard let`/`guard` for early exits on optionals; never force-
   unwrap (`!`) or force-try (`try!`) a network response, decoded value,
   or anything else that is not a guaranteed-safe programmer invariant.
4. Keep a closure STORED past its creating call (a completion handler
   held as a property, a Combine `sink` kept in a `Set<AnyCancellable>`)
   from retaining `self` strongly when that would create a genuine
   retain cycle — capture `[weak self]` and unwrap. A `Task {}` closure
   is different: it runs once and releases its captures when it
   finishes, so it does not create a persistent cycle the way a stored
   closure does; still prefer `[weak self]` there when the task can
   outlive something short-lived (the view/screen it was launched from)
   and would otherwise keep it alive for no reason while it runs.
5. Format with the project's configured formatter as you go.

### Step 4: Verify

```bash
xcodebuild build -scheme <Scheme> -destination 'platform=iOS Simulator,name=<Simulator>'
# or, for a Swift package:
swift build
```

Run the project's configured linter (`swiftlint`) if present. A
build/strict-concurrency failure at this step is a signal to fix the
implementation, not to reach for `swift-build-fix`'s scope unless the
failure is purely a build/module/dependency problem unrelated to the
feature logic.

### Step 5: Report

```
Implemented: Features/Order/OrderDetailView.swift, Features/Order/OrderDetailModel.swift
  - New @Observable OrderDetailModel (@MainActor), owned via @State in OrderDetailView
  - Async fetch through OrderClient protocol, awaited from a .task modifier
  - xcodebuild build succeeds, swiftlint clean
```

## Rules

- Never force-unwrap (`!`) or force-try (`try!`) a value that can
  genuinely be nil or throw at runtime (network data, decoded JSON, user
  input) — `guard let`/`if let`/`try`/`try?` instead.
- Never introduce `ObservableObject`/`@Published`/`@StateObject` in new
  code on a project whose deployment target already supports
  `@Observable` (iOS 17+) — match the modern pattern unless the project
  has an explicit reason not to have migrated yet.
- Never mark a type `@unchecked Sendable` to silence a strict-
  concurrency diagnostic without actually auditing and documenting why
  its mutable state is safe.
- Never store `context`-like ambient dependencies as an implicit
  singleton reach-through when `@Environment` or explicit injection
  already expresses the same dependency clearly.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll force-unwrap this decoded response, the API always returns this field" | "Always" is a claim about a system you do not control; a malformed or versioned-differently response crashes the app instead of failing gracefully |
| "I'll mark this class `@unchecked Sendable` so the concurrency checker stops complaining" | Trades a compile-time data-race guarantee for an unchecked promise — audit the actual mutable state and isolate it properly, or make the type genuinely immutable |
| "This view creates the view model, so `@StateObject` is fine even though we target iOS 17+" | `@Observable` + `@State` is the current default for exactly this ownership shape on iOS 17+; reaching for the legacy pattern in new code adds an inconsistency with no benefit |
| "The completion handler captures `self` strongly, but it always fires quickly" | A retain cycle does not care how quickly the closure fires — if the closure is stored or can outlive the call, an unweakened `self` capture leaks |

## Verification

Do not report the work done until all of the following hold:

- The build succeeds (`xcodebuild build`/`swift build`) with no new
  strict-concurrency warnings introduced by this change.
- Every new piece of view state has a deliberate ownership choice
  (`@State`/`@Binding`/`@Environment`/`@Observable`) matching
  `rules/patterns.mdc`, not a default reached for out of habit.
- No new force-unwrap (`!`) or force-try (`try!`) was added on a value
  that can genuinely be nil or throw.
- Any new closure that outlives its creating call captures `self`
  weakly where a retain cycle is possible.
