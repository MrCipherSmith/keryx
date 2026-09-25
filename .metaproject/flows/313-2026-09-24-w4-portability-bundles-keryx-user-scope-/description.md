# W4: portability — bundles, ~/.keryx user scope, cross-harness memory handoff, instruction export

Status: formalized (flow-orchestrator, dispatched run)
Source: docs/requirements/keryx-agent-platform-expansion/workstreams/W4-portability.md (W4-AC1..AC11),
schemas/portable-bundle.schema.json, specification.md (storage tree), implementation-plan.md Wave 3.

## Problem

Keryx catalog content (skills, rules, agents, memory, hook configs, learned patterns) lives in
exactly one place, `<project>/.metaproject/`. There is no unit of transfer between projects, no
user-level catalog store (`~/.keryx/`), no way to hand a memory entry from one harness to another
with an honest, unspoofable source, no vetted path for an external Agent-Skills-standard catalog,
and no export of the canonical rules into every harness's native instruction file.

## Expected Outcome

- A `~/.keryx/` user store (overridable with `KERYX_HOME`) with the spec layout: `skills/`,
  `agents/`, `memory/<folder>/`, `bundles/applied-state.json`, `hooks.json` (already read by W6).
  `learning/` belongs to W3: W4 only transports `scope: user` learned-pattern records into
  `learning/patterns/` at `status: candidate` and never writes `learning/index.json`.
- `keryx bundle export|import|inspect|verify|uninstall` over a versioned manifest validating
  against `portable-bundle.schema.json`: sha256 per entry, provenance with no raw paths, compat +
  advisory target-harness hints; kinds skill, rule, agent, learned-pattern, memory-entry,
  hook-config.
- Import is plan → W8 `runHarnessAudit` on staged content → apply; fail closed on any checksum
  mismatch (zero writes); never overwrites a user-modified file unless that exact path is passed to
  `--force`; applied-state ledger per target scope; imported agents carry
  `origin.kind: imported` with `sourceRef` = bundle id; learned patterns never change scope and land
  as `candidate`.
- W8 audit gains an `imported-bundles` surface (bundle-* checks per the W8 spec).
- Cross-harness memory handoff: `MemoryEntry.source_harness` / `target_harnesses`; MCP memory
  tools bind harness identity at server launch; strict scans report `status: "incomplete"`;
  `keryx memory handoff --from <h> --target <h>`; private dirs fail closed on a conflicting
  `.gitignore`.
- External Agent-Skills catalog import (`--external`): read-only vetting via W1 scout dedupe + W8
  audit; passing skills are referenced (not copied into bundled content) and surface through
  `keryx skills scout --include-imports`.
- Canonical rules → per-harness instruction export (AGENTS.md, CLAUDE.md, GEMINI.md,
  `.cursor/rules/*.mdc`, Kiro steering, Windsurf rules, Copilot instructions) through the W5
  registry `instructions` surfaces and their managed blocks.
- Wave-3 exit criteria proven on a fixture bundle: export→import→inspect round trip byte-identical
  for checksummed content; no import overwrites a file the fixture marks user-modified.

## Out of Scope

- `keryx learn *` commands and `~/.keryx/learning/index.json` (W3, flow 312).
- Renaming or editing the bundled agents under `src/gdskills/bundled/agents` (flow 311).
- A Claude-Code plugin packaging shape; any network access during export/import.
- Automatic three-way merge of conflicting files; automatic scope promotion.
