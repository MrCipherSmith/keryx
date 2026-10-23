# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- Every criterion ends with [verify: exec `<command>`],
  [verify: invariant `<command>`], [verify: judged] or
  [verify: none — <reason>].
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

DRAFT: not frozen. Waits for the operator. Test file names are proposals.

## Criteria

- AC1: A project file `.metaproject/rules/project/references.json` with `schema: 1` and a list of references (`path`, `when.globs`, `when.keywords`, `anchor`, `description`) is loaded; a committed JSON schema validates it; a declaration with neither globs nor keywords, an empty description or an absolute or escaping path is rejected with a message naming the entry. [verify: exec `bun test src/gdskills/references-config.test.ts`]
- AC2: Without a references file every resolve result, validator verdict and TUI line is byte-identical to flow 461 behaviour. [verify: exec `bun test src/gdskills/context-resolver.test.ts src/gdskills/resolved-context-check.test.ts`]
- AC3: `resolve-context` accepts the task text (CLI `--task-text`, and the same field in the MCP and flow-orchestrator call) and matches it against the declared keywords, cut to a stated limit. The last-resolve record keeps only the length of the task text given and whether it was cut, never the text itself (it may hold secrets; the file is not git-ignored); the matched reasons are already in the recorded result entries. [verify: exec `bun test src/gdskills/context-resolver.test.ts -t "task text"`]
- AC4: A declared reference whose glob matches any task file is resolved as `must_read`, with `reason` naming the glob, plus `anchor`, `description`, `section_bytes` and the sha256 of the whole file. [verify: exec `bun test src/gdskills/context-resolver.test.ts -t "glob promotes"`]
- AC5: A declared reference whose keyword occurs in the task text, case-insensitively and on a word boundary, is `must_read` with `reason` naming the keyword; a task matching neither stays `on_demand` and keeps its description, anchor and condition in the entry. [verify: exec `bun test src/gdskills/context-resolver.test.ts -t "keyword promotes"`]
- AC6: With an anchor the obligation and the budget are the section from the heading to the next heading of equal or higher level; a missing anchor makes the entry an error in `check` and falls back to the whole file with a warning at resolve time, never to silence. [verify: exec `bun test src/gdskills/references-section.test.ts`]
- AC7: A promoted reference is never dropped by the byte cap; when the cap is exceeded the resolver warns with the sizes and keeps the obligation. [verify: exec `bun test src/gdskills/context-resolver.test.ts -t "cap keeps promoted"`]
- AC8: Documents cited by a rule but not declared keep the flow 461 `on_demand` behaviour and are listed as undeclared in the resolve record. [verify: exec `bun test src/gdskills/context-resolver.test.ts -t "undeclared"`]
- AC9: The `project_context_applied` item schemas of task-implementer and tests-creator (and their synced copies) accept optional `anchor` and `summary` strings, keep the `how` enum unchanged, and still reject unknown properties; every result valid under flow 461 stays valid. [verify: exec `bun test src/gdskills/output-schema.test.ts`]
- AC10: For an entry promoted by a condition the validator requires the cited anchor to equal the declared one, a summary of at least 40 characters, and at least three distinct words of five or more letters that occur in the anchored section (as many as the section holds when it has fewer than three); each failure is reported as its own miss with the reason. [verify: exec `bun test src/gdskills/resolved-context-check.test.ts -t "summary"`]
- AC11: A cited path with a hash that differs from the resolver's pin is a miss, as in flow 461, and a promoted entry cited only with `how: n/a` is a miss. [verify: exec `bun test src/gdskills/resolved-context-check.test.ts -t "hash and n/a"`]
- AC12: Under `enforcement: warn` misses are printed and exit 0; under `block` `flow task done` and the standalone check exit 1 with the same lines. [verify: exec `bun test src/gdskills/resolved-context-check.test.ts src/flow/task-project-context.test.ts`]
- AC13: Editing a promoted document between resolve and validate is reported as drift, whatever its tier. [verify: exec `bun test src/gdskills/resolved-context-check.test.ts -t "drift"`]
- AC14: `keryx skills references check` reports, with exit 1 on errors: file missing or outside the root (error), anchor not found (error), description under 20 characters (warning), keyword under 4 characters (warning), citation without a declaration (warning), declaration no rule cites (warning). `--json` gives the same data. [verify: exec `bun test src/commands/skills-references.test.ts -t "check"`]
- AC15: `keryx skills references suggest` prints a JSON skeleton for every undeclared citation (path, size, candidate anchors from headings, empty description) and writes no file; `keryx skills import --rules` ends with the undeclared count and the command to run. [verify: exec `bun test src/commands/skills-references.test.ts -t "suggest"`]
- AC16: The TUI shows it: sidebar `ProjectCtx` gains `refs <promoted>/<declared>`; the `/projectctx` modal gets a References tab with condition, anchor, promotion status and reason per declaration, and the problems from check; `/projectctx refs` opens it; the tab updates on a new resolve; every state is in TUI-states.md and has a render test. [verify: exec `bun test src/tui/project-context-inspector.test.ts`]
- AC17: The orchestrator and worker skill instructions pass the task text to the resolver and say that a promoted entry requires path, sha256, anchor and a summary; the managed skill copies are in sync. [verify: exec `bun test src/gdskills/skill-sync.test.ts`]
- AC18: A fixture project with a STYLING- and a THEMING-like document of the real sizes runs three scenarios end to end: styling file touched (STYLING promoted, THEMING not), theme keyword only (THEMING promoted), unrelated task (neither); each validated with a correct result and with a fabricated-summary result. [verify: exec `bun test src/gdskills/conditional-reads.e2e.test.ts`]
- AC19: README, the docs site and the CLI reference describe declarations, resolution, proof, the check commands and the limits (the check is a proxy, not proof of reading); the docs site builds and the doc-link and command-reference checks pass. [verify: exec `bun run docs:check`]
- AC20: The operator runbook for a live run on vantage-frontend (declarations for STYLING.md and THEMING.md, three tasks, expected verdicts) is in the PRD folder, and the operator's live run is recorded with its outcome in the flow journal. [verify: judged]
- AC21: The whole suite, typecheck and lint pass on the final head, CI is green, and the branch carries no version bump or release commit. [verify: exec `bun run check`]
- AC22: The flow's `description.md` carries the three origin lines (verbatim request, effect, how to observe) and they are accurate at completion. [verify: judged]
