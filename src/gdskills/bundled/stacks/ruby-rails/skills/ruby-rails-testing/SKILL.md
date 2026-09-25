---
name: ruby-rails-testing
description: "Use when a Rails app's test suite needs writing, extending, or fixing -- RSpec request/model/job specs (or Minitest equivalents), FactoryBot fixtures, stubbing external HTTP calls, asserting on enqueued ActiveJobs, and avoiding sleep-based waits."
triggers:
  - "write RSpec tests for this Rails model"
  - "add a request spec for this Rails controller action"
  - "test this ActiveJob with have_enqueued_job"
  - "fix this failing Rails test"
  - "write Minitest tests for this Rails model"
  - "stub this external API call in a Rails test"
metadata:
  origin: authored
  category: test
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Ruby on Rails testing

Write, extend, or fix a Rails app's test suite: RSpec (or Minitest)
specs for models, controllers/requests, and jobs, with FactoryBot
fixtures, stubbed external boundaries, and deterministic waits.
`rules/testing.mdc` carries the full rule set this skill's checklist is
built from — read it, not just this summary, before writing tests.

## Workflow

### Step 1: Discover the project's test conventions

1. Check `Gemfile`/`Gemfile.lock` for RSpec vs Minitest, FactoryBot,
   WebMock/VCR, and any time-freezing gem (Timecop or Rails' built-in
   `travel_to`) — match whichever is already there, never introduce the
   other test framework.
2. Find the layout: `spec/<mirror of app/>` (RSpec) or
   `test/<mirror of app/>` (Minitest). Match the existing file for the
   type of code under test (model spec, request spec, job spec).
3. Read 1-2 neighboring spec/test files for: fixture style
   (`let`/`let!`/factories vs fixtures), whether request specs or
   controller specs are used, and how external HTTP calls are already
   stubbed in this project.

### Step 2: Plan test cases

**Models:** validations (presence, uniqueness, format), each
association's behavior relevant to the change, scopes, and any
non-trivial instance/class method.

**Requests (preferred over controller specs for new coverage):**
happy path (correct status/body), auth failure (no session — expect a
redirect/401), authorization failure (wrong user — expect
403/404 depending on the app's convention), and strong-parameters
rejection of an unpermitted field.

**Jobs:** assert enqueue with `have_enqueued_job`/`assert_enqueued_with`
for most tests; only actually run the job
(`perform_enqueued_jobs`) when the test's purpose is the job's own
`perform` behavior, and cover what happens if `perform` runs twice for
jobs that must be idempotent.

### Step 3: Write

1. Create/extend the spec/test file at the project's own convention
   path, mirroring `app/`'s structure.
2. Use the project's existing fixture approach (FactoryBot
   `create`/`build`/`build_stubbed`, or fixtures) — do not hand-roll
   ad hoc records when a factory already covers the model.
3. Stub any external HTTP call at the boundary (WebMock/VCR or the
   project's existing tooling); a test must not make a real network
   call.
4. Freeze time (`travel_to`, matching the project's convention) for any
   assertion involving a timestamp or elapsed-time calculation.
5. Never use `sleep` to wait for a job, callback, or async result — use
   `perform_enqueued_jobs`, a Capybara auto-retrying matcher
   (`have_content`), or an explicit polling helper with a timeout.

### Step 4: Run and fix

```bash
bundle exec rspec   # or: bin/rails test
```

Fix failing tests (max 3 iterations) — fix the test, not the source
under test, unless the test itself has correctly caught a real bug (say
so in the report rather than silently changing production code).

### Step 5: Report

```
Generated: spec/requests/orders_spec.rb
  - 6 examples (happy path, auth failure, authorization failure,
    unpermitted param), all passing
```

## Rules

- ALWAYS match the project's existing framework (RSpec/Minitest),
  fixture style, and spec layout found in Step 1, not a different
  project's convention.
- NEVER modify application code — only spec/test files and
  fixtures/factories, unless a test caught a real bug (say so).
- NEVER use `sleep` to wait for a job or async result.
- NEVER let a test make a real network call to an external service.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll add `sleep(1)` after enqueuing so the job has time to run" | Non-deterministic and slow; use `perform_enqueued_jobs` to run it synchronously in the test, or `have_enqueued_job` to assert the enqueue itself |
| "This test hits the real payment API sandbox, that's basically a stub" | Still a real network call in the suite — flaky, slow, and can fail for reasons unrelated to the code under test; stub it with WebMock/VCR instead |
| "I'll just assert `response.status` and skip checking the body/authorization case" | A request spec that only checks the happy-path status misses exactly the auth/authorization regressions these specs exist to catch |
| "The job might run twice in production but I'll just test the single-run case" | If the job needs to be idempotent, the test suite is where that guarantee gets proven — add a case that runs `perform` twice and asserts no duplicate effect |

## Verification

Do not report the work done until all of the following hold:

- The spec/test file sits at the project's own convention path, matching
  the fixture/framework style read in Step 1.
- `bundle exec rspec` (or `bin/rails test`) exits 0 with every generated
  test passing.
- `git status` shows only spec/test files (and factories/fixtures, if
  touched) added or modified; no application source file changed unless
  a real bug was found and reported as such.
- No test makes a real network call or synchronizes with `sleep`.
