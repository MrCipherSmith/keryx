# gdskills Status Implementation Plan

Version: 0.1.0

## Goal

Make `gd-metapro skills status` useful for project-skill lifecycle operations.

The command must be a fast read-only summary for agents and users before they decide whether to create, verify, learn or apply project-skill updates.

## Scope

Commands:

```bash
gd-metapro skills status
gd-metapro skills status --json
```

The first status slice reports:

- gdskills initialization and enabled state;
- install profile and bundled skill count;
- installed skills root and catalog path;
- registered project-skill count;
- project skills without verification reports;
- verification report status counts;
- latest verification timestamp;
- learning proposal counts: total, pending and applied.

## Non-goals

- Running verification automatically.
- Parsing deep semantic freshness.
- Rendering a full per-skill table by default.
- Mutating reports, proposals, skills or registry.

## Verification

- `bun run check`;
- `gd-metapro skills status`;
- `gd-metapro skills status --json`;
- run status in a smoke project with project-skills, reports and proposals.
