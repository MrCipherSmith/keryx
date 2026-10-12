# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx doctor [--json]` exists as a top-level command: one page listing, each as ok/warn/fail with a fix hint — keryx version and update availability, Bun version vs the documented floor, ripgrep on PATH, OS sandbox launcher, providers with a credential present (names only, never values), MCP servers and their trust state (via the existing mcp doctor), integrations drift (via integrations doctor), Metaproject Standard warnings (via standard doctor), stale `.claude/worktrees` entries, graph/wiki freshness; exit 0 when nothing is `fail`; `--json` emits `{checks:[{id,status,detail,fix?}]}`; runs on a fresh clone in under 3 s. A test covers the JSON shape and the exit codes.
- AC2: `/doctor` in `keryx shell` (readline and TUI) prints the same checks inside the session, and the TUI help/command list includes it.
- AC3: An unknown command or subcommand prints one line `Unknown command: <x>. Did you mean: <up to 3 suggestions>? Run \`keryx --help\` for the list.` to stderr with exit 1, never the full usage; suggestions come from edit distance ≤ 2 over the known commands (and subcommands of the parent group); the pinned help fixtures (flow 303 AC5 tests) and `docs/requirements/backlog.md` item 4 are respected — the flat usage is unchanged and `keryx --help`/bare `keryx` behave as before. Tests cover `keryx docto`, `keryx mcp lst`, and a nonsense word with no suggestion.
- AC4: `keryx mcp list` exits 0 when the servers it could read are listed; problems in foreign configs (e.g. a malformed `~/.cursor/mcp.json`) print under a `warnings:` block; exit 1 only when the project's own config is unreadable. Tests cover both.
- AC5: `keryx memory search` lexical mode applies stemming/normalisation so `release` matches `released`/`releases`; on zero hits it prints one hint line: `--semantic` when an embeddings index exists, otherwise how to build one (`keryx memory index --embeddings`). Tests cover the stem match and both hint variants.
- AC6: `keryx health run` on the keryx repository itself reports the `tests` source as `available` (not `missing`); the root cause in `src/health/sources/tests.ts` detection (or `compatibleReportForHealth`/`hasTestFiles`) is fixed and named in the CHANGELOG; when a source is `missing` the report line says which check failed. A test reproduces the previous false `missing`.
- AC7: bare `keryx providers` prints the same output as `keryx providers status`; `keryx providers --help` still prints usage. Test covers it.
- AC8: typecheck, lint and every touched test file pass; docs updated (`docs/docs/cli-reference.md` or the relevant page gains `doctor`, `/doctor` and the new exit-code semantics); CHANGELOG entry and package.json bump.
