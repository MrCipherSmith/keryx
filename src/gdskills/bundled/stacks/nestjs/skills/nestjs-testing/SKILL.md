---
name: nestjs-testing
description: "Use when writing or debugging a NestJS test built through Nest's own testing-module builder: a unit test that swaps a provider's real dependency (a repository, an HTTP client) for a fake or mock double so the unit under test runs in isolation, or an e2e test that boots a real Nest application and drives it with supertest through the actual guard/pipe/filter pipeline. Scoped to a test compiled through Nest's own testing module; excludes picking field-level checks for a request body, authoring the feature itself, and a framework-agnostic unit test that never touches Nest's module system."
triggers:
  - "write unit tests for this NestJS provider"
  - "replace a provider's real dependency with a fake in a NestJS unit test"
  - "write an e2e test for this NestJS endpoint with supertest"
  - "exercise this NestJS guard in isolation with an overridden Reflector"
  - "the NestJS test module won't compile because a provider it needs is missing"
  - "my NestJS e2e test suite leaves the process hanging after it finishes"
metadata:
  origin: authored
  category: test
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# NestJS testing (@nestjs/testing unit and e2e specs)

Write or fix a NestJS unit or end-to-end test using `@nestjs/testing`'s
module-compiled style: build the unit under test through a real (or
overridden) Nest DI graph rather than hand-constructing it. See
`rules/testing.mdc` for the full layout, mocking, and determinism
conventions this skill applies.

## Workflow

### Step 1: Determine whether this is a unit or e2e test

- **Unit**: exercising one provider (service, guard, interceptor, pipe) in
  isolation, with its dependencies replaced by test doubles. Lives beside
  the source as `<name>.spec.ts`.
- **E2E**: exercising a real HTTP request through the full pipeline
  (guards, pipes, interceptors, filters, controller, service). Lives under
  `test/` as `<feature>.e2e-spec.ts`.

If unsure which the request wants, default to a unit test for a single
provider/class and an e2e test for "does this endpoint work end to end".

### Step 2: Build the testing module

```typescript
const moduleRef = await Test.createTestingModule({
  providers: [UsersService, { provide: UsersRepository, useValue: mockRepo }],
  // or: imports: [UsersModule] for an e2e-style compile
})
  .overrideProvider(UsersRepository)
  .useValue(mockRepo)
  .compile();
```

Use `.overrideProvider(Token).useValue(...)` (or `.useFactory`/`.useClass`)
to replace a real dependency with a test double -- never `new` the class
under test directly with hand-built fakes, and never monkey-patch the
compiled module's internals. The same `.overrideGuard()`/
`.overrideInterceptor()`/`.overridePipe()`/`.overrideFilter()` methods exist
for testing a controller/module with one of those swapped out.

### Step 3 (unit): Get the instance and assert

```typescript
const service = moduleRef.get(UsersService);
```

Assert against the service's own return value/thrown exception. Mock only
at the injected-provider boundary (repository, HTTP client) -- not by
stubbing a private method on the class under test.

### Step 3 (e2e): Boot a real application and drive it with supertest

```typescript
const app = moduleRef.createNestApplication();
await app.init();
// ...
await request(app.getHttpServer()).get('/users').expect(200);
// ...
await app.close();
```

Assert on HTTP status and response shape via `supertest`, not by reaching
back into the service's return value -- the point of an e2e spec is that
guards/pipes/filters actually ran. Always close the app (`afterAll(() =>
app.close())`) to release DB connections and timers.

### Step 4: Verify

Run the project's unit and e2e test scripts (see Verification below) and
confirm the new/changed spec fails without the fix and passes with it, and
that no other spec started flaking or hanging (a common symptom of a
missing `app.close()`).

## Rules

- Follow `rules/testing.mdc` for layout, mocking boundary, and determinism.
- ALWAYS build the unit under test through `Test.createTestingModule(...)
  .compile()`, not a hand-constructed instance.
- ALWAYS call `app.close()` in `afterAll` for every e2e spec that calls
  `createNestApplication()`.
- NEVER delete or `.skip()` a failing spec to reach a green suite --
  diagnose whether the source or the test's expectation is stale (same
  rule as any build-fix skill) and fix that instead.
- NEVER assert against a mocked provider's internal call count as the
  entire test -- assert the actual behavior (return value, thrown
  exception, HTTP response) the mock enables you to isolate.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll just `new UsersService(mockRepo)` directly, it's simpler than the testing module" | Skips Nest's own DI wiring, so the test can pass while the real module would fail to compile (missing export, wrong token) |
| "I'll stub the private method that calls the repository instead of mocking the repository" | Reaches inside the unit under test instead of mocking its actual dependency boundary; couples the test to an implementation detail |
| "This e2e spec is slow because of app.init()/app.close(), I'll skip close() to speed it up" | Leaks open DB connections/timers across spec files; a later suite hanging or flaking is the actual cost |
| "This test keeps failing after my change, I'll just skip it for now" | Hides a real regression or a stale test expectation; determine which one it is and fix that, don't silence the signal |

## Verification

Do not report the test work done until all of the following hold:

- The project's unit test script and (when e2e specs were touched) its
  `test:e2e` script both pass.
- Every `createNestApplication()` in a touched e2e spec has a matching
  `app.close()`.
- No dependency of the unit under test was replaced by monkey-patching or
  hand-construction instead of `Test.createTestingModule`/`override*`.
- No spec was deleted or `.skip()`-ed to reach green.
- `git status` shows changes confined to the spec file(s) and, if the test
  exposed a real bug, the source file(s) the fix required.
