---
name: java-kotlin-spring-migrate
description: "Use when writing or reviewing a versioned database schema migration for a Spring Boot project using Flyway or Liquibase -- new migration file naming/ordering, never editing an already-applied migration, and verifying with flywayMigrate/flywayValidate or the project's configured equivalent."
triggers:
  - "add a Flyway migration for this new column"
  - "write a Liquibase changeset for this schema change"
  - "review this Flyway migration before I apply it"
  - "add a versioned migration to this Spring Boot project"
  - "fix this failing flywayValidate check"
  - "add a migration to rename this table safely"
metadata:
  origin: authored
  category: migrate
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Java/Kotlin + Spring database migrations (Flyway / Liquibase)

Write or review a versioned schema migration for a Spring Boot project
using Flyway or Liquibase. Scoped specifically to authoring/reviewing a
new migration file and verifying it against a real migration command —
not general schema design or ORM entity mapping, which belong to
`java-kotlin-spring-implementation`.

## Workflow

### Step 1: Discover the project's migration tool and conventions

1. Check `build.gradle(.kts)`/`pom.xml` and `application.yml`/
   `application.properties` for whether the project uses Flyway
   (`flyway-core`, `spring.flyway.*`) or Liquibase
   (`liquibase-core`, `spring.liquibase.*`) — do not introduce the other
   tool into a project that has already standardized on one.
2. Find the migration directory: Flyway's default
   `src/main/resources/db/migration`, or Liquibase's changelog root
   (often `src/main/resources/db/changelog`) and its master changelog
   file. Match the project's own path if it differs from the default.
3. Read the last 2-3 existing migration files for naming convention,
   whether raw SQL or a Liquibase XML/YAML/SQL changeset format is used,
   and how destructive changes (drops, renames) have been handled before
   in this project.
4. Note the current highest version number/checksum state — a new
   migration must sort after every already-applied one.

### Step 2: Design the migration

- One logical schema change per migration file — do not bundle an
  unrelated change into the same file because it's convenient.
- For Flyway: name the file `V<next-number>__<description>.sql`
  (versioned, sortable) matching the project's numbering scheme exactly
  (sequential integers, or a timestamp-based scheme — check what the
  last few files used); a repeatable migration uses the `R__` prefix
  instead, only when the project already uses repeatable migrations for
  that kind of object (views, stored procedures).
- For Liquibase: add a new changeset with a unique `id`/`author` to the
  appropriate changelog file (or a new included file, per the project's
  own layout), referenced from the master changelog in the correct order.
- For a renaming or destructive change (drop column/table), plan an
  expand-and-contract sequence across multiple migrations when the
  project's deployment process requires zero-downtime compatibility
  (add the new column, backfill, migrate reads/writes, drop the old
  column in a later migration) rather than a single destructive
  statement, unless the project's own convention already accepts direct
  destructive migrations (check how prior migrations handled a drop).

### Step 3: Write the migration

1. Create the new file at the next version/changeset id — never reuse or
   renumber an existing one.
2. Write the schema change explicitly (`ALTER TABLE ... ADD COLUMN`,
   `CREATE INDEX`, a Liquibase `<addColumn>`/`<createIndex>` changeset)
   rather than a generated diff you have not read.
3. Add a rollback/undo section only when the project's tool and
   convention already use one (Flyway Teams' undo migrations, a
   Liquibase `<rollback>` block) — do not assume every project has this.

### Step 4: Verify

```bash
./gradlew flywayMigrate flywayValidate     # or: mvn flyway:migrate flyway:validate
# or, for Liquibase:
./gradlew update                            # or: mvn liquibase:update
```

Use whichever the project's own build tool and migration tool actually
are — check the project's configured task/goal names rather than
assuming these exact ones. Run against a local/test database, never
directly against production.

### Step 5: Report

```
Added: V12__add_order_status_index.sql
  - CREATE INDEX idx_order_status ON orders(status)
  - flywayMigrate/flywayValidate both pass against local db
```

## Rules

- NEVER edit an already-applied migration file (e.g.
  `V7__add_users_table.sql` once it has run in any environment) —
  Flyway/Liquibase detect a changed checksum on an applied migration and
  fail validation; add a new migration instead, even to fix a mistake in
  an earlier one.
- ALWAYS name/order a new migration so it sorts strictly after every
  already-applied migration, matching the project's existing numbering
  scheme.
- ALWAYS verify against a real migration command
  (`flywayMigrate`/`flywayValidate` or the project's Liquibase
  equivalent) before reporting done — never claim a migration is correct
  from reading the SQL alone.
- Prefer an expand-and-contract sequence over a single destructive
  statement for a renaming/dropping change when the project's
  deployment process requires backward compatibility during rollout.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll just edit V4__add_customer_table.sql directly to fix the typo, it's a small change" | Editing an already-applied migration changes its checksum; Flyway/Liquibase will fail validation for every environment that already applied the old version. Add a new migration instead |
| "I'll rename the column directly with a single ALTER TABLE, it's simpler than expand-and-contract" | A direct rename breaks any code still deployed against the old column name during a rolling deploy; use expand-and-contract when the project needs zero-downtime compatibility |
| "The SQL looks right, I don't need to actually run flywayMigrate" | A migration that looks correct can still fail on the real database (a constraint conflict, a syntax difference) -- verify against a real migration command before reporting done |
| "I'll reuse V12 since the one I looked at didn't apply yet in this environment" | Migration numbering must be globally consistent across every environment the project ships to, not just the one you're looking at; always take the next unused number |

## Verification

Do not report the work done until all of the following hold:

- The new migration file's version/changeset id sorts after every
  already-applied migration and follows the project's own naming
  convention.
- No already-applied migration file was modified.
- The configured migrate/validate command (Flyway or Liquibase) was run
  against a local/test database and passed.
- A renaming/destructive change either follows the project's existing
  expand-and-contract pattern or the report states explicitly why a
  direct change is safe here.
