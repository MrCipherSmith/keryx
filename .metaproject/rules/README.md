# Project Rules

This directory holds imported entrypoint rules and the rule layers keryx installs. Do not treat
them the same way.

## Imported entrypoint rules (this directory)

The `.md` files here (e.g. `agents-md.md`, `claude-md.md`) are repository-level instructions
imported from root agent entrypoints such as `AGENTS.md` or `CLAUDE.md`.

- treat files here as high-priority agent-readable mirrors of root instructions;
- update the root entrypoint first when changing project-wide instructions;
- rerun `keryx rules sync`, `keryx init`, or `keryx update` to resync imported rule files.

## Rule layers keryx installs

| Folder | Holds |
|---|---|
| `process/` | Agent conduct (mandatory for every agent) and engineering procedures |
| `core/` | Language-neutral coding principles |
| `stacks/<pack>/` | Language and framework rules from the stack packs this project uses |
| `activity/` | How to apply the layers above when implementing, testing or reviewing |
| `project/` | This project's own rules; `project/<layer>/<name>.mdc` is read in place of keryx's `<layer>/<name>.mdc` |

`process/agent-conduct.mdc` is installed for every project. The other layers come with the
skills module. A layer the installed keryx version does not ship yet has no folder.

## Core rule library (`core/*.mdc`)

`core/*.mdc` (and every procedure under `process/`) is an on-demand rule library, not something loaded automatically. A rule file is
read only when a skill or `routing.md` cites it by path.

- `alwaysApply` and `globs` in each rule's frontmatter are Cursor-format metadata for Cursor's
  own auto-attach behavior; keryx itself does not read or act on either field;
- a stack-specific rule (e.g. `nestjs-dto.mdc`, `mobx-store-template.mdc`) declares the stack(s)
  it applies to via a `stack_requires` frontmatter key, using the same tag vocabulary as a
  skill's `metadata.stack_requires`; it is only relevant to projects on that stack.

## Updates

- the bundled tree (`src/gdskills/bundled/rules/<layer>/`) is the source of truth — `core/`,
  `process/` and `activity/` here are installed mirrors, and `keryx init`/`keryx update`
  overwrite them wholesale on install; put your own changes in `project/`;
- a rule retired from the bundled tree is removed from here too when it is an unmodified shipped
  copy; otherwise it is kept (with a warning that says why — edited, not a regular file, oversized,
  or unreadable/unremovable), since discarding it silently could lose your changes or hide a
  filesystem problem;
- a rule that moved from `core/` to another layer is installed at its new path, and its old
  `core/` copy is removed the same way once the new path is in place: an unmodified shipped copy
  goes, an edited one stays and the warning names the new path to carry your edits to.
- a project override of a moved rule follows it: `project/core/<name>.mdc` is moved to
  `project/<layer>/<name>.mdc`, the slot read now; when both exist, the old one is kept and reported.
