# Testing Module requirements

Version: 0.2.0
Status: implemented (MVP)

`Testing Module` is the Metaproject layer for project test context, normalized
test execution reports, and agent-facing test intelligence.

The module owns test discovery, context generation, test execution reporting,
and changed-scope test selection. `Code Health` consumes its normalized reports
as a quality source instead of duplicating runner logic.

## Status

MVP implementation is available in `src/testing`.

MVP focus:

- analyze the host project at `gd-metapro init` when enabled;
- detect test stack, scripts, configs, CI, test files, and testing conventions;
- write hybrid context: skill summary, data artifacts, and wiki pages when wiki is enabled;
- provide `gd-metapro test init|analyze|run|status|context|explain|related|report`;
- write JSON as source of truth, Markdown summary for agents, raw logs as optional artifacts;
- support post-commit context refresh and pre-push changed-scope gate as separate opt-in hooks.

## Documents

- [brainstorm.md](brainstorm.md) - brainstorming and interviewer decisions.
- [prd.md](prd.md) - product requirements and scenarios.
- [specification.md](specification.md) - technical specification, CLI, storage and integrations.

## Related Modules

- `gdgraph` - related test discovery and impact context.
- `gdctx` - compact raw test logs and command output.
- `Code Health` - consumes `.metaproject/data/testing/artifacts/latest.json`.
- `gdskills` - consumes test failures via `gd-metapro skills learn --from-test`.
- `Documentation Memory` - stores repeated testing lessons and flaky patterns.
- `gdwiki` - stores long-lived human-readable testing conventions.

## CLI Namespace

Namespace: `gd-metapro test`.
