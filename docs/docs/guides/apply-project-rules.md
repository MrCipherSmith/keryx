# Make agents follow my project's own rules

**The problem:** your repository has its own rules — design tokens, store
conventions, test doctrine — and an agent writing code or tests reads the
generic ones that ship with keryx, or none at all.

**What you get:** your rules and your implementation skills are resolved first,
the bundled ones second, and the worker has to cite what it read. A task that
skips a rule is flagged, or refused if you ask for that.

The commands and output below were run in a fresh project with one rule file.

## 1. Bring your rules in

```console
$ keryx skills import --rules rules-src
# skills import --rules

imported: 1

- imported `styling.mdc` → .metaproject/rules/project/styling.mdc
```

`--rules` takes a directory of `.mdc` / `.md` files. They are copied into
`.metaproject/rules/project/`, which is where a project rule is found first. To
read a folder in place instead of copying it, add `--link`. Refresh copies with
`keryx skills update --rules`, and drop one with `keryx skills remove --rule
<ref>`.

A rule's front matter decides when it applies:

```text
---
globs: ["src/**/*.tsx"]
alwaysApply: false
---
Use design tokens, never hex.
```

## 2. See what a worker has to read

```console
$ keryx skills resolve-context --files src/a.tsx --for implement --task-type ui_component
# skills resolve-context (implement)

Files: src/a.tsx
Budget: 81 of 131072 bytes (default)

## must_read (7)
- .metaproject/rules/project/styling.mdc — project rule, glob:src/**/*.tsx, 81 bytes, sha256 cbaff288f109
- .metaproject/rules/core/tdd-workflow.mdc — bundled rule, bundled-default, 3891 bytes, sha256 3d43be89e4fc
…

## on_demand (0)
```

The project rule is listed before every bundled one. The resolver reads files on
disk only — no model is asked — and `--for test` and `--for review` give the
matching lists. The result is also written to
`.metaproject/data/skills/project-context/last.json`.

A project **skill** takes part the same way, as a supplement to the built-in
`task-implementer` and `tests-creator`. Give it a name that no bundled skill
uses.

## 3. Choose how strict to be

Project content that does not fit the size cap moves from `must_read` to
`on_demand`, and the report says so. The cap is a signal to raise it, not to
cut rules:

```console
$ keryx skills resolve-context --files src/a.tsx --for implement --max-bytes 4096
Budget: 81 of 4096 bytes (flag)
```

Set both the cap and the strictness in `.metaproject/tasks.config.json`:

```json
{ "gdskills": { "projectContext": { "enforcement": "warn", "maxBytes": 131072 } } }
```

`warn` (the default) records a miss in the flow journal and lets the task
close. `block` refuses it. In the TUI the same two settings are the **Project
rules check** row of `/settings`, and `/projectctx` opens the last result.

## 4. Check the worker's work

A worker returns a `project_context_applied` list in its result: the path and
`sha256` of each `must_read` file it read. Close the task against it:

```console
$ keryx flow task done 461 T2 --result result.json --resolved .metaproject/data/skills/project-context/last.json
```

Two things count as a failure: a `must_read` file the result does not cite, and
a cited file whose hash changed after it was resolved. Under `block`, an
`implement` or `test` task with no result is refused too;
`--disposition skipped --reason "…"` is the way out.

## Where to go next

- [CLI reference](../cli-reference.md#project-rules-and-implementation-skills) —
  every flag and the config table.
- [Give an agent context about my repository](give-an-agent-context.md) — the
  index these rules sit under.
