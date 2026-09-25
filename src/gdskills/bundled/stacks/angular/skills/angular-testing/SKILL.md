---
name: angular-testing
description: "Use when writing or fixing a TestBed spec for an Angular component, service, directive, pipe, or route guard -- configuring TestBed.configureTestingModule, driving a ComponentFixture (componentRef.setInput, detectChanges, whenStable), mocking HttpClient with HttpTestingController, testing a CanActivate/CanMatch guard function, and using fakeAsync/tick for deterministic async specs. Not for Vue/React component tests, not for a full user-flow check against a deployed, running instance, and not for implementing the component/service under test (use angular-implementation)."
triggers:
  - "write a TestBed spec for this Angular component"
  - "test this Angular service's HTTP calls with HttpTestingController"
  - "add a spec asserting this Angular component's rendered DOM"
  - "write a fakeAsync test for this Angular component"
  - "test this Angular CanActivate route guard's logic"
  - "mock this Angular component's injected service in a spec"
metadata:
  origin: authored
  category: test
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Angular testing (TestBed)

Write or fix a unit test for an Angular component, service, directive, or
pipe using `TestBed`. See `rules/testing.mdc` for layout, fixture, and
determinism conventions; this skill is the step-by-step workflow for
applying them to a specific component or service under test.

## Workflow

### Step 1: Discover the project's test setup

- Check `angular.json`'s `test` builder and `package.json`'s `test` script
  to confirm the actual runner (`ng test`/Karma, or a migrated Jest/Vitest
  setup) before assuming Karma.
- Look at an existing `.spec.ts` in the same directory/module for the
  project's own conventions: how it configures `TestBed`, whether it uses
  `HttpTestingController` or a hand-rolled HTTP mock, and its
  `fakeAsync`/`waitForAsync` usage.

### Step 2: Configure TestBed for the unit under test

- For a standalone component: `TestBed.configureTestingModule({ imports:
  [MyComponent, ...anySupportingImports] })` -- standalone components are
  imported, not declared.
- Provide test doubles for injected dependencies via `providers` (a mock
  object, a `jasmine.createSpyObj`, or `provideHttpClientTesting()` for
  `HttpClient`-backed services) rather than letting the real service reach
  a real network/backend.
- `TestBed.createComponent(MyComponent)` to get the `ComponentFixture`;
  keep a reference to `fixture.componentInstance` for direct assertions on
  class state.

### Step 3: Drive the fixture correctly

- Set a signal-based input with `fixture.componentRef.setInput('name',
  value)` -- never by assigning the component instance's field directly,
  since that skips Angular's actual input-binding path.
- Call `fixture.detectChanges()` after any state change that should affect
  the DOM, and `await fixture.whenStable()` after anything asynchronous
  (a resolved promise, a flushed HTTP request) before asserting on
  rendered markup.
- Query with `fixture.debugElement.query(By.css(...))` or
  `fixture.nativeElement.querySelector(...)`, preferring a stable selector
  (`data-testid`, semantic role/label) over a styling-only CSS class.

### Step 4: HTTP and async determinism

- For a service/component that calls `HttpClient`, provide
  `provideHttpClientTesting()` and assert with `HttpTestingController`:
  `httpTestingController.expectOne(url).flush(mockResponse)`. Call
  `httpTestingController.verify()` at the end of the test (or in an
  `afterEach`) to catch an unexpected extra request.
- Wrap a test that depends on timers/microtasks in `fakeAsync` and advance
  time with `tick(<exact ms>)` (matching the real delay the code under
  test uses) rather than a real `setTimeout` in the spec -- a real timer
  makes the test's runtime and reliability depend on wall-clock timing.

### Step 5: Verify

Run the project's actual test command and confirm the new/changed spec
passes without weakening an existing assertion.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll just set `component.order = mockOrder` directly instead of `setInput`" | Direct field assignment on a signal input skips Angular's input-binding path; a real caller's binding wouldn't reach the component that way, so the test can pass while the actual binding is broken |
| "I'll skip `httpTestingController.verify()`, the test already checked the response I care about" | `verify()` is what catches an unexpected *extra* request (e.g. a duplicated HTTP call from a bug); skipping it lets that regression through silently |
| "I'll use a real `setTimeout(..., 1000)` in the test instead of `fakeAsync`/`tick`" | A real timer makes the test's speed and reliability depend on wall-clock timing and CI load; `tick()` advances virtual time deterministically |
| "This assertion fails right after `setInput`, I'll just delete it since the feature clearly still works manually" | The assertion is failing because `detectChanges()`/`whenStable()` wasn't called before it, not because the feature is broken -- fix the missing call, don't delete the check |

## Verification

Do not report the test done until all of the following hold:

- The project's actual test command (`ng test` or its configured
  equivalent) passes, including the new/changed spec.
- Every signal-based input in the test is set via
  `fixture.componentRef.setInput(...)`, not direct field assignment.
- Every `HttpClient` call the test exercises goes through
  `HttpTestingController`, and `verify()` runs (no unexpected leftover
  request).
- No existing assertion was weakened, skipped, or deleted to make the
  suite pass.
