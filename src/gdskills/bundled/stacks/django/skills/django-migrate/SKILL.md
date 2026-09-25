---
name: django-migrate
description: "Use when generating, reviewing, or safely applying Django schema/data migrations -- makemigrations for a model change, RunPython data migrations with forward/reverse functions, merge migrations for divergent branches, and staged rollout for a migration that must ship alongside a multi-phase deploy (e.g. a column removal). Not for a Django-major-version framework upgrade (there is no separate django-upgrade skill in this pack; treat a version jump as django-implementation plus this skill's migration discipline) or for fixing a broken/conflicting migration that's blocking the build (see django-build-fix)."
triggers:
  - "generate a django migration for this model change"
  - "write a data migration to backfill this field"
  - "make this django migration reversible"
  - "how do I safely drop this column in django"
  - "squash these django migrations"
  - "write a RunPython migration"
  - "stage this django schema change across two deploys"
metadata:
  origin: authored
  category: migrate
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Django migrate

Generate, review, and safely apply Django schema and data migrations:
`makemigrations` for a model change, `RunPython` for data transforms with
forward/reverse functions, and staged rollout for a migration whose schema
change would break code still running the previous release. Scoped to the
migration itself — for the model/view/form code change that motivates the
migration use `django-implementation`; for resolving a migration that is
already conflicting or blocking the build use `django-build-fix`.

## Workflow

### Step 1: Establish what's changing and why

1. Diff the model change driving the migration (new field, changed
   constraint, removed field, renamed field/table) against the current
   migration graph's state for that app.
2. Decide whether this is schema-only (Django can express it entirely as
   `AddField`/`AlterField`/etc.) or needs a data transform (backfilling a
   new non-nullable field, splitting one column into two, converting a
   value's representation) — a data transform needs a `RunPython` step, not
   just the schema operation.
3. Check whether the change is destructive for code still running the
   previous release (a column removal, a rename, a type narrowing) — if the
   project deploys code and migrations as separate steps, this needs a
   staged rollout (Step 4), not a single migration.

### Step 2: Generate the migration

```bash
python manage.py makemigrations <app_label>
```

Let Django diff the models against the existing migration graph; never
hand-write `operations` to match a model edit by guesswork. Review the
generated file: correct operation types, correct `dependencies`, and no
unexpected side operation (an accidental `AlterField` on an untouched field
usually means the model's `Meta` or a field kwarg drifted from what the
last migration recorded).

### Step 3: Add data-transform logic when needed

- Add a `migrations.RunPython(forward, reverse)` operation for any
  transform that touches existing row data. Write both directions:
  `forward` performs the transform, `reverse` undoes it (or use
  `migrations.RunPython.noop` for `reverse` only when undoing is genuinely
  not meaningful, e.g. an irreversible data merge — state that explicitly
  rather than omitting the argument).
- Fetch models inside `RunPython` via `apps.get_model("app", "Model")` (the
  historical, frozen-at-this-migration model), never by importing the
  live model class — the live model can have fields this migration's
  historical state doesn't, which breaks replaying migration history from
  scratch.
- For a backfill on a large table, batch the update (`.iterator()` +
  chunked `.bulk_update()`, or `Model.objects.filter(...).update(...)` when
  the value doesn't depend on per-row computation) rather than a single
  `.save()`-per-row loop.

### Step 4: Stage a destructive/breaking change

For a schema change that would break code from the previous release still
running during a rolling deploy (removing a column code still reads, a
rename, `NOT NULL` added without a default):

1. **Release N:** ship the code change that stops reading/writing the old
   shape, while the schema still has it (e.g. stop reading the old column,
   start reading/writing the new one; add the new nullable column alongside
   the old one).
2. **Release N+1:** once release N is fully rolled out, ship the migration
   that actually drops/alters the old schema — nothing still running reads
   it by then.
3. Never combine "stop using the old column in code" and "drop the old
   column in the same migration" in one release when the project's deploy
   process can run old code against the new schema for any window (rolling
   deploy, canary, multiple app servers) — that window is exactly when a
   still-running old-code instance would break.

### Step 5: Merge conflicting migrations

When two branches added divergent migrations from the same parent:

```bash
python manage.py makemigrations --merge
```

Review the generated merge migration; never hand-edit either migration's
`dependencies` to force a resolution instead (see `django-build-fix` if this
is blocking a currently-broken build).

### Step 6: Verify and report

```bash
python manage.py makemigrations --check --dry-run
python manage.py migrate --plan
python manage.py test   # or: pytest, if pytest-django is configured
```

```
Migrated: accounts app
  - 0012_backfill_display_name.py: RunPython forward fills display_name from
    first_name+last_name for existing rows; reverse clears it back to ""
  - staged: this release only adds the nullable display_name column and
    backfills it; a follow-up release will make it NOT NULL and stop
    accepting the old two-field form
  - makemigrations --check, migrate --plan, test: all green
```

## Rules

- ALWAYS generate migrations with `makemigrations`; never hand-write
  `operations` to match a model edit by guesswork.
- ALWAYS write both `forward` and `reverse` for a `RunPython` data
  migration, or explicitly use `RunPython.noop` with a stated reason when
  reversal isn't meaningful.
- ALWAYS fetch models inside a `RunPython` function via
  `apps.get_model(...)`, never the live imported model class.
- NEVER combine dropping/breaking a schema shape with removing the last
  code that reads it in the same release when the deploy process can run
  old code against the new schema for any window — stage it across two
  releases instead.
- NEVER hand-edit a migration's `dependencies`/`operations` to resolve a
  conflict — generate a merge migration and review it.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll drop the old column and update the code in the same migration/release" | Breaks any old-code instance still running against the new schema during a rolling deploy; stage it across two releases |
| "I'll import the live model in this RunPython function, it's simpler" | The live model can drift from what this migration's historical state expects, breaking a from-scratch replay of migration history; use `apps.get_model(...)` |
| "This data migration doesn't need a reverse, I'll just leave it out" | Leaves `migrate <app> <previous>` broken for this migration; use `RunPython.noop` explicitly if reversal truly isn't meaningful |
| "I'll hand-edit the migration's `dependencies` to resolve this merge conflict" | Desyncs the migration graph from what other environments already recorded as applied; use `makemigrations --merge` |

## Verification

Do not report the work done until all of the following hold:

- The migration was generated by `makemigrations` (or `--merge`), not
  hand-written from scratch.
- Any data transform uses `RunPython` with both `forward` and `reverse` (or
  an explicit, justified `RunPython.noop`), fetching models via
  `apps.get_model(...)`.
- A destructive/breaking schema change is staged across two releases when
  the project's deploy process can run old and new code concurrently.
- `makemigrations --check --dry-run` and `migrate --plan` both succeed with
  no unexpected pending operation, and the test suite passes.
- No migration file's `dependencies`/`operations` was hand-edited outside
  what `makemigrations`/`--merge` generated.
