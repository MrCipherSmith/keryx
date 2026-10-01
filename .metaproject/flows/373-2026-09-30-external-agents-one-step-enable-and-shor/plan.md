# Implementation Plan

Status: ready

## Approach

Add one enabling command and one name-normalising function, applied at the entry points only.

## Steps

1. `src/harness/external/registry.ts`: `canonicalExternalAgentId(input)` mapping claude to claude-cli, codex to codex-cli, agy and antigravity to antigravity-cli; case-insensitive, unknown input returned unchanged. NOT applied inside `getExternalAgent`: per-agent config and consent are keyed by the string the caller passes, so an alias reaching them would miss `agents["claude-cli"].enabled=false`.
2. Apply it once at each entry point, before any lookup: `parseDelegateCommand`, the `keryx agents external` id argument (run/probe/review/...), and the `spawn_subagent` runtime block validation.
3. `src/capability/external-agents.ts`: `enableExternalAgents` and `disableExternalAgents`: merge-write the raw `externalAgents.enabled` in the user config (like `recordExternalAgentConsent`), and set only the `gdskills.external-agents` capability entry in `.metaproject/metaproject.json` when a manifest exists. Return what changed.
4. `keryx agents external enable|disable` in `agents-external.ts`, with `--help` text; a shell slash command for the same action; the `/delegate` refusal names it.
5. Replace the refusal texts in `resolveExternalAgentsCapability` so both layers say `keryx agents external enable`.
6. Docs: external-agent docs, commands-by-task, CHANGELOG, version 0.3.44.

## Risks

- Alias bypassing a per-agent disabled flag: mitigated by normalising at entry points only, with a test that `agents["claude-cli"].enabled=false` still refuses `/delegate claude`.
- Writing metaproject.json: must be a minimal merge-write that preserves every other key and refuses unparsable JSON.
