# Acceptance Criteria

Each is verifiable by a named test in the working tree, never by the installed
binary.

- AC1: `keryx serve-mcp` is routed from the verb map in `src/cli.ts` and reaches
  the code path `keryx mcp serve` reached. The existing `mcp serve` tests are
  retargeted at it and pass unchanged in substance.

- AC2: `keryx integrate <editor>` writes the same client config that
  `keryx mcp install --runtime <editor>` wrote, byte for byte, for every runtime
  the old command accepted (cursor, claude, opencode, vscode, generic, all).
  `--dry-run` still prints the planned change and writes nothing.

- AC3: `keryx integrate --remove <editor>` removes the same config that
  `keryx mcp uninstall --runtime <editor>` removed, for the same runtimes.

- AC4: `keryx mcp serve`, `keryx mcp install`, `keryx mcp uninstall` and bare
  `keryx mcp` all still do what they did, and each prints exactly ONE line
  naming its replacement. Asserted as one: a notice repeated per sub-operation
  trains the reader to ignore it. Exit codes unchanged — a script that ran
  before runs now.

- AC5: `/integrations` opens what `/mcp` opened, and `/mcp` still opens it,
  marked deprecated in the command list. `/mcp` is NOT repointed at the consumer
  in this flow: the consumer does not exist yet, and a slash command pointing at
  nothing is worse than one pointing at the old thing.

- AC6: `src/commands/agent-commands.confusable.test.ts` stays green, and adding
  `/mcps` to the registry still fails the build — verified by mutation, not by
  reading the test.

- AC7: No file under `docs/`, `README.md` or `.metaproject/` instructs a reader
  to run `keryx mcp serve`, `keryx mcp install` or `keryx mcp uninstall` as the
  current spelling. Mapping tables recording "was → is" are exempt by shape.
  Enforced by a test, so the next writer cannot reintroduce the old spelling
  silently.

- AC8: The reference count is closed rather than sampled. The baseline is
  measured against `HEAD` with `git grep`, so it covers tracked files only:
  `keryx mcp serve` 65, `install` 39, `uninstall` 12 — 116 total, of which 93
  are in `docs/` + `README.md` + `.metaproject/` and 25 in `src/`. The final
  report states how many were changed and how many were deliberately left, and
  the two sum to the in-scope figure.

  Corrected 2026-09-09. The frozen text said 414 (serve 266, install 132,
  uninstall 16). That number was wrong: it was taken with `keryx ctx rg`, which
  transcribes every routed search verbatim into `.metaproject/data/gdctx/` — a
  gitignored log directory that 62 files of which now contain the phrase. The
  count grew each time it was taken, so it was never reproducible, not even on
  the same commit minutes later. A subagent measuring independently reported 93
  in scope and refused to reconcile to 414, which is how the error surfaced.

- AC9: Every acceptance check above runs the code under change. Any step that
  shells out to the installed `keryx` proves nothing (memory:
  `stale-installed-keryx-binary`), and the final report names which checks ran
  against the working tree.
