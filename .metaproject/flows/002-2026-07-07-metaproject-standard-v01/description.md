# Implement Metaproject Standard v0.1: standard command + manifest fields

Status: formalized
Source: docs/requirements/metaproject-standard/ (user-provided standard package)

## Problem

The repository now ships a draft **Metaproject Standard v0.1** under
`docs/requirements/metaproject-standard/` (README, prd, specification, profiles,
agent-protocol, ci-protocol, artifact-lifecycle, and two JSON schemas). It
declares `gd-metapro` as the **reference implementation**, but the code does not
yet implement the standard's contract:

- `metaproject.json` is missing the schema-**required** `standardVersion` field
  (and the recommended `profiles`/`capabilities`), so the reference
  implementation's own manifest fails `schemas/metaproject.schema.json`.
- The standard/CI protocols reference `gd-metapro standard validate`,
  `standard doctor`, and `standard capabilities`, which do not exist.

## Expected Outcome

- Generated `metaproject.json` (via `init` and `update`) includes
  `standardVersion` plus `profiles`, and validates against
  `docs/requirements/metaproject-standard/schemas/metaproject.schema.json`.
- New `gd-metapro standard validate | doctor | capabilities` commands exist,
  wired into the CLI dispatcher and help.
  - `validate`: checks required files, manifest-vs-schema, declared paths,
    enabled-module manifests, root entrypoints link `.metaproject/index.md`, and
    profile requirements; non-zero exit on violations.
  - `doctor`: actionable diagnostics with fix hints.
  - `capabilities`: prints standard version, profiles, enabled modules and their
    commands/capabilities from the manifest.
- The reference implementation validates its own `.metaproject/` cleanly.
- Tests cover the new command and manifest fields; `bun run check` is green.
- Developer docs (cli-reference, README) and the standard's status notes reflect
  the now-implemented commands.

## Out of Scope

- Freezing a public v1.0 standard contract.
- Per-module annex standardization (gdgraph/health/testing/etc. formats stay as
  their existing specs).
- New optional profiles (`ide`, `enterprise`, `multi-repo`).
- Rewriting existing module behavior; only additive standard surface.
