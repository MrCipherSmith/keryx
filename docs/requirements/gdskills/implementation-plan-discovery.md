# gdskills Discovery Implementation Plan

Version: 0.1.0

## Goal

Add fast read-only discovery commands for registered project skills.

Agents need a cheap way to list available entity skills and inspect one skill before deciding whether to create, verify, learn, export or sync.

## Scope

Commands:

```bash
gd-metapro skills list
gd-metapro skills list --json
gd-metapro skills inspect <project-skill>
gd-metapro skills inspect <project-skill> --json
```

The first discovery slice:

- reads `.metaproject/metaproject.json`;
- lists registered project skills;
- resolves one skill by `module/name`, skill name, path or target;
- reports version, status, last verified and important package files;
- does not run verification or mutate project files.

## Verification

- `bun run check`;
- run list/inspect in an empty initialized project;
- run list/inspect in a smoke project with registered project skills.
