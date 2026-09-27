---
Title: Module src/security/detect
Version: 1.0.2
Type: component
Status: accepted
VerifiedAt: 4e80355f1b9fa8576742d151d54397abbd527b38
VerifiedScope: sha256:cc0459b2cfe29d3fec3ae048a5f8c983ce89aa53841da1d8c1448e17d56abdba
Summary: `src/security/detect` groups 12 file(s). Depends on `src/security`, `src/harness`, `src/capability`. Exposes 10 public symbol(s).
---

# Module src/security/detect

## Overview

`src/security/detect` contains content-detection logic for the Keryx security pipeline. Its detectors cover secrets, entropy, personally identifiable information (PII), prompt injection, outbound egress, exfiltration, and MCP tool manifests.

The module provides a synchronous, policy-gated scan through `runDetectors` and an asynchronous scan through `runDetectorsAsync`. The asynchronous path can add optional model-backed results; deterministic results remain available when those backends are disabled or unavailable.

## Architecture

### Deterministic detection

The deterministic detectors use patterns and heuristics and run synchronously:

- `detectSecrets`
- `detectEntropy`
- `detectPii`
- `detectInjection`
- `detectEgress`
- `detectExfil`

`runDetectors` uses the security configuration to decide which detector families to run. It collects their findings, resolves overlapping matches, and returns the results in content order.

### Optional model-backed detection

`runDetectorsAsync` starts with the synchronous results and can add results from model-backed prompt-injection and PII adapters. Adapter resolution uses the capability seam, which allows backends to be supplied lazily rather than requiring the model runtime by default.

If a backend is disabled, cannot be resolved, or fails while running, the asynchronous path retains the deterministic results.

## Egress and exfiltration

`detectEgress` looks for indications that content may send data externally. Its checks include send-related wording near URLs, potentially unsafe network targets, domains outside a configured allowlist, and private-file references associated with sending.

`detectExfil` focuses on markdown and HTML constructs that can trigger outbound requests when rendered, including inline and reference-style links, images, and HTML `<img>` tags. It checks extracted hosts against the egress allowlist. Findings can include `mask: "url"` to indicate that the URL should be neutralized during redaction.

## MCP manifest scanning

The MCP manifest scanner checks tool definitions without making network requests. It examines human-facing text, including tool descriptions and nested schema descriptions and titles, for patterns associated with tool poisoning, line jumping, and invisible Unicode. It also checks for duplicate tool names and, when a baseline is supplied, changes to tool definitions.

Manifest findings use category tokens in their `value` field rather than copying raw manifest content.

## Key concepts

- **`DetectorMatch`** — A shared finding shape used by detectors. It includes a category, policy identifier, severity, confidence, content offsets, a value, and remediation information; a match may also include a mask.
- **`SecurityConfig`** — Configuration for detector policies and optional backends. Policy flags control which detector families run, while backend settings control optional enhancements.
- **Capability seam** — The lazy-resolution mechanism used to obtain optional model adapters. It keeps model-runtime dependencies out of the default deterministic path.
- **Egress allowlist** — The configured set of permitted hosts used by egress and exfiltration checks. The behavior for an empty allowlist depends on the detector: exfiltration treats external markdown URLs strictly, while egress uses proximity-based checks.
- **MCP baseline** — A mapping of tool names to expected SHA-256 values. When a supplied baseline does not match a tool definition, the scanner can report definition drift.

## Main flows

### Synchronous scan

1. The caller passes content and a `SecurityConfig` to `runDetectors`.
2. The orchestrator checks the relevant policy settings and runs enabled detectors.
3. Detector findings are collected and overlapping matches are deduplicated.
4. The results are returned in content-offset order.

### Asynchronous scan

1. `runDetectorsAsync` obtains the deterministic results by calling `runDetectors`.
2. If the relevant model backends are enabled, it attempts to resolve and run their adapters.
3. Adapter results are merged with the deterministic findings.
4. Resolution or adapter errors do not discard the deterministic results.
5. Overlaps are deduplicated before the results are returned.

### MCP manifest scan

1. The scanner extracts tool definitions from the parsed manifest.
2. It combines each tool’s human-facing text and checks it for suspicious patterns and invisible Unicode.
3. It checks for duplicate tool names.
4. If a baseline is provided, it compares each tool definition with its pinned hash.
5. Findings use category tokens rather than raw manifest text.

---

<!-- keryx:reference:begin v=1 hash=382718884bb067a29715a70dffc334c59079331d4ba20de86118014f0f879ab8 -->
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

- `src/security/detect/index.ts` - imported by 11, imports 10
- `src/security/detect/pii.ts` - imported by 9, imports 1
- `src/security/detect/exfil.ts` - imported by 7, imports 2
- `src/security/detect/exfil.test.ts` - imported by 0, imports 8
- `src/security/detect/secrets.ts` - imported by 6, imports 1
- `src/security/detect/mcp.ts` - imported by 5, imports 1

### Depends on

- `src/security` - 8 import(s)
- `src/capability` - 1 import(s)
- `src/security/detect/injection` - 1 import(s)
- `src/security/detect/pii` - 1 import(s)

### Depended on by

- `src/security` - 11 import(s)
- `src/security/audit-harness` - 3 import(s)
- `src/commands` - 2 import(s)
- `src/contracts` - 2 import(s)
- `src/harness/web` - 1 import(s)
- `src/mcp` - 1 import(s)

### Dependency basis

- Production imports only: 19 import(s) from test file(s) (e.g. `src/security/audit-harness/audit-harness.test.ts`) excluded from the two sections above in both directions.

### Entry points

- `src/security/detect/index.ts`

### Graph signals

- Files: 15
- Cross-module imports: 11
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that exist are linked; when enriching, add new links only to pages you have verified.

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

- 1.0.2 - Reference refreshed from the code graph (4e80355f).
- 1.0.1 - Reference refreshed from the code graph (5886c474).
- 1.0.0 - Prose sections enriched by gdwiki enrich workflow (Overview, How it works, Key concepts, Main flows).
- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.
