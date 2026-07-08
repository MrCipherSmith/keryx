# Context

Collected deterministically by `gd-metapro flow init` at 2026-07-08T07:18:10.931Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `gd-metapro gdgraph affected <file>` for blast radius.

## Code Health

- gate: warn (as of 2026-07-07T13:53:28.505Z)
- refresh: `gd-metapro health run`

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security

## Agent Findings

### Authoritative source (read first)
- docs/requirements/roadmap-2026/E-security-hardening/{prd,specification,acceptance-criteria,tasks}.md — spec is the contract; AC0..AC6 fixture-backed. E3 (scan-mcp) already shipped in Block A — cross-reference only (T25, no code).

### Existing security module to extend (do NOT rewrite)
- `src/security/config.ts` — `mergeSecurityConfig` (L54); `backends` block ALREADY has `piiModel {enabled:false, provider}` (L26/73) and rules/entropy/externalApi. ADD `backends.injectionModel {enabled:false, provider:"prompt-guard-2", size, assetId, minConfidence}` and `policies.egress.allowlist: string[]` (default `[]`), deep-merged, malformed⇒defaults.
- `src/security/detect/{egress,injection,pii,secrets,entropy}.ts` — pure detectors returning `DetectorMatch[]`. Extend egress + pii; add `detect/exfil.ts`; add `detect/injection/adapter.ts` + `detect/pii/ner-adapter.ts`.
- `src/security/resolve.ts` / `src/security/service.ts` — `runDetectors` pipeline; wire new detectors here (under `policies.egress.enabled`) and resolve the injection/piiNer capabilities, merging model matches with the always-on regex path (catch adapter errors → deterministic).
- `src/security/types.ts` — `DetectorMatch`, `SecurityCategory` (`egress`/`prompt-injection`/`pii`/`secret`/...), masks.
- `src/security/agent-hooks.ts` — sentinel installer for `.claude/settings.json` (`AGENT_HOOKS_SENTINEL`, `securityAgentHookEntries`, `installSecurityAgentHooks`/`uninstall`). Generalize over a new `agent-hooks/runtimes.ts` registry (cursor/windsurf/generic-mcp + existing Claude Code), preserving the merge-safe/idempotent algorithm; `install/uninstall --runtime <...|all>`.
- `src/security/guard.ts` — `guardOutput`/`redactRaw`/`applyRedaction`; leak-safe conventions (fixed-width masks, HMAC fingerprints, fail-closed `self-protect.ts`).
- `src/security/detect/mcp.ts` — Block A's scan-mcp detector; confirm it reuses `DetectorMatch[]` + guard-seam (E3 cross-ref).

### Block 0 seam to instantiate (landed on main)
- `src/capability/seam.ts` — `resolveCapability(cwd, spec)`, `runCapabilityOrFallback`, `warnCapabilityDegraded`. The `security.injectionModel`/`security.piiNer` ceilings gate through this (never throw → null → deterministic path).
- `src/assets/{resolver,lock,pull}.ts` + `.metaproject/assets.lock.json` — register `prompt-guard-2-22m/-86m` + `pii-ner` (id/url/sha256/size), resolved via `resolveAsset` (sha256 every load). Never bundled.
- `optionalDependencies` — add the Prompt Guard 2 / NER runtime(s) here (lazy `await import` inside the adapter only). EXTEND `src/capability/no-optional-imports.test.ts` to cover any new optional dep.
- `src/harness/` — `runCorpus`/`gateCorpus`; the eval harness (E6) + fixture corpora plug into this.

### Hard invariants (AC0.1 / C0-7 golden rule)
- All Block E backends off + no assets ⇒ `runDetectors` output on the existing security suite + every `security` command byte-identical to today; no optional dep imported; no socket opened. Empty `egress.allowlist` ⇒ today's send-verb proximity behavior unchanged.
- `dependencies` stays `{}`; new libs only under `optionalDependencies`, lazy `await import` inside adapters (static guard extended).
- Leak-safety unchanged/stronger: no raw secret/PII in committable artifacts; fixed-width masks; HMAC fingerprints + fail-closed gate intact.
- Adapters never throw out (seam catches) → warn-once + deterministic path + exit 0.

### Baseline
- main @ cef1b8a; `bun run check` green (322 tests); Blocks 0, A, B, C, D landed. This is the FINAL roadmap block.
