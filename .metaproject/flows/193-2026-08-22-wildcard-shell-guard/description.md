# shell-permission validation lets a bare "keryx *" wildcard through — defeats per-call approval for the entire CLI surface

Status: formalized
Source: https://github.com/MrCipherSmith/keryx/issues/390

## Problem

`validateShellPattern` (`src/lib/shell-permissions.ts`) already refuses a bare
`<verb> *` wildcard for known destructive verbs, but never added the harness's
own binary (`keryx`) to that guard — despite `keryx`'s subcommand surface
spanning trivial reads all the way to destructive/knowledge-mutating actions
(`wiki enrich --force`, `flow complete`, `security redact`, `workspace
archive`). A stored `"keryx *"` entry in `~/.local/share/keryx/permissions.json`
loads successfully and silently auto-approves every future `shell_exec(keryx
...)` call, forever, across every project and session — confirmed live and
documented in detail in issue #390.

## Expected Outcome

- `validateShellPattern` rejects a bare `keryx *` pattern the same way it
  already rejects other destructive-verb wildcards.
- The harness's own binary name is resolved dynamically (package name /
  `process.argv0`), not hardcoded, so a renamed or forked binary stays
  covered.
- Any bare single-word wildcard already present in a loaded
  `permissions.json` is surfaced to the user as an audit warning before the
  first auto-approve of a session — the same mechanism
  `loadShellPermissionsWithAudit` already uses for `rejected`/`tampered`
  patterns — rather than being silently trusted.

## Out of Scope

Fixing the SAC review bypass this wildcard makes trivial (issue #391) — that
is a separate flow (194). This flow only closes the wildcard-approval hole
itself.
