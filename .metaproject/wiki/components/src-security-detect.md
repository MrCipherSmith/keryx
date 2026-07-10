# Module src/security/detect

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/security/detect` groups 12 file(s). Depends on `src/security`, `src/harness`, `src/capability`. Exposes 10 public symbol(s).

## Overview

`src/security/detect` is the threat-detection engine for the Keryx security pipeline. It owns the full set of content detectors — secrets, entropy, PII, prompt injection, egress, exfiltration, and MCP manifest scanning — and exposes them through a unified synchronous entry point (`runDetectors`) and an optional async entry point (`runDetectorsAsync`) that layers in opt-in model-backed backends. The module is gated entirely by `SecurityConfig` policy flags so each detector category can be enabled or disabled without changing call sites.

## How it works

The module is organized around a two-tier detection architecture. The deterministic floor consists of pure-function detectors (`detectSecrets`, `detectEntropy`, `detectPii`, `detectInjection`, `detectEgress`, `detectExfil`) that run synchronously using regex and heuristic logic with no external dependencies. These are assembled and policy-gated by the `index.ts` orchestrator: `runDetectors` iterates the active policy flags from `SecurityConfig`, invokes each applicable detector, and then deduplicates overlapping spans by keeping the highest-confidence match per region, so an entropy hit never double-counts an exact secret at the same offset.

The optional async tier (`runDetectorsAsync`) extends the deterministic result with model-backed adapters for prompt-injection classification and PII named-entity recognition. Each adapter is resolved through the capability seam (`resolveCapability`) using a `CapabilitySpec` — a lazy, injectable abstraction over the underlying model runtime. If `SECURITY_MODEL_RUNTIME` is empty (the shipped default, as the ONNX stack was removed for weight), or if the capability fails to resolve, the async path silently falls back to the byte-identical deterministic result. Adapter failures are caught inside `mergeAdapter` so the deterministic matches always stand.

The `egress.ts` and `exfil.ts` files handle two distinct but related threat classes. `egress.ts` detects instructions to transmit data outbound: it scans for send-verb proximity to external URLs, SSRF targets (RFC-1918, loopback, link-local, cloud-metadata hosts), non-allowlisted domains when an allowlist is configured, and private-file references paired with a send verb. `exfil.ts` targets the EchoLeak / CVE-2025-32711 class of zero-click markdown exfiltration: it parses inline images, inline links, reference-style links, and HTML `<img>` tags, extracting the URL host and flagging any that are not on the egress allowlist. Findings from `exfil.ts` carry `mask:"url"` so `applyRedaction` can neutralize the auto-render trigger.

The `mcp.ts` detector is a standalone, network-free scanner for MCP tool manifests. It concatenates every human-facing text surface of each tool definition (description plus all JSON schema property descriptions and titles) and runs it through pattern tables for tool-poisoning, line-jumping, and invisible/steganographic unicode. It additionally checks for tool-shadowing (duplicate names in one manifest) and rug-pull detection (sha256 drift vs. a pinned baseline). All findings from `mcp.ts` are leak-safe: the `value` field carries a category token rather than raw manifest content.

## Key concepts

- **DetectorMatch** — the shared finding shape returned by every detector: `category`, `policyId`, `severity`, `confidence`, `start`/`end` (byte offsets in the scanned content), `value`, optional `mask`, and `remediation`. All detectors produce this type so findings compose uniformly.
- **SecurityConfig** — the policy and backend configuration object that gates which detectors run. `config.policies.<category>.enabled` controls each detector family; `config.backends.entropy.enabled`, `config.backends.injectionModel`, and `config.backends.piiModel` control optional enhancements.
- **CapabilitySpec / capability seam** — the lazy-resolution abstraction for opt-in model backends. A `CapabilitySpec<string, DetectorMatch[]>` describes a backend adapter; `resolveCapability(cwd, spec)` returns the adapter only when the runtime is available, otherwise returns null. This keeps the module weight-free by default.
- **Deterministic floor** — the synchronous, regex-and-heuristic-only detection path that is always active regardless of model availability. Every acceptance criterion that requires byte-identical results under a disabled or broken backend is satisfied here.
- **Egress allowlist** — a list of permitted host entries (exact or apex wildcard) used by both `detectEgress` and `detectExfil`. An empty allowlist activates the strictest posture for exfil detection (every external markdown URL is flagged) while keeping egress detection in proximity-only mode.
- **Rug-pull / baseline** — a `Record<string, string>` map of tool-name to sha256 used by `scanMcpManifest`. When a tool's computed hash diverges from its pinned entry, a `mcp.rug-pull.definition-drift` finding is raised.

## Main flows

**Synchronous policy-gated scan.** A caller passes raw text content and a `SecurityConfig` to `runDetectors`. The orchestrator checks each policy flag in order — secrets (optionally with entropy), PII, prompt injection, egress+exfil — and accumulates `DetectorMatch[]` from each active detector. After all detectors run, `dedupeOverlaps` sorts by descending confidence, walks the list, and drops any match whose span is fully contained by a higher-confidence match in the same category. The result is re-sorted by offset and returned.

**Async model-augmented scan.** `runDetectorsAsync` first calls `runDetectors` to obtain the deterministic baseline. It then checks `config.backends.injectionModel.enabled` and `config.backends.piiModel.enabled`; if either is on, it resolves the corresponding `CapabilitySpec` via the capability seam and calls `mergeAdapter`. `mergeAdapter` awaits `resolveCapability`, and if an adapter is returned, awaits `adapter.run(content)` to obtain additional matches which are pushed into the accumulated list. Any thrown error is swallowed so the deterministic matches are never lost. A final `dedupeOverlaps` pass is applied before returning.

**MCP manifest threat scan.** `scanMcpManifest` receives a parsed manifest object and optional baseline. It calls `parseTools` to extract `McpToolDef[]`, then for each tool calls `toolText` to build a single string covering the description and all nested schema field descriptions/titles. This text is tested against each poisoning pattern table and line-jumping pattern table. Invisible unicode is checked independently. Duplicate tool names are caught by a `seenNames` counter. If a baseline is provided, each tool's sha256 (via `hashToolDefinition`) is compared to its pinned entry. All findings use category tokens in `value`, never raw content, satisfying the leak-safety requirement.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `SECURITY_MODEL_RUNTIME`
- `runDetectors` (function)
- `DetectorBackendSpecs` (interface)
- `runDetectorsAsync` (function)
- `detectSecrets`
- `detectEntropy`
- `detectPii`
- `detectInjection`
- `detectEgress`
- `detectExfil`

### Key files

- `src/security/detect/index.ts` - imported by 9, imports 9
- `src/security/detect/exfil.test.ts` - imported by 0, imports 5
- `src/security/detect/egress.ts` - imported by 3, imports 0
- `src/security/detect/exfil.ts` - imported by 2, imports 1
- `src/security/detect/mcp.test.ts` - imported by 0, imports 3
- `src/security/detect/mcp.ts` - imported by 3, imports 0

### Depends on

- `src/security` - 3 import(s)
- `src/harness` - 2 import(s)
- `src/capability` - 1 import(s)
- `src/security/detect/injection` - 1 import(s)
- `src/security/detect/pii` - 1 import(s)

### Depended on by

- `src/security` - 3 import(s)
- `src/commands` - 2 import(s)
- `src/security/detect/injection` - 2 import(s)
- `src/security/eval` - 2 import(s)
- `src/mcp` - 1 import(s)
- `src/security/detect/pii` - 1 import(s)

### Entry points

- `src/security/detect/index.ts`

### Graph signals

- Files: 12
- Cross-module imports: 8

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/security](src-security.md)
- [Module src/harness](src-harness.md)
- [Module src/capability](src-capability.md)
- [Module src/security/detect/injection](src-security-detect-injection.md)
- [Module src/security/detect/pii](src-security-detect-pii.md)
- [Module src/commands](src-commands.md)
- [Module src/security/eval](src-security-eval.md)
- [Module src/mcp](src-mcp.md)

## Changelog

- 1.0.0 - Prose sections enriched by gdwiki enrich workflow (Overview, How it works, Key concepts, Main flows).
- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.
