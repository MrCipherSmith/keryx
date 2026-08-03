# R4a: user-global project registry (keryx projects + init registration)

Status: formalized
Source: roadmap R4 (phase 1), first slice

## Problem

`keryx init` writes a `.metaproject/` into the directory it is run in. Nothing on
the machine records that it happened, so an install has no idea which projects it
was initialized in.

That is fine while the only entry point is a terminal already sitting in the
project. It stops being fine the moment anything addresses projects from
outside one:

- `docs/requirements/keryx-remote-entry` specifies a user-global project registry
  as the addressing key set a transport routes by (FR-11), and every other part
  of that surface depends on it.
- `docs/requirements/keryx-telegram-transport` 2.2.0 specifies that topics follow
  `keryx init` by reading this registry, and that the transport keeps no second
  list of projects.

Neither can be built without it. It is also useful on its own: it is the first
time an install can answer "where am I deployed".

## Expected Outcome

- A user-global registry records every project `keryx init` has initialized.
- It lives beside the existing user-global config (`auth.json`, `permissions.json`,
  `sandbox.json`), resolved cross-platform, and holds addressing only.
- It holds no credential material, and the schema forbids it.
- Registration is idempotent: re-running `keryx init` updates the record rather
  than creating a second one.
- A project whose path has disappeared is marked `missing` and retained; removal
  is an explicit operator action, because an unmounted disk is not an
  instruction to forget a project.
- `keryx projects list | register <path> | forget <id>` inspects and maintains it,
  with `--json` for machine consumers.
- The registry is not a second source of project truth: it answers which
  projects exist and how they are addressed, nothing else.

## Out of Scope

- `keryx serve`, the HTTP surface, and everything that consumes the registry
  remotely. This slice is the data and the CLI only.
- Transport bindings (Telegram topics). The schema reserves a field for them;
  nothing writes it yet.
- Migrating or discovering projects initialized before this exists. `keryx
  projects register <path>` is the explicit way to add one.
