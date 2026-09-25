---
name: ruby-rails-implementation
description: "Use when implementing or extending a feature in a Ruby on Rails app -- MVC boundaries, strong parameters, ActiveRecord associations and scopes, service objects for fat controllers/models, ActiveJob, and modern Ruby 3.x idiom (pattern matching, endless methods, keyword args). Not for writing or fixing tests (use ruby-rails-testing)."
triggers:
  - "implement this feature in Rails"
  - "add a Rails controller action and model for this"
  - "add strong parameters to this Rails controller"
  - "extract this Rails controller logic into a service object"
  - "add an ActiveRecord association and scope for this"
  - "add an ActiveJob for this background task"
metadata:
  origin: authored
  category: implement
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Ruby on Rails implementation (Ruby 3.x, Rails)

Implement or extend a feature in a Rails codebase: MVC boundaries,
ActiveRecord modeling, strong parameters, service objects, ActiveJob, and
modern Ruby idiom. This is a combined Ruby+Rails pack (no separate
`lang:ruby` base) — `rules/coding-style.mdc`, `rules/patterns.mdc`, and
`rules/security.mdc` carry the full rule set this skill draws its
checklist from; read them before writing code, not just this summary.

## Workflow

### Step 1: Discover the project's own conventions

1. Read `Gemfile`/`Gemfile.lock` for the Rails and Ruby versions, and
   whether the project already has a service-object gem or convention
   (`app/services/`, a shared base class), FactoryBot, RSpec vs
   Minitest, and any auth gem (Devise, has_secure_password).
2. Find the existing layout under `app/` for the area you're touching —
   match its naming and directory conventions; do not invent a new
   top-level directory for one feature.
3. Read 1-2 neighboring models/controllers for: validation style,
   whether concerns are already used, how strong parameters are
   structured, and whether callbacks or service objects are the
   project's preferred way to keep controllers/models thin.

### Step 2: Design before writing

- Decide where each piece of new logic belongs: routing/params handling
  in the controller, persistence/validation in the model, multi-step or
  cross-model orchestration in a service object (`rules/patterns.mdc`)
  — not stacked into one fat controller action or model callback.
- For a new ActiveRecord association, decide the query pattern up front:
  will callers iterate the association in a loop (needs `includes` at
  the call site to avoid N+1) or query it directly (a named `scope` may
  belong on the model).
- For a new background job, decide what makes `perform` idempotent
  before writing it — a uniqueness check, an idempotency key, or an
  upsert — most Active Job queue adapters (Sidekiq, SQS, Resque) are
  at-least-once, not exactly-once, though the actual guarantee depends
  on the configured adapter (the inline/test adapters have none).

### Step 3: Implement

1. Strong parameters: require the permitted shape explicitly with
   `params.expect(model: [:field, ...])` (current Rails idiom) or
   `params.require(:model).permit(:field, ...)` — never build/update a
   model from a raw `params` hash, and never call `permit!` on
   user-controlled params.
2. Keep the controller action thin: params in, call the model/service,
   render/redirect out. Extract a service object when the action's
   logic spans multiple models, calls an external service, or has
   enough branching to warrant its own tests.
3. Use `includes`/`preload`/`eager_load` before iterating an association
   in a loop; push filtering into the database (`where`, a named
   `scope`) instead of loading records and filtering in Ruby.
4. Reach for modern Ruby idiom where it genuinely clarifies: `case/in`
   pattern matching for destructuring a hash/array-shaped value, an
   endless method for a real one-expression method, keyword arguments
   for a multi-parameter method — not as syntax for its own sake.
5. Every controller action that requires a logged-in user has the
   app's `before_action` auth filter, and every action further checks
   that the current user is authorized for *this* record, not just
   logged in.
6. Add `# frozen_string_literal: true` to new files if the project's
   existing files use it.

### Step 4: Verify

```bash
bundle exec rspec   # or: bin/rails test
bundle exec rubocop
```

Run `bin/rails db:test:prepare` if a migration changed the schema. Fix
findings at the root cause per `rules/security.mdc` and
`rules/coding-style.mdc`; a failing test here is a signal to fix the
implementation, not to reach for `ruby-rails-build-fix`'s scope unless
the failure is purely a dependency/migration/toolchain problem unrelated
to the feature logic.

### Step 5: Report

```
Implemented: app/models/order.rb, app/controllers/orders_controller.rb,
  app/services/place_order.rb, spec/services/place_order_spec.rb
  - New PlaceOrder service object consumed by OrdersController#create
  - rspec/rubocop both pass
```

## Rules

- Never build or update a model from a raw `params` hash; always go
  through strong parameters (`params.expect`/`params.require`+`permit`),
  and never call `permit!` on user-controlled params.
- Never iterate an ActiveRecord association in a loop without eager
  loading it first (`includes`) when the association is used inside
  that loop.
- Never put multi-step orchestration or an external API call directly
  in a controller action or a model callback — extract a service
  object.
- Never write an `ActiveJob#perform` that assumes exactly-once delivery
  for a side effect that would be harmful to repeat.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll just do `Order.new(params[:order])`, it's a small internal form" | Bypasses strong parameters entirely; any key in `params[:order]`, including ones never meant to be user-settable, gets mass-assigned |
| "I'll call `.author` inside this `each` loop, it's just one extra query" | That "one extra query" happens once per row — N+1 queries; add `.includes(:author)` before the loop |
| "This callback also sends a welcome email and pings analytics, but it's still 'about' the model" | A model callback doing multi-step, cross-system work is the fat-model anti-pattern; extract a service object so it's testable in isolation and the model stays about persistence |
| "The job will basically only ever run once" | Most production Active Job adapters are at-least-once, not exactly-once; a retried or duplicated run has to be safe |

## Verification

Do not report the work done until all of the following hold:

- `bundle exec rspec` (or `bin/rails test`) and `bundle exec rubocop`
  both exit 0.
- Every new/changed controller action that mutates a model goes through
  strong parameters, with no `permit!` on user-controlled input.
- Every new loop over an ActiveRecord association eager-loads it first.
- Every new `ActiveJob#perform` is safe to run more than once for the
  same logical unit of work.
