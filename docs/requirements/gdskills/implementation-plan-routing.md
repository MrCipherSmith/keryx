# gdskills Routing Implementation Plan

Version: 0.1.0

## Goal

Add a cheap project-skill router for agents.

Agents should be able to map a user request, file path, symbol or short task description to likely registered project skills before reading broad code context.

## Scope

Commands:

```bash
gd-metapro skills route <query-or-target>
gd-metapro skills route <query-or-target> --json
```

The first routing slice:

- reads `.metaproject/metaproject.json`;
- scores registered project skills by `module/name`, target, path, basename and token overlap;
- returns matching skills with reasons and next commands;
- does not run graph, ctx, verification or code reads;
- suggests `skills create` when no project skill matches.

## Verification

- `bun run check`;
- route against an empty initialized project;
- route against a smoke project with registered project skills;
- verify JSON output includes inspect/verify next commands.
