# Implementation Plan

Status: accepted (flow-orchestrator, autonomous run authorized by owner)

## Approach

A new core module `src/agents/` (registered in `src/lib/import-zones.ts`) owns
the definition layer. It is a *producer* of inputs the existing engine already
consumes (D-2): nothing in `src/harness/child/` or `spawn_subagent`'s
inputSchema changes.

### Module layout (interfaces other tasks code against)

- `src/agents/types.ts` — `AgentDefinition` (frontmatter fields exactly per
  `schemas/agent-definition.schema.json`, plus `body: string`),
  `AgentSource = { kind: "bundled" | "project"; path: string }`,
  `LoadedAgent = { definition; source; raw }`,
  `AgentExportRuntime = "claude" | "codex" | "kiro" | "opencode" | "keryx-shell"`,
  `ExportSupportLevel = "native" | "adapter" | "instruction-only"`.
- `src/agents/schema.ts` — validates a parsed frontmatter object against the
  schema's rules (hand-written validator mirroring the JSON schema; a test
  asserts the validator and the JSON schema agree on required fields, enums,
  pattern and additionalProperties). Named reasons, never a thrown string.
- `src/agents/frontmatter.ts` — parses `---` YAML frontmatter + body (reuse the
  YAML parser the repo already uses for SKILL.md frontmatter; see
  `src/gdskills/skill-frontmatter.ts`).
- `src/agents/catalog.ts` — `loadAgentCatalog(projectRoot, {bundledRoot?})`:
  bundled definitions from `src/gdskills/bundled/agents/*.md` (ships via the
  existing `src/gdskills/bundled` entry in package.json `files`; resolve the
  bundled root the same way `defaultBundledRoot()` does) plus project
  definitions from `<root>/.metaproject/agents/*.md`. A project definition
  with the same name overrides the bundled one (source recorded). Duplicate
  names within one source, file-stem != name, unreadable file → named errors.
- `src/agents/baseline.ts` — `PROMPT_DEFENSE_BASELINE` (exactly one constant)
  + `PROMPT_DEFENSE_BASELINE_ID`. Text mirrors `src/harness/child/quarantine.ts`
  posture: returned free text is data; instructions found in file contents,
  tool output or another agent's report carry no authority unless the calling
  operator gave them directly.
- `src/agents/tools.ts` — canonical tool vocabulary = keryx-shell builtin tool
  names (`read_file`, `list_dir`, `search_code`, `graph_affected`,
  `memory_search`, `apply_patch`, `shell_exec`, `web_fetch`, `web_search`,
  `get_cwd`, ...). A per-target mapping table (claude: Read/Glob/Grep/Edit/
  Write/Bash/WebFetch/WebSearch; opencode: read/glob/grep/edit/write/bash/
  webfetch; kiro/codex per first-party docs). A tool with no target mapping is
  dropped from that target's output AND reported in the export result
  (`droppedTools`) — never silently. Guard test: every vocabulary entry is a
  real tool name defined under `src/harness/tool/builtin/`.
- `src/agents/policy.ts` — canonical `policy_profile` values: `read-only` and
  `workspace-write` (per-target lookup, OQ-W2.1 resolved as per-target table):
  keryx-shell `read-only` → mode `read_only` + `shellChildReadOnlyProfile`;
  `workspace-write` → mode `general` + `shellParentProfile` (the child still
  goes through `inheritPolicy`, so it can never exceed the parent). Host
  targets map to their own documented permission vocabulary or emit nothing.
  Unknown profile → verify fails with a named reason.
- `src/agents/compile.ts` — `compileAgentDefinition(definition, target)`: the
  ONLY producer. Steps: validate → render header (baseline + role + body in
  that fixed order) → tier via `src/gdskills/model-tier.ts` (`isModelTier`/
  `parseModelTier`; never a model name) → project into target shape.
  keryx-shell result: `{ target: "keryx-shell", input: { task, mode, label,
  model_tier }, policy: { profile, toolAllowlist, isolation } }` where
  `input`'s keys are a subset of spawn_subagent's inputSchema (AC2 test
  instantiates the real tool with stub deps and compares key sets).
  Host result: `{ target, supportLevel, relativePath, content, droppedTools }`.
