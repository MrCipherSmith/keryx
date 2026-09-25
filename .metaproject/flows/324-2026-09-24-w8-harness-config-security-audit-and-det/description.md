# W8: harness-config security audit and deterministic impact-evidence gate

Status: formalized (flow-orchestrator, Phase 1)
Source: docs/requirements/keryx-agent-platform-expansion/workstreams/W8-harness-security-audit.md (v0.1.3), Wave 1 of implementation-plan.md

## Problem

Keryx has a tested security subsystem (detectors, scan-mcp, checksum-guarded config) but no command that
answers "is my harness configuration safe to hand to an agent": nothing audits instruction files,
permission settings, MCP launchers, hook commands, agent definitions or skill scripts as the specific
surfaces they are. Separately, the impact of an edit ("what does this file touch") is today whatever the
agent asserts; the deterministic answers (`gdgraph affected`, `test related`, memory caveats) exist but are
never put in front of the agent before its first edit.

## Expected Outcome

Part A — `keryx security audit-harness [path] [--json] [--ci] [--fix-proposals] [--baseline <file>]
[--severity-floor <level>]` and `keryx security audit-harness apply --proposal <id>`:
- per-surface coverage (instructions, settings, mcp-configs, hooks, agent-definitions, skills,
  imported-bundles) with scanned / not-applicable / error, never "absent = clean";
- the W8 check catalog, reusing `src/security/detect/*` (secrets, injection, mcp) and
  `src/lib/command-risk.ts`, plus the net-new surface checks;
- severity, deterministic 0-100 score, grade with the critical cap at C;
- fix proposals emitted only; apply is a separate command that writes a changelog;
- CI exit codes via the `isPassGate` allowlist pattern;
- checksum-guarded baseline/suppression file with mandatory justification and indefinite-suppression flag;
- a labeled fixture set proving each check fires (and a clean control that does not).
- Output validates against `schemas/harness-audit-report.schema.json`.

Part B — impact-evidence gate as an exported, pure provider (`computeImpactEvidence(root, file)` plus a
decision provider for W6's `keryx.impact-evidence` slot), with first-edit-per-session state, strict vs
advisory mode, destructive-shell rollback gate, denial dampening, batch honesty, exemption globs, kill
switches (`impactEvidence.enabled`, `KERYX_DISABLE_IMPACT_GATE`, both logged), and
`keryx security impact-evidence status|test <file>`.

## Out of Scope

- Registering the provider into keryx shell's hook runtime (W6 owns `src/harness`; W6 exposes the slot).
- New `pre-tool-context` surfaces in the adapter registry (W5-b owns `src/integrations`); this flow only
  reads the registry and reports host-delivery eligibility.
- W4 bundle import pipeline (the `imported-bundles` surface is reported `not-applicable` until W4 stages
  bundles); W2 agent compiler integration.
- OQ-W8.1..4 decisions beyond the documented defaults.
