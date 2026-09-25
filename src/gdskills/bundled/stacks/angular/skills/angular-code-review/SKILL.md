---
name: angular-code-review
description: "Use when reviewing an Angular component/service/directive diff for framework-specific correctness -- untracked RxJS subscriptions missing takeUntilDestroyed/async-pipe cleanup, OnPush components mutating input objects in place instead of replacing the reference, a dependency-injection call made outside a valid injector context, DomSanitizer bypassSecurityTrust* calls on user-influenced data, and NgModule/standalone mixing. Does not review generic JavaScript/TypeScript correctness the base stack reviewer already covers, does not review MobX store logic, and never edits code -- it reports findings only. Not for implementing or fixing the reviewed code (use angular-implementation or angular-build-fix)."
triggers:
  - "review this Angular component diff for RxJS subscription leaks"
  - "check this Angular PR for OnPush change detection mistakes"
  - "review this Angular service for DomSanitizer bypass usage"
  - "audit this Angular component for inject() misuse"
  - "review this standalone Angular component for signal anti-patterns"
  - "check this Angular diff before merging"
metadata:
  origin: authored
  category: review
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Angular code review

Review an Angular component/service/directive/pipe diff for
framework-specific correctness issues. This skill only reports findings —
it never edits the reviewed code. See `rules/patterns.mdc` and
`rules/security.mdc` for the full rule set this review draws its checks
from.

## Scope

Covers Angular-specific concerns: change detection, signals, dependency
injection, RxJS lifecycle, and template sanitization. It does not repeat
generic TypeScript/Node review (unused variables, general async
correctness) already covered by the base `ts-js-node` reviewers, and it
does not review NestJS backend structure or MobX store logic — those have
their own reviewers.

## Workflow

### Step 1: Read the diff in full before forming an opinion

Read every changed file, not just the hunk markers — a subscription's
teardown, or the component's `changeDetection` setting, is often declared
outside the changed lines.

### Step 2: Check each category against `rules/patterns.mdc` and `rules/security.mdc`

- **RxJS lifecycle**: every `.subscribe()` added has a teardown path —
  `takeUntilDestroyed()`, the `async` pipe, or an explicit `ngOnDestroy`
  unsubscribe. Flag any subscription with none.
- **Change detection**: an `OnPush` component whose template depends on a
  value that's mutated in place (a pushed array element, a mutated object
  property) rather than replaced with a new reference/signal update — that
  mutation won't trigger a re-check under `OnPush`.
- **Dependency injection**: `inject()` called anywhere outside a
  constructor/field initializer (inside a callback, a `setTimeout`, a
  plain method body without `runInInjectionContext`) — that throws at
  runtime, not compile time, so it's easy to miss without reading the call
  site.
- **Sanitization**: any `DomSanitizer.bypassSecurityTrust*` call — verify
  the value it wraps is genuinely static/developer-authored, not traceable
  to user input or an external API response; flag any that isn't
  obviously safe.
- **Standalone/NgModule consistency**: a new `NgModule`-declared
  component/directive/pipe added to a codebase that is otherwise
  standalone (or vice versa) without a stated reason.
- **Signals**: a `computed()` whose callback has a side effect (an HTTP
  call, a write to another signal) instead of staying pure.

### Step 3: Report findings

For each finding: file:line, what's wrong, why it matters (cite the
specific mechanism — e.g. "OnPush won't re-check on this mutation"), and
the concrete fix (not just "consider using X"). Group by severity: a
missing subscription teardown or a `bypassSecurityTrust*` on
user-influenced data is higher severity than a stylistic
`*ngIf`/`@if` inconsistency.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "The subscription probably gets garbage collected eventually, not worth flagging" | An Observable subscription holds a live reference until explicitly unsubscribed; it does not get cleaned up by GC just because the component view is gone |
| "This `bypassSecurityTrustHtml` call is fine, the string just looks like static markup" | If the string is built from or includes any user-influenced or API-sourced value, "looks static" isn't a security argument — trace where the value actually comes from before clearing it |
| "The mutation is inside an OnPush component but it 'usually still updates', so I won't flag it" | An in-place mutation not tracked by `OnPush` is a timing bug waiting to surface under different data/timing, not a hypothetical — flag it even if the current test data happens to trigger a coincidental re-check elsewhere |
| "I'll just fix the missing takeUntilDestroyed while I'm reviewing, it's a one-line change" | This skill reports findings only; even an obvious one-line fix goes in the report for the author (or angular-implementation) to apply, not applied directly during review |

## Verification

Before finishing the review, confirm:

- Every changed file with a `.subscribe()` call was checked for a
  teardown path.
- Every `OnPush` component's template dependencies were checked for
  in-place mutation.
- Every `inject()` call site was checked for being inside a valid
  injection context.
- Every `bypassSecurityTrust*` call was checked against where its
  argument value actually originates.
- No code was edited — the output is a findings report only.
