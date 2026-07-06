# gdskills Learn Implementation Plan

Version: 0.2.0

## Goal

Implement the first safe slice of `gd-metapro skills learn`.

The command must turn review, test, failure, health or memory evidence into an auditable learning proposal for one or more project skills.

## Scope

Commands:

```bash
gd-metapro skills learn --from-review <path> --skill <module>/<skill>
gd-metapro skills learn --from-test <path> --skill <module>/<skill>
gd-metapro skills learn --from-failure <path> --skill <module>/<skill>
gd-metapro skills learn --from-health <path> --skill <module>/<skill>
gd-metapro skills learn --from-memory <path> --skill <module>/<skill>
```

The first slice:

- parses Markdown, text or JSON source files;
- extracts short candidate lessons;
- resolves affected project skill by explicit `--skill` or registry target matching;
- writes proposal JSON and Markdown;
- does not edit `SKILL.md` during proposal creation;
- applies a proposal only through explicit `gd-metapro skills learn apply <proposal.json>`;
- bumps skill patch version, updates `SKILL.md`, appends `skill-changelog.md` and writes `.applied.json`;
- blocks repeated application of the same proposal;
- records source type, source path, confidence, candidate lessons and suggested skill sections.

## Non-goals

- LLM-based semantic extraction.
- Auto-applying learned changes during proposal creation.
- Version bumping the project skill.
- Updating `skill-changelog.md`.
- Multi-skill batch application.

## Verification

- `bun run check`;
- create a smoke project skill;
- create a sample review report;
- run `gd-metapro skills learn --from-review <file> --skill <module>/<skill>`;
- run `gd-metapro skills learn apply <proposal.json>`;
- inspect proposal files.
