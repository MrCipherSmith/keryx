# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `gd-metapro flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `gd-metapro flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A standalone `gd-metapro rules sync` command syncs existing root `AGENTS.md`/`CLAUDE.md` files into `.metaproject/rules`.
- AC2: `gd-metapro init` and `gd-metapro update` use the same rule-sync mechanism as the standalone command.
- AC3: Imported root-entrypoint rule files include explicit high-priority metadata, source provenance, and version.
- AC4: `.metaproject/index.md` lists imported root rules as high priority and keeps `.metaproject/index.md` as the strict routing entrypoint for agents.
- AC5: Automated tests cover the command and template behavior, and project verification passes.
- AC6: When no root agent entrypoint exists, rule sync creates both `AGENTS.md` and `CLAUDE.md`.
- AC7: A manual `gd-metapro rules distill` command and bundled agent-facing skill decompose large root entrypoints into high-priority rules, project skills, and compact root entrypoints.
