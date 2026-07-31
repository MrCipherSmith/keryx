# harness command descriptors + wiki enrich + module --json

Status: formalized
Source: user description (2026-07-20), re-scoped 2026-07-30

## Problem

`src/standard/command-registry.ts` was created by this flow's first item and
carries 16 curated descriptors. Two of the original items remain, and a third
problem has appeared since.

1. **`keryx modules` has no `--json`.** Every other agent-facing surface can emit
   structured output; module state cannot, so an agent has to parse a
   human-formatted table to learn which modules are enabled.

2. **The registry does not cover the maintenance commands.** `gdgraph build`,
   `wiki collect`, `wiki check-links`, `test analyze`, `test status`,
   `memory index`, `ctx status`, `status` and `modules status` are all
   agent-facing and all absent. An agent asked to bring a project up has no
   machine-readable way to learn they exist.

3. **Nothing stops the gap reopening.** The registry is a hand-curated literal
   with no coverage guard, so a command added to the CLI silently fails to
   appear. That is exactly how gap 2 arose.

Why now: `docs/requirements/keryx-remote-entry` and
`docs/requirements/keryx-telegram-transport` both specify that the remote
maintenance surface is *projected from this registry*, and that a command absent
from it is not invocable. Both packages record extending the registry as a
stated dependency. Until it covers the maintenance commands, the remote surface
cannot offer them.

## Expected Outcome

- `keryx modules --json` emits deterministic structured module state.
- The registry covers every agent-facing maintenance command, with accurate
  `read`, `model` and `json` flags.
- A coverage test fails when an agent-facing command exists without a
  descriptor, so the gap cannot silently reopen.
- `keryx commands --json` stays byte-stable and deterministic.

## Out of Scope

- Implementing the remote maintenance surface itself (that is R4 / Remote Entry).
- Descriptors for interactive or dangerous commands that should not be
  agent-callable (`shell`, `init`, `update`, `harness exec`).
- Changing any command's behaviour. This flow describes and exposes; it does not
  alter what commands do.
