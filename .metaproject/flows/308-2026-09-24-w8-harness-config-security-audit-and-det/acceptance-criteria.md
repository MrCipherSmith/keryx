# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx security audit-harness` on a project with only a `CLAUDE.md` (no `.metaproject/agents/`, no MCP config) reports a coverage entry for every surface id with status scanned, not-applicable or error, and never reports an absent surface as scanned-and-clean (W8-AC1); the JSON output validates against `schemas/harness-audit-report.schema.json`.
- AC2: A manifest with a `POISONING_PATTERNS`-matching tool description is flagged under `mcp-tool-poisoning` with the same category/policyId/severity `scanMcpManifest` returns for the same manifest, proven by a test comparing both (W8-AC2).
- AC3: An unpinned `npx <pkg>` MCP server entry is flagged `unpinned-mcp-launcher` at `high`; the same entry pinned `npx <pkg>@1.2.3` is not flagged (W8-AC3).
- AC4: A single unsuppressed `critical` finding caps the grade at `C` even when the numeric score alone would give `A`/`B`; score = max(0, 100 - (25c + 10h + 4m + 1l)) over unsuppressed findings (W8-AC4).
- AC5: `--fix-proposals` performs zero filesystem writes (test snapshots the target directory before and after); `audit-harness apply --proposal <id>` is the only writing path and it writes a changelog entry (W8-AC5).
- AC6: `--ci` exits non-zero on any unsuppressed `critical`/`high` finding and zero otherwise, through an `isPassGate`-style allowlist, not an ad hoc branch (W8-AC6).
- AC7: A baseline suppression entry with no `justification` fails baseline schema validation; one with no `expiresAt` validates but is reported as a `low` `indefinite-suppression` finding (W8-AC7).
- AC8: A baseline file whose content changed without updating its checksum is reported as tampered (`tamperState: mismatch`) and is a `--ci` gate failure on its own (W8-AC8).
- AC9: The impact-evidence "importers" section for a file is byte-for-byte the JSON `keryx gdgraph affected <file> --json` prints standalone at the same graph state, because both come from one shared builder (W8-AC9).
- AC10: A second edit of the same file in the same session injects no evidence block (or the condensed dampened notice after N denials); a first edit of a different file in the same session injects its own full block (W8-AC10).
- AC11: When the graph reports the target unindexed, the evidence block says "not indexed", never "no importers found" (W8-AC11).
- AC12: A batch tool call editing three files for the first time produces an evidence block naming all three (W8-AC12).
- AC13: A command for which `isDestructiveCommand` is true (e.g. `rm -rf /`) requires a non-empty rollback line before proceeding in every mode unless the kill switch is set (and its use is logged); a non-destructive command is never asked for one (W8-AC13).
- AC14: The provider declares hook class `gate-advisory` by default and `gate` in strict mode; with the evidence service forced to throw, profile `unattended-untrusted` denies and `read-only-review`/`monitored-trusted-local` allow with a visible warning (W8-AC14).
- AC15: Disabling the gate via `KERYX_DISABLE_IMPACT_GATE` (or `impactEvidence.enabled: false`) produces a logged record distinguishable from "gate ran and found nothing" (W8-AC15).
- AC16: Wave-1 exit: the audit produces findings with severity and score on a labeled fixture set (each fixture declares its expected check ids; a test asserts the exact set, plus a clean control with zero findings), and fix proposals never apply themselves (test).
- AC17: No file under `src/harness/` or `src/integrations/` is modified by this flow; the provider's exported signature is documented for W6's `keryx.impact-evidence` slot.
