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
close. `block` refuses it. In the TUI, the **Project rules check** row of
`/settings` switches the mode and shows the cap, and `/projectctx` opens the
last result.

## 4. Check the worker's work

A worker returns a `project_context_applied` list in its result: the path and
`sha256` of each `must_read` file it read. Close the task against it:

```console
$ keryx flow task done 461 T2 --result result.json --resolved .metaproject/data/skills/project-context/last.json
```

Two things count as a failure: a `must_read` file the result does not cite, and
a cited file whose hash changed after it was resolved. Under `block`, an
`implement` or `test` task with no result is refused too;
`--disposition skipped --reason "…"` is the way out. A document promoted by a
declaration (section 5) has further checks, listed there.

## 5. Make a long document required only when the task needs it

A rule file is short and is read on every matching task. A document such as
`STYLING.md` or `THEMING.md` is long, and rules usually point at it by name
(``Follow `STYLING.md` for classes``). Left alone, such a document is listed
`on_demand`, which no worker is checked on. You can declare when a document
becomes required, and for which part of it.

### Declare it

Write `.metaproject/rules/project/references.json`. It is a separate file
because rules are copied byte for byte and `keryx skills update --rules`
overwrites them.

```json
{
  "schema": 1,
  "references": [
    {
      "path": "STYLING.md",
      "when": {
        "globs": ["src/**/*.css", "src/**/*.tsx"],
        "keywords": ["className", "tailwind", "spacing"]
      },
      "anchor": "Class conventions",
      "description": "Class naming, spacing and variants. Read before adding or changing className, CSS or inline style."
    },
    {
      "path": "THEMING.md",
      "when": { "globs": ["src/theme/**"], "keywords": ["theme", "dark mode", "colour"] },
      "anchor": "Tokens",
      "description": "Theme tokens and dark mode. Read before adding a colour or touching a theme."
    }
  ]
}
```

- `path` is relative to the project root, with `/` separators, and stays inside
  it.
- `when` needs at least one glob or keyword. A glob is matched against the task's
  files, as a rule's `globs` are.
- A keyword is matched against the task text as a whole word, ignoring case. A
  keyword may be several words (`dark mode`).
- `anchor` (optional) is a heading in the document. Only that section is
  required: from the heading to the next heading of the same or a higher level,
  not counting headings inside fenced code. The heading matches by its text or
  its slug, and the first match wins. Without `anchor` the whole file is required.
- `description` is shown next to the entry, so a worker can see why it is there.
- A property that is not listed here is an error.
- Declare each document once, with one `anchor`. Two entries for the same path
  (`STYLING.md` and `./STYLING.md` count as the same path) make the file
  invalid, and the error names both entries.

A missing `references.json` means no declarations. A malformed one does not stop
anything: no reference is promoted, the resolver prints a warning, and the task
carries on. The file is also covered by a JSON schema,
`docs/requirements/keryx-conditional-reads/schemas/references.schema.json`.

### Resolve against the task

Pass the task text with `--task-text`. It is cut at 4000 characters, and the cut
text is what `last.json` records. When the text is cut and a declaration has
keywords, the resolve warns that a keyword after the cut cannot promote a
reference. A task that edits `src/button.tsx`:

```console
$ keryx skills resolve-context --files src/button.tsx --for implement \
    --task-text "Add a loading spinner to the Button"
Budget: 462 of 131072 bytes (default)

## must_read (2)
- .metaproject/rules/project/styling.mdc — project rule, glob:src/**/*.tsx, 113 bytes, sha256 65a5c6fe816c
- STYLING.md — project contract, condition:glob:src/**/*.tsx, 438 bytes, sha256 3b473b6d9c0e (anchor "Class conventions", section 349 bytes)

## on_demand (1)
- THEMING.md — project contract, declared, 152 bytes, sha256 169fe095b433 (anchor "Tokens", section 141 bytes)
```

`STYLING.md` moved to `must_read` because the file matches `src/**/*.tsx`. The
reason, `condition:glob:<glob>` or `condition:keyword:<word>`, says which
condition fired. `THEMING.md` stayed `on_demand`, reason `declared`.
A task on `src/session.ts` with the text "Let the user pick a dark mode" promotes
`THEMING.md` instead, with reason `condition:keyword:dark mode`. A task on the same file with
the text "Fix the token refresh race" promotes neither.

Details that can surprise you:

- The byte count of a promoted document is the size of its section, or of the
  file when there is no anchor. The size cap never moves a promoted document back
  to `on_demand`; it prints a warning that the cap is exceeded instead, and the
  budget line includes the promoted bytes.
