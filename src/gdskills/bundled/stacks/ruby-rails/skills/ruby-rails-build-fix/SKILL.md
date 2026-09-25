---
name: ruby-rails-build-fix
description: "Use when bundle install/bundle exec fails, a Rails migration or db:test:prepare fails, rubocop reports offenses, or a Rails test suite fails to boot -- resolves Gemfile.lock mismatches, pending/failed migrations, autoload/zeitwerk errors, and rubocop findings with the smallest root-cause fix."
triggers:
  - "bundle install is failing"
  - "this Rails migration won't run"
  - "rubocop is reporting offenses on this Rails file"
  - "zeitwerk autoloading error in this Rails app"
  - "Gemfile.lock is out of sync"
  - "Rails test suite won't boot, pending migration"
metadata:
  origin: authored
  category: build-fix
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Ruby on Rails build fix

Resolve a `bundle install`/`bundle exec` failure, a pending or failing
migration, a Zeitwerk autoload error, a `rubocop` finding, or a Rails
test suite that fails to boot — with the smallest change that fixes the
actual root cause. `rules/coding-style.mdc` and `rules/security.mdc`
govern what a "correct" fix looks like; this skill never reaches for a
suppression instead of a fix.

## Workflow

### Step 1: Reproduce and classify

```bash
bundle install
bundle exec rubocop
bin/rails db:migrate:status
```

Read the exact error text and classify it:

- **Bundler/Gemfile.lock mismatch** (`Gemfile.lock` doesn't satisfy
  `Gemfile`, a version conflict, a missing platform entry).
- **Pending/failing migration** (`db:migrate:status` shows `down`
  entries, or `db:migrate` raises).
- **Zeitwerk autoload error** (`Zeitwerk::NameError`, a file whose
  constant name doesn't match its path).
- **Rubocop offense** (a cop violation reported by `bundle exec
  rubocop`).
- **Test suite boot failure** (the suite errors before any example
  runs — usually a load error, a missing fixture/factory, or a schema
  mismatch against `db/test.sqlite3`/the test database).

### Step 2: Fix by category

**Bundler/Gemfile.lock:** run `bundle install` first — if it reports a
real version conflict rather than a simple stale lock, check `bundle
outdated <gem>` and the Gemfile's version constraints before bumping a
version by hand. Only edit `Gemfile.lock` by running Bundler commands
against it, never by hand-editing the lock file's resolved versions.

**Pending/failing migration:** run `bin/rails db:migrate` to apply a
genuinely pending migration. For a migration that raises, fix the
migration itself (a bad column type, a missing `up`/`down` pair) and
re-run it — never hand-edit `db/schema.rb` to match what the migration
was supposed to produce; the schema is generated, not authored. Run
`bin/rails db:test:prepare` afterward so the test database matches.

**Zeitwerk autoload error:** match the file's path to its expected
constant name (`app/models/order_item.rb` must define `OrderItem`, not
`OrderItem` inside a wrongly-cased directory, or vice versa) — Zeitwerk
infers the constant from the path. If the class genuinely needs a
different constant name than its conventional path implies, use an
explicit `inflect`/custom loader entry in
`config/initializers/zeitwerk.rb` rather than working around the
mismatch with a `require` or a `require_relative`.

**Rubocop offense:** fix the code the offense names. Never add
`# rubocop:disable Cop/Name` (or a blanket disable at the top of the
file) to silence a finding without fixing or explaining the underlying
issue in the report — a narrow, justified disable comment is only
acceptable when the project's own `.rubocop.yml` already documents that
exception pattern.

**Test suite boot failure:** read the actual load error — a missing
factory/fixture reference, a schema mismatch (run `bin/rails
db:test:prepare`), or a require error in `spec_helper.rb`/`rails_helper.rb`.
Fix the referenced file or run the schema sync; do not comment out the
failing require or skip loading part of the suite to get past the
error.

### Step 3: Verify

```bash
bundle exec rspec   # or: bin/rails test
bundle exec rubocop
bin/rails db:migrate:status
```

All must exit 0 (migrate:status shows no pending migrations) before
reporting done.

### Step 4: Report

```
Fixed: pending migration 20260101000000_add_index_to_orders.rb
  - Root cause: migration was committed but never run against the dev/test DB
  - Ran bin/rails db:migrate + db:test:prepare; rspec/rubocop both pass
```

State the root cause in one sentence, not just "fixed the error."

## Rules

- Find and fix the smallest change that addresses the actual root
  cause — never widen a fix beyond what the failure requires.
- NEVER add `# rubocop:disable` to silence a finding instead of fixing
  what it found, unless the project's own config already documents
  that exception.
- NEVER hand-edit `db/schema.rb` to make a migration failure disappear
  — fix or add the migration and let it regenerate the schema.
- NEVER hand-edit `Gemfile.lock`'s resolved versions directly; use
  Bundler commands.
- NEVER delete or skip a failing test to reach a green build.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll add `# rubocop:disable Metrics/MethodLength` here so it stops complaining" | Silences the finding without addressing the actual length/complexity issue the cop caught; refactor instead unless the project's config already allows this exception |
| "I'll just edit db/schema.rb to add the column the migration was supposed to add" | `db/schema.rb` is generated from migrations, not authored directly; a hand-edit drifts from what `db:migrate` actually produces and breaks the next `db:schema:load` |
| "This gem conflict is annoying, I'll just delete Gemfile.lock and let it regenerate" | Throws away every other gem's pinned, tested version along with the one causing the conflict; resolve the actual constraint instead |
| "I'll require_relative the file manually to work around the Zeitwerk naming error" | Papers over a path/constant mismatch Zeitwerk will keep re-flagging elsewhere; fix the file's name/location (or the explicit inflection) instead |

## Verification

Do not report the fix done until all of the following hold:

- `bundle exec rspec` (or `bin/rails test`) and `bundle exec rubocop`
  both exit 0, and `bin/rails db:migrate:status` shows no pending
  migrations.
- The change is the smallest one that addresses the stated root cause —
  no unrelated files touched.
- The report states the root cause in one sentence, not just "build now
  passes."
