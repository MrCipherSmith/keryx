# gdskills Verify Implementation Plan

Version: 0.1.0

## Goal

Implement the first production slice of `gd-metapro skills verify` and the alias `gd-metapro skill-verify-skill`.

The verifier must check whether a canonical project skill still has enough current evidence to be trusted by an agent.

## Scope

Commands:

```bash
gd-metapro skills verify <skill-or-target>
gd-metapro skill-verify-skill <skill-or-target>
```

The first slice verifies:

- project-skill package resolution;
- required files;
- `SKILL.md` metadata;
- registered target existence;
- project-skill registry entry;
- availability of gdgraph, gdctx, gdwiki, Code Health and Documentation Memory artifacts;
- report persistence under `.metaproject/data/gdskills/reports/`;
- `verification.md` update in the project-skill package.

## Non-goals

- Deep semantic comparison of architecture claims against AST.
- Automatic skill learning or changelog mutation from verification findings.
- Applying proposed skill patches.
- Running expensive health/test/graph commands automatically.

## Status Model

| Status | Meaning |
|---|---|
| `fresh` | Required package files and target are present, and at least one project evidence source is available. |
| `needs-review` | Required files exist, but evidence is incomplete or the skill has never been verified. |
| `stale` | Target or important registry/package data is missing. |
| `blocked` | The skill package cannot be resolved or read. |

## Verification

- `bun run check`;
- `gd-metapro skills verify <module>/<skill>`;
- `gd-metapro skill-verify-skill <module>/<skill>`;
- inspect generated report and package `verification.md`.
