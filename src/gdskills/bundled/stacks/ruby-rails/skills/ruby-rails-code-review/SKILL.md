---
name: ruby-rails-code-review
description: "Use when reviewing a Rails change for framework-specific risks -- mass assignment gaps, N+1 queries, raw SQL interpolation, raw/html_safe XSS, missing auth/authorization filters, fat controllers/models, and non-idempotent ActiveJobs. Not for a change in another web framework's own MVC layer (use that framework's own code-review skill). Read-only, no edits."
triggers:
  - "review this Rails diff for mass assignment issues"
  - "check this Rails controller for N+1 queries"
  - "review this Rails change for missing authorization"
  - "any XSS risk from raw or html_safe in this Rails view"
  - "review this Rails job for idempotency"
  - "check this Rails diff for fat controller or fat model smells"
metadata:
  origin: authored
  category: review
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Ruby on Rails code review

Read-only review of a Rails change for framework-specific risks: mass
assignment, N+1 queries, raw SQL, XSS via `raw`/`html_safe`, missing
auth/authorization, fat controllers/models, and non-idempotent jobs.
This skill never edits code — it reports findings.
`rules/coding-style.mdc`, `rules/patterns.mdc`, and `rules/security.mdc`
are the rule set findings are checked against.

## Workflow

### Step 1: Scope the review

1. Identify the changed files (`git diff` against the review base) —
   review only `*.rb` files (and templates, if in scope) in the diff,
   not the whole repository.
2. Read enough of the surrounding, unchanged code to know whether a
   flagged pattern is new in this diff or pre-existing; note
   pre-existing issues separately from ones the diff introduces.

### Step 2: Check each changed file against the focus list

**Mass assignment**
- A model built/updated from `params` uses `params.expect`/
  `params.require`+`permit` with an explicit attribute list — flag
  `Model.new(params[:model])`, `record.update(params)`, or any
  `permit!` on user-controlled params.

**N+1 queries**
- Any loop (explicit `each`/`map`, or implicit via a view iterating a
  collection) that calls an association method per iteration — flag it
  when the association was not eager-loaded (`includes`/`preload`/
  `eager_load`) before the loop.

**SQL and data access**
- Flag any `where`, `find_by_sql`, `order`, or `pluck` call built with
  string interpolation of a value that traces back to user input,
  instead of parameterized conditions or `sanitize_sql`.

**XSS / output encoding**
- Flag `raw(...)` or `.html_safe` applied to a value that can contain
  user-controlled or user-influenced content — it disables ERB's
  automatic escaping for that value.

**Authentication and authorization**
- A controller action that should require login has the app's
  `before_action` auth filter (not accidentally excluded via
  `skip_before_action`) — flag one that doesn't.
- Flag an action that checks the user is logged in but never confirms
  they're allowed to act on *this specific* record (an IDOR risk).

**CSRF**
- Flag `skip_before_action :verify_authenticity_token` or
  `protect_from_forgery with: :null_session` added on an action
  reachable from a standard HTML form, unless the diff itself
  documents why (e.g. a signature-verified webhook).

**Fat controllers/models**
- A controller action with inline multi-step business logic, or a model
  callback orchestrating unrelated side effects (email, third-party
  call, another model's update) — flag as a candidate for extraction
  into a service object per `rules/patterns.mdc`.

**Background jobs**
- An `ActiveJob#perform` whose side effect would be harmful if it ran
  twice (charge, duplicate send) with no idempotency guard — flag it,
  since most production Active Job adapters are at-least-once.

### Step 3: Report

For each finding: file:line, the pattern, why it matters (security
impact, correctness, maintainability), and the fix direction — but do
not apply it.

```
app/controllers/orders_controller.rb:18 — builds Order from raw
  params[:order] with no strong parameters. Risk: mass assignment lets
  any submitted key (including ones never meant to be user-settable)
  through. Fix direction: require/permit an explicit attribute list via
  params.expect(order: [...]) or params.require(:order).permit(...).
```

## Rules

- NEVER edit code — findings and fix direction only.
- Flag mass assignment gaps, N+1 queries, raw SQL interpolation,
  raw/html_safe XSS risk, missing auth/authorization, disabled CSRF
  protection, fat controller/model smells, and non-idempotent jobs; do
  not report generic style nits already covered by `rubocop`.
- Distinguish a finding the diff introduces from a pre-existing one in
  code the diff merely touches.
- When a suspected N+1 is not certain from reading alone (e.g. the
  association might already be preloaded further up the call chain),
  say so and recommend confirming with `bullet` or the query log rather
  than asserting it with certainty.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "This form only has a few fields, mass assignment isn't really a risk here" | Any field in the raw params hash is a risk regardless of the form's apparent size; strong parameters cost nothing and close the gap categorically |
| "The N+1 here is only over 3-4 records in this view" | Reviews check the code path, not today's data volume — a small collection today is a large one after the feature ships and the table grows |
| "I'll just fix the missing before_action myself since it's one line" | This skill is read-only; report the finding and its fix direction, do not edit the file |
| "raw(user.bio) is fine, this is an internal admin tool" | User-controlled data marked pre-escaped is a genuine XSS vector regardless of who the internal audience is; flag it and let the fix direction note the sanitize option |

## Verification

Do not report the review done until all of the following hold:

- Every changed `*.rb` file in the diff was read, not just files named
  in the PR description.
- Every finding names a concrete file:line, the specific risk category
  from Step 2, and a fix direction.
- No source file was modified by this review.
- Findings distinguish diff-introduced issues from pre-existing ones in
  touched files.
