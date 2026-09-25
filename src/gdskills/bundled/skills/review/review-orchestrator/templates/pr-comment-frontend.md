# PR comment — frontend

Use when the scope is frontend, or when the PR is fullstack / paired with a
backend PR. A paired PR uses this template and must include the wire-contract
line.

Skeleton: `templates/review-report.md`. This file is the Verified-clean
checklist. Render a bullet only if that check was actually run.

## Verified clean — render only what was checked

React / MobX

- `observer` on every component that reads an observable.
- `runInAction` (or an action) after every `await` that writes state.
- Disposers run on unmount; an async callback checks them before writing.
- State that outlives the view lives in the store, not in `useState`.

Vantage conventions (skip a line the repository has no rule for)

- `t()` only in render, no `defaultValue`.
- Arabic plurals and FSI/PDI isolates where the catalog has them.
- `notifyError` on failure paths; no empty `catch`.
- No `as`, no `any`.
- `Storage` wrapper, not `localStorage`.
- Tailwind tokens, no inline `style` for theme values.
- Icon-only buttons have an `aria-label`.

`src/core` boundaries

- No import from a feature into core.
- A vendored surface (for example `report-blocks`) has no dependency on the app.

Tests

- The test level matches the behaviour under change.
- Network is mocked at the boundary (MSW), not by stubbing the client method.
- No test that cannot fail.
- A new component has the three stories the repository asks for.

Wire contract — required when a paired backend PR exists

- The payload, the error codes, and the null-vs-zero defaults were read in the
  paired PR at a pinned ref, not assumed from the consumer.
- Deploy order is named. If the producer is still open and must merge first,
  that is a finding against the call site, not a note.

## Scope notes

A process remark (one task, size, missing Why / In scope / Out of scope) is
`location_class: pr-process` and renders under `### Scope`, not as a code
finding. Merge state is an input to the verdict, not a finding.
