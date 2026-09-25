# Implementation Plan

Status: frozen for dispatch (flow-orchestrator, Phase 1)

## Approach

Two independent lanes with disjoint files, then one small wiring step that the orchestrator owns.

- **Lane A (T5)** — `src/security/audit-harness/` (core zone): discovery, checks, score, baseline,
  proposals/apply, report builder; CLI handler in its own file `src/commands/security-audit-harness.ts`
  exporting `handleAuditHarness(cwd, args)`.
- **Lane B (T6)** — shared evidence builders + `src/security/impact-evidence/` (core zone) + CLI handler
  `src/commands/security-impact-evidence.ts` exporting `handleImpactEvidence(cwd, args)`.
- **Wiring (T7)** — two `case`s + help lines in `src/commands/security.ts`, docs page.

Why separate handler files: both lanes would otherwise edit the 1.2k-line `security.ts` switch in
parallel. `isPassGate` is private in `security.ts`; T7 exports it (no behavior change) and Lane A imports it
from `./security` — until T7 lands Lane A may keep an identical local allowlist, T7 swaps it for the import.

Prep done by orchestrator before dispatch (shared seam, committed first): `src/security/config.ts` exports
`computeObjectChecksum(value: unknown): string` (sha256 hex of the existing key-sorted `stableStringify`);
`computeConfigChecksum` delegates to it with unchanged output.

## Lane A design

- Surfaces (schema `surfaceId` enum): `instructions` (AGENTS.md, CLAUDE.md, GEMINI.md at root +
  `.github/copilot-instructions.md` if present), `settings` (every `SETTINGS_FILE_OWNERS[].relativePath`
  from `src/integrations` — read-only import — plus `.claude/settings.local.json`, `.cursor/settings.json`,
  `.windsurf/settings.json`, `.codex/config.toml`), `mcp-configs` (`.mcp.json`, `.cursor/mcp.json`,
  `mcpServers` inside `.claude/settings*.json`), `hooks` (every hook `command` string found in discovered
  settings/hooks JSON, plus non-JSON surface files from `HARNESS_ADAPTERS[].surfaces[].relativePath` such
  as the opencode plugin, plus `.metaproject/hooks.json` if present), `agent-definitions`
  (`.metaproject/agents/*.md`, `.claude/agents/*.md`), `skills` (`.metaproject/skills/**/scripts/*`,
  `.claude/skills/**/scripts/*` and `*.sh|*.py|*.js|*.ts` under `.claude/skills`), `imported-bundles`
  (`not-applicable`, reason "no W4 bundle staged").
  Absent → `not-applicable`; unreadable/unparseable → `error` + `coverage.status: incomplete`.
- Checks: every row of the W8 check table except `bundle-*`. Reused detectors: `detectSecrets`,
  `detectInjection`, `scanMcpManifest` (findings mapped 1:1: category, policyId, severity, confidence),
  rug-pull via the existing scan-mcp baseline file (absent → coverage reason `mcp-rug-pull not-established`),
  `command-risk.ts` (`touchesAgentCredentials`, destructive families) for `missing-deny-list`.
  Plus `indefinite-suppression` (low) from the baseline.
- Finding ids: `sha256(surface|check|path|matchedToken|pointer-or-line)` truncated, deterministic.
- Score/grade exactly per schema; critical caps grade at C; computed over unsuppressed findings.
- `--severity-floor` filters displayed/scored findings below the floor (recorded in `cliArgs`).
- Fix proposals: internal structured edit (JSON pointer remove/replace, or exact text replace) + emitted
  `{id, rationale, patch}` only. `--fix-proposals` writes nothing. `apply --proposal <id>` re-runs the audit,
  locates the proposal by id, refuses manual-only proposals (e.g. unpinned launcher needs a human-chosen
  version), applies under `withFileLock` with `writeFileAtomic`, refuses a second apply, appends
  `.metaproject/data/security/audit-harness/changelog.jsonl` and writes `<id>.applied.json` (learn.ts
  discipline).
- Baseline `.metaproject/security-audit-baseline.json`: `{schemaVersion:1, entries:[…], checksum}`;
  checksum = `computeObjectChecksum(entries)`; absent checksum or mismatch → `tamperState: mismatch`;
  unparseable → `unreadable`; entry without non-empty justification → schema error (file rejected,
  treated as unreadable for suppression, CI failure). `audit-harness baseline add --finding <id>
  --justification <t> [--expires YYYY-MM-DD] [--author <n>]` writes an entry and reseals.
- CI: exit 1 when any unsuppressed critical/high finding, or baseline tamperState ≠ ok, via a gate value
  (`pass`/`fail`) folded through `isPassGate`.
- Labeled fixtures: `src/security/audit-harness/fixtures/<name>/` each with `expected.json`
  (`{"checks": [...]}`); plus `clean/` expecting `[]`.

## Lane B design

- `src/gdgraph/affected-report.ts`: `buildAffectedReport(root, target, {depth?, ranked?})` →
  `{ exitCode: 0|1, json: object }` — the exact object `runAffected --json` prints (success,
  index-incomplete, target-not-indexed). `runAffected` JSON path prints `JSON.stringify(report.json, null, 2)`.
- `src/testing/related-report.ts` (or service.ts): `buildRelatedTestsReport(root, target)` →
  `{schemaVersion:1, target, context:{status, incompleteReasons}, related:string[]}`; `keryx test related
  <file> --json` prints it; text output unchanged.
- `src/security/impact-evidence/`: `computeImpactEvidence(root, file)` (pure: affected JSON string
  verbatim + related JSON + memory caveats from `collectEntries` where `scopes.files` contains the file and
  `caveat` non-null); `renderEvidenceBlock`; session state
  `.metaproject/data/security/impact-evidence/sessions/<sessionId>.json`; event log
  `.metaproject/data/security/impact-evidence/log.jsonl`; `createImpactEvidenceProvider(deps)` →
  `(request) => Promise<ImpactEvidenceDecision>`; constants `IMPACT_EVIDENCE_HOOK_ID = "keryx.impact-evidence"`.
- Config: `impactEvidence` top-level block in `SecurityConfig` (`enabled`, `strict`, `exemptGlobs`,
  `dampenAfter`), merged with defaults (enabled true, strict false, [], 3); checksum covers it only when
  present (existing checksums unchanged). Env `KERYX_DISABLE_IMPACT_GATE=1`.
- CLI: `keryx security impact-evidence status [--json]`, `test <file...> [--json]`, `hook --runtime claude`
  (reads PreToolUse JSON on stdin; emits `hookSpecificOutput.additionalContext`; refuses runtimes without a
  `verified` `pre-tool-context` surface in the registry, which today is all of them except the explicit
  claude codec path marked "to verify" — reported, not installed).

## Steps

1. Prep seam (orchestrator): `computeObjectChecksum`.
2. T5 Lane A and T6 Lane B in parallel (sonnet).
3. T7 wiring + docs (haiku), export `isPassGate`.
4. T8/T9 verification tasks (orchestrator runs commands).
5. T4 PR + opus review loop.

## Risks

- Byte-identity (AC9) breaks if either path computes freshness differently → one builder, test compares
  the CLI stdout with the provider's section.
- Pattern detectors false-positive on this repo's own config → the audit run on the repo is recorded, not
  gated, in this flow.
- W6/W5-b parallel edits → this flow never writes `src/harness`/`src/integrations` (AC17).
