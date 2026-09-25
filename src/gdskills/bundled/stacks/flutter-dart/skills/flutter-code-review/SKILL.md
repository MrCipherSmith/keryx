---
name: flutter-code-review
description: "Use when reviewing a Flutter/Dart change for lifecycle and null-safety risks -- unguarded BuildContext/setState after an await, an undisposed controller/subscription, bang-operator misuse, and business logic inside build(). Read-only, no edits."
triggers:
  - "review this Flutter diff for missing mounted checks"
  - "check this Flutter change for a disposed controller"
  - "review this Dart pull request for null-safety issues"
  - "any BuildContext misuse in this Flutter change"
  - "review this Flutter widget for lifecycle bugs"
  - "check this Flutter diff for logic inside build()"
metadata:
  origin: authored
  category: review
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Flutter/Dart code review

Read-only review of a Flutter/Dart change for lifecycle and null-safety
risks specific to Flutter: unguarded `BuildContext`/`setState` after an
`await`, an undisposed controller or subscription, bang-operator misuse,
and business logic misplaced inside `build()`. This skill never edits
code — it reports findings. `rules/coding-style.mdc`, `rules/patterns.mdc`,
and `rules/security.mdc` are the rule set findings are checked against.

## Workflow

### Step 1: Scope the review

1. Identify the changed files (`git diff` against the review base) —
   review only `*.dart` files in the diff, not the whole repository.
2. Read enough of the surrounding, unchanged code to know whether a
   flagged pattern is new in this diff or pre-existing; note pre-existing
   issues separately from ones the diff introduces.

### Step 2: Check each changed widget/class against the focus list

**BuildContext and setState after an async gap**
- Every `await` inside a `State` method that is followed by `setState()`
  has a `mounted` check between the `await` and the `setState()` call —
  flag a `setState()` reached after an `await` with no intervening
  `mounted`/`context.mounted` check.
- Every `await` inside a callback holding a `BuildContext` that is
  followed by any use of that `context` (`Navigator.of(context)`,
  `ScaffoldMessenger.of(context)`, `Theme.of(context)`, a dialog) has a
  `context.mounted` check first — flag its absence.

**Lifecycle and disposal**
- Every `TextEditingController`/`AnimationController`/
  `StreamSubscription`/`FocusNode`/`ScrollController` created in
  `initState()` (or elsewhere in the `State`) has a matching release in
  `dispose()` — flag one created with no corresponding disposal.
- `dispose()` calls `super.dispose()` last, not first — flag it if the
  super call happens before the class's own cleanup.

**Null safety**
- A bang operator (`!`) used on a value whose non-null status is not
  locally evident (crossed an `await`, came from a widget/state field that
  could be null, no preceding null check in the same scope) — flag it as
  a potential `null check operator used on a null value` crash risk.
- A `late` field whose initialization path is not obviously guaranteed
  before first read — flag as a potential `LateInitializationError` risk.

**Build method hygiene**
- Network calls, parsing, or other side-effecting/expensive logic written
  directly inside a `build()` method instead of a controller/view-model —
  flag it; `build()` can run many times for reasons unrelated to data
  changing.
- A widget constructor that could be `const` (all fields final and
  const-constructible) but is not — flag as a missed `const`
  opportunity when it is on a widget likely to rebuild often (a list
  item, a child of an animated ancestor); do not flag it as a blocker for
  a one-off, rarely-rebuilt widget.

### Step 3: Report

For each finding: file:line, the pattern, why it matters (crash risk,
resource leak, stale UI), and the fix direction — but do not apply it.

```
lib/order/order_screen.dart:58 — setState() called after `await
_repository.submit(order)` with no mounted check first. Risk: throws
"setState() called after dispose()" if the user navigates away while the
submit call is in flight. Fix direction: add `if (!mounted) return;`
immediately after the await, before the setState call.
```

## Rules

- NEVER edit code — findings and fix direction only.
- Flag unguarded `BuildContext`/`setState` after an `await`, undisposed
  controllers/subscriptions, risky bang-operator use, and business logic
  inside `build()`; do not report generic style nits already covered by
  `dart format`/`flutter analyze`'s default lint set (those are noise
  here).
- Distinguish a finding the diff introduces from a pre-existing one in
  code the diff merely touches.
- When a suspected disposal gap is not certain from reading alone (a
  controller might be disposed by a base class or a mixin not shown in
  the diff), say "confirm the base class disposes this" rather than
  asserting a leak exists without evidence.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "The await usually resolves before the user can navigate away" | "Usually" is not a guarantee; flag the missing mounted/context.mounted check regardless of how unlikely the race feels |
| "This controller is only used on one screen, disposal is a minor nit" | An undisposed controller leaks its underlying platform resources for the app's lifetime, not just the screen's; it is a real finding, not a nit |
| "I'll just add the mounted check myself since it's a one-line fix" | This skill is read-only; report the finding and its fix direction, do not edit the file |
| "The bang operator is probably fine here, I won't flag it without proof it crashes" | The point of flagging is the risk, not proof of an actual crash; a `!` on a value whose non-null status is not locally evident is a finding worth raising even without a reproduced crash |

## Verification

Do not report the review done until all of the following hold:

- Every changed `*.dart` file in the diff was read, not just files named
  in the PR description.
- Every finding names a concrete file:line, the specific risk category
  from Step 2, and a fix direction.
- No source file was modified by this review.
- Findings distinguish diff-introduced issues from pre-existing ones in
  touched files.
