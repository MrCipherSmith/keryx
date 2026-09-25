---
name: flutter-implementation
description: "Use when implementing or extending a feature in a Flutter app -- widget composition, state-management-agnostic lifecycle correctness, guarding BuildContext/setState across an async gap, and sound-null-safety idiom."
triggers:
  - "add this screen to the Flutter app"
  - "implement this widget with the app's existing state management"
  - "wire up this Flutter feature to call the repository"
  - "add a form to this Flutter screen with validation"
  - "extend this Flutter widget to show a loading and error state"
  - "build this Flutter list screen backed by a Future"
  - "add navigation from this screen to a detail screen"
metadata:
  origin: authored
  category: implement
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Flutter/Dart implementation

Implement or extend a feature in a Flutter app: widget composition,
lifecycle-correct state handling regardless of which state-management
approach the project uses, safe `BuildContext`/`setState` use across async
gaps, and sound-null-safety idiom. Scoped to Flutter/Dart specifically —
`rules/coding-style.mdc`, `rules/patterns.mdc`, and `rules/security.mdc`
carry the full stack-specific rule set this skill's checklist is drawn
from; read them before writing code, not just this summary.

## Workflow

### Step 1: Discover the project's own conventions

1. Read `pubspec.yaml` for the Dart/Flutter SDK constraint and which
   state-management package (if any) is already a dependency —
   `flutter_riverpod`/`riverpod`, `provider`, `flutter_bloc`, or none
   (plain `StatefulWidget`). Match whichever is already there; do not
   introduce a second state-management approach for one feature.
2. Find the existing `lib/` layout (feature folders, a `widgets/`/
   `screens/` split, a repository/service layer) and match it rather than
   inventing a different structure for this change.
3. Read 1-2 neighboring widgets/screens for: how they source data (a
   repository interface, a provider, direct API calls), how they handle
   loading/error/empty states, and whether `flutter_secure_storage` is
   already used for anything sensitive this feature touches.

### Step 2: Design before writing

- Decide what is a `StatelessWidget` (pure function of its constructor
  arguments) versus a `StatefulWidget` (owns mutable state, animation
  controllers, subscriptions, or text/scroll controllers) — do not reach
  for `StatefulWidget` when the state actually belongs in the project's
  state-management layer instead.
- Trace every `await` that follows with a use of `context` or a call to
  `setState()`: plan the `context.mounted`/`mounted` check at each of
  those points before writing the call that needs it.
- Decide what data comes from a `Future` (fetch once, render loading →
  data/error) versus a `Stream` (updates over time) and which widget
  (`FutureBuilder`/`StreamBuilder`, or the project's state-management
  async helper) will drive the corresponding UI states.

### Step 3: Implement

1. Compose small widgets (`rules/coding-style.mdc`); mark every
   constructor `const` where its fields allow it, including at call
   sites.
2. Wire `initState`/`dispose` symmetrically for anything a `State`
   acquires — a `TextEditingController`, `AnimationController`,
   `StreamSubscription`, or `FocusNode` created in `initState()` gets
   released in `dispose()`.
3. After every `await` inside a `State` method or a callback holding a
   `BuildContext`, check `mounted`/`context.mounted` before the next use
   of `setState()`/`context` — do this immediately after the `await`, not
   wrapped in a broad `try`/`catch`.
4. Prefer `?.`/`??` over `!`; only use `!` where non-nullability is
   locally guaranteed and unaffected by any intervening `await`.
5. Store any credential/token this feature introduces via
   `flutter_secure_storage`, never `shared_preferences`
   (`rules/security.mdc`).
6. Format with `dart format` as you go, not as an afterthought.

### Step 4: Verify

```bash
flutter analyze
dart format --set-exit-if-changed .
flutter test
```

Run `flutter build <platform> --debug` (or the project's actual CI build
target) when the change could plausibly affect build output, not routinely
for every small change. Fix findings at the root cause per
`rules/coding-style.mdc`/`rules/patterns.mdc`; an `analyze`/build failure
here is a signal to fix the implementation, not to reach for
`flutter-build-fix`'s scope unless the failure is purely a
build/dependency/import problem unrelated to the feature logic.

### Step 5: Report

```
Implemented: lib/order/order_screen.dart, lib/order/order_controller.dart
  - New OrderScreen widget consuming OrderController (matches the
    project's existing Riverpod usage)
  - context.mounted checked after the two awaited repository calls
  - flutter analyze / dart format / flutter test all pass
```

## Rules

- Never use a `BuildContext` or call `setState()` after an `await` without
  checking `context.mounted`/`mounted` first.
- Never leave a `TextEditingController`/`AnimationController`/
  `StreamSubscription`/`FocusNode` undisposed when the `State` that
  created it is disposed.
- Never reach for the bang operator (`!`) to silence a null-safety warning
  without first confirming, and ideally guarding, that the value is
  actually non-null at that point.
- Match the project's existing state-management approach; do not
  introduce a second one alongside it for a single feature.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "The Future usually resolves fast, I don't need a mounted check" | "Usually" is not a guarantee; a user can navigate away or the widget can be disposed for any reason while the await is pending, and the resulting `setState`/context use throws or targets a stale context |
| "I'll add `!` here since the analyzer is complaining and this will probably not be null" | The analyzer is flagging a real gap it cannot resolve statically; guard with a null check or `?.`/`??` instead of asserting past it |
| "This TextEditingController only lives for one screen, disposal doesn't matter much" | Every controller not disposed keeps its underlying platform resources alive for the app's lifetime, not just the screen's; dispose it in `dispose()` regardless of how short-lived the screen feels |
| "I'll just use setState here since Riverpod/Bloc feels like overkill for this one flag" | Introducing a second state-management approach alongside the project's chosen one fragments where state lives and complicates every future feature that needs to read it |

## Verification

Do not report the work done until all of the following hold:

- `flutter analyze` and `dart format --set-exit-if-changed .` both exit 0.
- `flutter test` passes for any tests the change touches.
- Every `BuildContext` use and `setState()` call that follows an `await`
  is preceded by a `context.mounted`/`mounted` check.
- Every controller/subscription/listener created in `initState()` (or
  later) is released in `dispose()`.
