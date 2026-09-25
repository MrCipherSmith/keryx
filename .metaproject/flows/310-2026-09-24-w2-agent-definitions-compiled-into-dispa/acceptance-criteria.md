# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `schemas/agent-definition.schema.json` parses, and the definition validator in `src/agents/` enforces every field of the W2 format table (tools, model_tier, output_contract, name, description, role, policy_profile required; name pattern; enums; no additional properties), proven by a test that also asserts the validator and the JSON schema agree on required fields and enums (W2-AC1).
- AC2: A test instantiates the real `spawn_subagent` tool and asserts the compiler's `keryx-shell` output input object uses only keys from the tool's `inputSchema.properties` (task, mode, label, max_tool_calls, max_rounds, model_tier, runtime) — no invented keys — and that every definition field is either projected into those keys or into the documented policy sidecar, none silently dropped (W2-AC2).
- AC3: The prompt-defense baseline exists as exactly one source constant; a guard test compiles every bundled agent for every target and fails if any output lacks the constant verbatim, contains a divergent copy, or if any definition body contains baseline text (W2-AC3).
- AC4: Exporter support levels are looked up from the W5 registry/matrix `agents` surface records, never asserted independently; a test stubbing an unverified runtime (no native/adapter agents record) proves the exporter emits only instruction-only output with a provenance comment (W2-AC4).
- AC5: `keryx agents verify` exits non-zero with a named reason for a definition whose `tools[]` or `skills[]` references something absent from the catalogue, and `agent-catalogue-xref.test.ts` still passes with its check extended to resolve against the agent catalogue (W2-AC5).
- AC6: `keryx agents verify` fails closed with a named reason for a `generated` definition whose `origin.sourceRef` does not resolve to an existing W1 stack pack (resolver injectable; gate-cleared/retired status deferred to Wave 4 with W1), and for any non-authored origin missing `sourceRef` (W2-AC6, Wave-2 slice).
- AC7: `model_tier` in compiled keryx-shell output is validated/passed through via `src/gdskills/model-tier.ts` (no re-implemented tier logic), and a test proves no compiled output for any target contains a literal model name (W2-AC7).
- AC8: `keryx agents list|show|export|verify` exist with `--json` where specified, `export` supports `--dry-run` and refuses to overwrite a file lacking the keryx-managed sentinel, and `agent-commands.test.ts` passes unchanged for `bootstrap|external|monitor` (W2-AC8).
- AC9: Exporters exist for claude, codex, kiro, opencode and keryx-shell; host formats follow first-party docs cited in the registry `sourceDocs`; `agents` surfaces are registered only where docs support them, are opt-in (default `keryx integrations install` behavior unchanged), and `docs/integrations/harness-capability-matrix.json` is regenerated and passes `keryx integrations matrix --check`.
- AC10: The ten generic agents (architect, planner, code-explorer, tdd-guide, refactor-cleaner, silent-failure-hunter, doc-updater, security-reviewer, performance-reviewer, e2e-runner) ship as bundled definitions and every one passes `keryx agents verify` (Wave-2 exit criterion).
- AC11: Every exporter's output for every generic agent is scanned clean (zero findings) by W8's `keryx security audit-harness`, proven by a test and by a recorded manual run (Wave-2 exit criterion).
- AC12: D-2 is recorded: the flow journal notes owner acceptance, and `docs/requirements/keryx-multi-agent-engine/README.md` carries a cross-reference note beside the `.claude/agents/*.md` non-goal pointing at W2/D-2; user-facing docs describe the agent catalogue and CLI.