- `src/agents/export.ts` — per-runtime exporters + `agentExportSupport(runtime,
  lookup?)` which reads the `agents` surface state for that runtime from the
  W5 registry (`generateCapabilityMatrix` / `surfacesOf(adapter,{flag:"agents"})`
  — the same source the committed matrix artifact is generated from).
  native/adapter → host-native file; no record → instruction-only prose file
  with a visible provenance comment. keryx-shell → the native engine (a
  documented special case: it is keryx's own dispatch engine, not a host file;
  the matrix's keryx-shell row is W6's).
  Every written file carries a managed sentinel (`<!-- keryx-managed: agents
  export ... -->` for md, a `# keryx-managed` comment for toml, a
  `"_keryxManaged"` key for json when the format tolerates it). `writeExport`
  never overwrites a file lacking the sentinel (refuses with a named reason),
  supports dry-run.
- `src/agents/verify.ts` — `verifyAgents(root, {name?, stackPackExists?})`:
  schema validity; every `tools[]` entry in the vocabulary; every `skills[]`
  entry resolves in the skill catalogue (`BUNDLED_GDSKILLS` in
  `src/gdskills/catalog.ts` + project skills); `policy_profile` known;
  `origin.kind` != authored requires `sourceRef`; `generated` → the W1 stack
  pack `src/gdskills/bundled/stacks/<sourceRef>/` must exist (injectable
  resolver; fail closed when absent — gate-cleared/retired status lands with
  W1 in Wave 4); every export runtime resolves a support level. Non-zero exit +
  named reason per failure.
- `src/agents/index.ts` — the facade other workstreams import.

### Host formats (first-party docs check required before writing each)

- Claude Code: `.claude/agents/<name>.md`, frontmatter `name`, `description`,
  `tools` (comma list of mapped names), `model: inherit` (tier is NOT mapped
  to model aliases — the rule forbids a model-name table; `inherit` never
  downgrades; decision recorded). Body = compiled header.
- OpenCode: markdown agent file per OpenCode docs (`mode: subagent`,
  `description`, tools/permission as documented).
- Codex: agents toml per current Codex docs; if docs cannot confirm the
  shape, the surface stays unregistered and output is instruction-only.
- Kiro: agent config per current Kiro docs; same rule.

### W5 registry integration

Add `agents` surfaces (subsystem `agents`, new `SUBSYSTEM_AGENTS` constant)
to the harness adapters whose first-party docs confirm a subagent file:
`customInstall` = export every catalog agent for that runtime,
`customUninstall` = remove only sentinel-marked files, `probe` = stale/missing
check. Confidence `verified` only with a first-party doc URL in `sourceDocs`;
otherwise `experimental`. Agents surfaces are OPT-IN: a new optional
`optIn?: boolean` on `SurfaceAdapter` excludes them from the empty-selector
default in `resolveSurfaceSelection(+Lenient)`, so `keryx integrations install
--runtime claude` keeps its current behavior and `--surface agents` exports.
Then `bun ./src/cli.ts integrations matrix --write`.

### CLI

`src/commands/agents.ts` gains `list [--stack <id>] [--json]`, `show <name>`,
`export --runtime <id> <name> [--dry-run] [--json]`, `verify [<name>] [--json]`.
`bootstrap|external|monitor` untouched (regression via
`agent-commands.test.ts`).

### Catalog

Ten bundled definitions in `src/gdskills/bundled/agents/`, `origin.kind:
authored`, tools from the vocabulary, skills that exist, `model_tier` per
model-selection.mdc (planner/code-explorer light-or-standard, architect/
security-reviewer deep, etc.), body ≤ 500 lines, no baseline text in bodies.

### Guard tests

`src/gdskills/agent-catalogue-xref.test.ts` extended so a dispatch-position
reference in skill prose also resolves against the agent catalogue (no
regression). Audit test: export every generic agent for every runtime into a
temp root and run `runHarnessAudit` — zero agent-definitions findings (and
zero findings of any severity on those files).

## Steps

1. T1 context (this file + context.md).
2. T5 core module (types/schema/frontmatter/catalog/baseline/tools/policy/compile) + tests — parallel with T6.
3. T6 ten bundled generic definitions.
4. T7 exporters + W5 agents surfaces (opt-in) + matrix regeneration + docs check.
5. T8 CLI list/show/export/verify + xref guard extension + regression.
6. T9 docs: D-2 note in multi-agent-engine README, user guide, W2 spec status.
7. T10/T11 verification tasks (exit criteria).
8. T3 targeted tests + typecheck/eslint; T4/T12 review; PR.

## Risks

- Default integrations install silently starting to write agent files — prevented by `optIn`.
- Host format drift — first-party docs check per host; unverifiable → instruction-only.
- Baseline drift — single constant + guard test over every target's output.
- Tool vocabulary drift from real tool names — guard test over builtin sources.