- An `anchor` that is not found falls back to the whole file, with a warning.
- A declared file that is missing, outside the project, larger than 262144 bytes,
  or already listed as a rule is left out, with a warning.
- When a `references.json` exists, the result also lists `undeclared`: `.md`
  documents that a project rule names but that have no declaration. A cited
  `.mdc` file or a file under the rules folder is another rule and is not listed
  there. A rule may spell the path `./STYLING.md`; it is the same document as
  `STYLING.md`.

### What the worker must return

For a promoted document the worker's `project_context_applied` item carries two
more fields, `anchor` and `summary`:

```json
{
  "path": "STYLING.md",
  "sha256": "3b473b6d9c0e…",
  "how": "read",
  "anchor": "Class conventions",
  "summary": "Class names go through the cn helper, spacing uses the Tailwind scale, variants sit in a cva definition beside the component."
}
```

`sha256` is the hash of the whole file, as printed by `resolve-context`, even
when only a section was promoted. The checks run when the task is closed, or by
hand with `keryx skills contracts validate result.json --schema
task-implementer-output --resolved last.json`. For an item promoted by a
condition, a miss is recorded when:

1. `how` is `n/a`.
2. `anchor` differs from the declared one.
3. `summary` is shorter than 40 characters.
4. `summary` shares fewer than three distinct words of five or more letters
   with the section (or all of them, if the section holds fewer than three
   such words). Words in any script count.

A file that changed after it was resolved is counted separately, as drift. A
miss is one line, and the headline counts both:

```text
project context: 1 miss(es), 0 drifted (enforcement warn)
- project context miss: STYLING.md (condition:glob:src/**/*.tsx) has a summary that shares 0 distinct word(s) of 5 or more letters with the section "Class conventions"; 2 required. Write the summary in the wording of the text you read
```

Under `warn` this exits 0 and the task closes; under `block` it exits 1, the
message goes to stderr, and `keryx flow task done` refuses.

### Check the declarations

```console
$ keryx skills references check
```

It reads `references.json` and every rule in `.metaproject/rules/project/`, and
ends with `N errors, M warnings`. It exits 1 on an error:

| Finding | Level |
|---------|-------|
| `invalid-file`, `document-missing`, `document-outside-root`, `document-not-file`, `document-too-large`, `document-unreadable`, `anchor-not-found` | error |
| `description-short` (under 20 characters), `keyword-short` (under 4) | warning |
| `unused-declaration` (no project rule names the document), `undeclared-citation` (a rule names a document with no declaration), `rule-unreadable` | warning |

A missing `references.json` is not an error. `--json` prints the same findings
as JSON. The citation scan looks for backticked `X.md` names in project rules
only: a rule imported with `--link` is not scanned, and neither are bundled
rules.

To start a file, `keryx skills references suggest` prints a skeleton for every
document that a project rule names and `references.json` does not declare. It
writes nothing. Copy the entries you want into `references.json`, fill in
`description` and `when`, choose an `anchor` from `anchorCandidates`, and delete
`anchorCandidates` and `bytes`, which the loader rejects as unknown properties.
Delete an empty `globs` or `keywords` list as well; an empty one is an error.
`keryx skills import
--rules` ends with a reminder when it finds such documents.

```console
$ keryx skills references suggest
{
  "schema": 1,
  "references": [
    {
      "path": "STYLING.md",
      "bytes": 438,
      "anchorCandidates": ["Styling", "Class conventions", "Cascade", "Inline style"],
      "description": "",
      "when": { "globs": [], "keywords": [] }
    }
  ]
}
```

In the TUI, the sidebar line `refs <promoted>/<declared>` and the References tab
of `/projectctx` (`/projectctx refs`) show the same state.

### What this does not prove

- **The proof is a proxy.** Keryx cannot see what an agent opened. A summary
  passes when it has 40 characters and shares three distinctive words with the
  section, and an agent that read nothing can sometimes do that: two sections
  of a style guide easily share words such as "never" and "component". The check
  catches a missing, empty or generic answer. It does not show that the agent
  read the section.
- **Breadth decides how often a document is required.** A glob such as `src/**`
  or a keyword such as `component` promotes the document on most tasks. Use
  narrow conditions, and let `references check` flag short keywords.
- **A promoted document is never dropped for size.** If several are promoted
  on one task, all of them are required and the cap only produces a warning.
- **A malformed `references.json` turns the feature off** for that run. It warns
  and does not block, so read the warnings.

## Where to go next

- [CLI reference](../cli-reference.md#project-rules-and-implementation-skills) —
  every flag and the config table.
- [Give an agent context about my repository](give-an-agent-context.md) — the
  index these rules sit under.
