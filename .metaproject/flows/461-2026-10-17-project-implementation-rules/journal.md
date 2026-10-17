# Flow Journal

- 2026-10-17T18:22:54.675Z - flow created
- 2026-10-17T18:35:55.890Z - frozen: 25 criteria; checksum recorded
- 2026-10-17T18:35:55.893Z - warning: no verification kind on AC2, AC3, AC5, AC9, AC10, AC14, AC15, AC18, AC21 — add [verify: …] or accept them unclassified
- 2026-10-17T18:36:00.729Z - ac-updated: Remove the '(new)' note from verify markers so exec markers parse; no criterion text changed
- 2026-10-17T18:36:05.736Z - started
- 2026-10-17T18:36:06.226Z - task-added: T5: Stage 0: route tie-break, rules/project slot in task-implementer, rules step in tests-creator (AC1-AC3)
- 2026-10-17T18:36:06.746Z - task-added: T6: Stage 1: categories, skills import --rules/--link, registry fields, update/remove (AC4-AC8, AC23)
- 2026-10-17T18:36:07.177Z - task-added: T7: Stage 2: resolve-context, config, contracts, contract files, skill calls (AC9-AC14, AC25)
- 2026-10-17T18:36:07.690Z - task-added: T8: Stage 3: orchestrator templates, shell/MCP operation, TUI (AC15, AC16, AC24)
- 2026-10-17T18:36:08.202Z - task-added: T9: Stage 4: enforcement block mode and flow task done check (AC17, AC18)
- 2026-10-17T18:36:08.730Z - task-added: T10: Docs, reviewer non-regression, Vantage fixture, live-run runbook (AC19-AC22)
- 2026-10-17T18:39:05.097Z - task-done: T5: Stage 0: route tie-break, rules/project slot in task-implementer, rules step in tests-creator (AC1-AC3)
- 2026-10-17T18:53:20.097Z - ac-updated: AC7 tests live in project-skills-registry-kind.test.ts and import-skills-rules.test.ts; the verify command now names them
- 2026-10-17T18:53:36.370Z - task-done: T6: Stage 1: categories, skills import --rules/--link, registry fields, update/remove (AC4-AC8, AC23)

## State at restart 2026-10-17 (worker fork)

- Done and committed: T5 (stage 0), T6 (stage 1: AC4-AC8, AC23). Last stage-1 commit 0a5640228.
- Stage 2 (T7) started. Written: src/lib/glob.ts (glob matcher moved out of src/review/jev-rules.ts, which now re-exports it; this avoids a gdskills -> review import; `expandBraces` added), src/gdskills/project-context-config.ts (+ test, green).
- Next in T7, in this order: context-resolver.ts + test (rules from the registry, project skills of module implementation/testing, bundled rules from the task-implementer Phase 2.4 table that exist in rules/core, contract files cited in backticks, shadows, budget walk, last.json), `keryx skills resolve-context` in src/commands/skills.ts, schema fields (resolved_context_file, project_context_applied), tests-creator-output contract registration, `contracts validate --resolved`, skill text + bundled-project-context.test.ts, installed copies in sync. tests-creator SKILL.md is at its ceiling of 360 lines: any added line needs an equal cut.
- Then T8 (orchestrator text, skills_resolve_context in shell/MCP, TUI), T9 (block mode, flow task done check), T10 (docs, reviewer non-regression, Vantage fixture, live-run.md runbook, not run).
- Safe defaults chosen for operator-owned decisions (to repeat in the final report): cap 131072 bytes (85 KB Vantage set + 50%), config in .metaproject/tasks.config.json under gdskills.projectContext, last resolve at .metaproject/data/skills/project-context/last.json, `exceeded` = a non-index project entry was pushed to on_demand by the cap, update --rules and remove --rule flags, bundled rules listed only if present in rules/core, `--rules` takes a directory (a single contract file is not accepted; contract files are reached through citations).
- Pointed tests only; the full suite runs on CI.

## State at second restart 2026-10-17 (worker fork)

- Committed: T7 (resolver, `skills resolve-context`, config, `contracts validate --resolved`, `project_context_applied`, skill calls, installed copies); AC15 (orchestrator templates, flow-orchestrator and job-orchestrator text, ceilings 682 and 2197); AC16 (`skills_resolve_context` for shell, ACP and MCP, 8f375df24).
- In the tree, being finished: `src/gdskills/project-context-status.ts` (read-only snapshot for the TUI) and an exported `listRuleRefs` in `context-resolver.ts`. Next: `src/tui/project-context-inspector.ts` (AC24), then T9 (AC17 flag + AC18 check in `flow task done`), then T10.
- Decisions taken while implementing (all reversible, to repeat in the report and the TRD):
  - `resolved_context_file` is under `workspace` in both input contracts. The tests-creator schemas have no top-level `additionalProperties: false`.
  - "`project_context_applied` required when `resolved_context_file` is given" is enforced by `contracts validate --resolved`, not by schema conditionals, so a result written without the resolver stays valid.
  - `keryx skills import --rules` takes a directory; a single-file `--rules <file>` is not implemented.
  - The TRD row "40,960/40,961" is replaced by the 131,072 default.
  - Resolver reasons emitted: `glob:<g>`, `always`, `task-type:<t>`, `replaces-bundled`, `route`, `bundled-default`, `referenced-by:<path>`.
  - The `skills_resolve_context` operation is pure: it does not write `last.json`; only the CLI does. Over MCP it returns the structured record, in the shell and ACP the same Markdown as the CLI.
  - The ProjectCtx sidebar row and `/projectctx` read through `loadProjectContextStatus`, which never throws: an unreadable `tasks.config.json` or `last.json` is a field (`configError`, `lastError`), shown in the modal.
  - TRD section 6 (Vantage thin overlays, criteria P1-P4) is a proposal only and is not implemented here.
- Unverified until run: whether `flow task done` can read a recorded task result (AC18 may need a `--result <file>` input); real Vantage globs (the fixture in T10 stands in; the operator's live run is AC22).
