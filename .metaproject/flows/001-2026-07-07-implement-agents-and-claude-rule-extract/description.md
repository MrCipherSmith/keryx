# Implement AGENTS and CLAUDE rule extraction into Metaproject

Status: ready for freeze
Source: user description

## Problem

`gd-metapro init` and `gd-metapro update` already add a Metaproject reference
to root agent entrypoints, but the rule extraction is implicit and tied to
init/update internals. There is no standalone command that can resync
`AGENTS.md`/`CLAUDE.md` into `.metaproject/rules`, and `.metaproject/index.md`
does not clearly mark imported root instructions as high-priority rules.

This makes the local-first contract weaker than intended: root entrypoints can
grow into large context files, while the desired behavior is that they strictly
point agents to `.metaproject/index.md`, where rules, skills, and module data are
discoverable without loading everything.

## Expected Outcome

- A reusable rules sync mechanism exists and is exposed as a CLI command.
- `init` and `update` use the same mechanism.
- Imported `AGENTS.md`/`CLAUDE.md` rules are generated in `.metaproject/rules`
  with explicit high-priority metadata and entrypoint-source provenance.
- `.metaproject/index.md` lists imported root rules as high priority and keeps
  the local-first routing to skills/modules.
- Root `AGENTS.md`/`CLAUDE.md` retain the strict link to `.metaproject/index.md`.
- Tests cover the standalone command and the init/update integration.

## Out of Scope

- GitHub issue creation.
- Replacing the full rules engine with semantic Markdown splitting.
- Changing external/global Codex/Claude skill installation behavior.
