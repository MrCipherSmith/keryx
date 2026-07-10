# Module src/security

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/security` groups 16 file(s). Depends on `src/lib`, `src/security/detect`, `src/security/agent-hooks`. Exposes 18 public symbol(s).

## Overview

`src/security` is the policy-based security engine for keryx. It owns configuration loading and checksum verification, multi-backend content scanning (secrets, PII, prompt-injection, egress, artifact safety), redaction, incident persistence, and a write-seam guard that consuming modules (memory, wiki, testing, mcp, flow) call before every controlled side-effecting write. The module operates in three modes — `advisory` (report-only), `enforced`, and `ci` — and is architected so that a disabled module or an analysis error always degrades to an allow, keeping the broader CLI functional. It also installs and manages per-runtime (Claude Code, Cursor, Windsurf, generic-MCP) agent hook pairs that route agent inputs and outputs through the `check-input` / `check-output` CLI commands.

## How it works

The module is organized in three distinct layers.

**Configuration layer (`config.ts`)** — `loadSecurityConfig` reads `.metaproject/security.config.json` and deep-merges it field-by-field over `DEFAULT_SECURITY_CONFIG`, falling back to defaults if the file is absent or malformed. Policy blocks (`secrets`, `pii`, `promptInjection`, `egress`, `artifactSafety`) and detection backends (`rules`, `entropy`, `piiModel`, `externalApi`, `injectionModel`) are merged separately. A SHA-256 checksum is computed over the normalized `policies` block via `computeConfigChecksum` (using a stable sorted-key JSON serializer) and stored as `configChecksum`; `verifyConfigChecksum` detects policy tampering at runtime.

**Engine layer (`service.ts`, `redact.ts`, sub-modules)** — `createSecurityService` returns the `SecurityService` contract implementation. Its `check` method drives the full analysis pipeline: `runDetectorsAsync` (from `src/security/detect`) runs enabled backends against content; `resolveDecision` maps matches to a `SecurityDecision` with a `gate` (`pass` / `fail` / `needs-approval`) and an `action`; self-protection evaluation (`self-protect.ts`) folds in findings about config tampering or policy downgrade; incidents are appended and state is written to disk. `redact.ts` handles the fixed-width masking strategy — secrets always become `[REDACTED:secret]`, PII becomes typed constants like `[REDACTED:email]` — and manages a per-project HMAC-SHA256 key (stored at `data/security/raw/hmac.key`, gitignored, mode 0600) so hashes are not brute-forceable.

**Write-seam layer (`guard.ts`)** — `guardOutput` and `redactRaw` are the stable entry points for the rest of the codebase. `guardOutput` checks whether the `security` module is enabled via `metaproject.json`, then runs `createSecurityService().check`. In `advisory`/`gateway` mode it always returns `allowed: true`; in `enforced`/`ci` mode it returns `allowed: false` when the gate is `fail` or `needs-approval`. Errors always degrade to allow. `redactRaw` is a lighter seam used by gdctx before persisting command output: it returns the original content unchanged when nothing sensitive was detected. `securityFlowGate` is a flow-completion hook that maps the latest scan result to a `pass`/`fail`/`skipped` status only in blocking modes.

**Agent-hooks layer (`agent-hooks.ts`)** — installs and uninstalls managed hook groups in agent runtime settings files (`.claude/settings.json` or runtime equivalents). Each group carries a sentinel key so reinstalls are idempotent and user-written hook entries are never clobbered. The installer delegates to a `RuntimeHook` registry in `agent-hooks/runtimes.ts` that covers Claude Code, Cursor, Windsurf, and a generic-MCP runtime.

## Key concepts

- **`SecurityConfig`** — the runtime configuration object. Contains `mode`, `rawRetention`, per-policy blocks, and a backend registry. Loaded by `loadSecurityConfig` and protected by `configChecksum`.
- **`mode`** — controls whether findings block writes. `advisory` (default): report only. `enforced`: block on `fail`/`needs-approval`. `ci`: same as enforced, intended for CI pipelines.
- **Policy** (`PolicyConfig`) — a per-category rule with `enabled`, `action` (`block` / `redact` / `require-approval` / `allow`), and an optional `minConfidence`. The five built-in policies are `secrets`, `pii`, `promptInjection`, `egress`, and `artifactSafety`.
- **Backend** — a detector implementation. Enabled backends include `rules` (regex/pattern rules), `entropy` (Shannon-entropy-based secret detection), and opt-in `piiModel`, `injectionModel` (model-backed), and `externalApi`.
- **`DetectorMatch`** — a raw detection result carrying byte offsets (`start`, `end`), a `category`, and an optional `mask` token (present only for categories that support redaction).
- **`SecurityDecision`** — the resolved output of a scan: `gate` (`pass` / `fail` / `needs-approval`), `action`, `findings[]`, and an optional `redacted` string.
- **`SecurityFinding`** — a structured finding with `category`, `severity`, `action`, `location`, `redactedPreview`, and a `hash` (HMAC-SHA256 of the original value).
- **`SecuritySource`** — the origin of content being scanned: `generated`, `tool-output`, `user-input`, or `file`.
- **`SecurityTarget`** — the destination of a write: `memory`, `wiki`, `testing`, `gdctx`, `flow`, or `artifact`.
- **`SecurityService`** — the internal contract with `check`, `redact`, `report`, and `gate` methods. Created by `createSecurityService` and consumed by the write seam (`guard.ts`) and by commands.
- **`configChecksum`** — SHA-256 of the stable-serialized `policies` block. Detected change raises a self-protection finding, surfacing policy tampering.
- **Write-seam guard** — the pattern by which consuming modules call `guardOutput` before persisting content; it is the boundary between the security engine and the rest of keryx. Never throws; always degrades to allow on error.
- **Agent hooks** — `PreToolUse` and `UserPromptSubmit` entries injected into runtime settings files. Route agent I/O through `keryx security check-input` / `check-output` before the agent or tool acts. Managed with a sentinel key to enable idempotent install/uninstall.

## Main flows

**Flow 1: write-seam guard (e.g. memory or wiki write)**

A consuming module (e.g. `src/memory`) calls `guardOutput({ cwd, content, target: "memory", source: "generated" })` in `guard.ts`. The guard first checks `isSecurityEnabled` by reading `metaproject.json`. If disabled, it returns `{ allowed: true }` immediately. Otherwise it calls `loadSecurityConfig` to get the current mode, then delegates to `createSecurityService(cwd).check(...)` defined in `service.ts`. Inside `service.ts`, `analyze` runs `runDetectorsAsync` from `src/security/detect`, then `resolveDecision` maps matches to a `SecurityDecision`. Self-protection is evaluated and findings may be folded in. Back in `guard.ts`, `advisory` mode always returns `allowed: true` (with the decision attached); `enforced`/`ci` mode returns `allowed: false` and a masked `reason` string if the gate is `fail` or `needs-approval`. Any exception returns `allowed: true` so the write-seam is never broken.

**Flow 2: raw-output redaction (gdctx seam)**

Before persisting tool/command output, `redactRaw({ cwd, content, source: "tool-output" })` is called in `guard.ts`. If security is enabled and content is non-empty, it calls `createSecurityService(cwd).redact(content, { source })`. Inside `service.ts`, `redact` runs `runDetectorsAsync`, passes matches to `resolveDecision`, and returns `{ redacted, findings }`. In `redact.ts`, `applyRedaction` performs a single left-to-right cursor pass replacing every span that carries a `mask` (secrets, PII) with a fixed-width token like `[REDACTED:secret]`. If no findings were detected, the original content is returned byte-for-identical. The result flows back to the caller transparently.

**Flow 3: agent-hook install**

When `keryx security hooks install` is invoked for a project, it calls `installRuntimeHooks(projectRoot, runtime)` in `agent-hooks.ts`. The function reads the runtime's settings file (`agent-hooks/runtimes.ts` provides the path), parses it, calls `runtime.merge(settings)` which appends two managed hook groups (carrying the sentinel key) for `UserPromptSubmit` and `PreToolUse`, and writes the merged settings back. The hooks point to `keryx security check-input` and `keryx security check-output` respectively. On reinstall the existing managed groups are stripped first and then re-appended, so the operation is idempotent. User-authored entries are never modified.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `DEFAULT_SECURITY_CONFIG`
- `securityDataRoot` (function)
- `configPath` (function)
- `mergeSecurityConfig` (function)
- `loadSecurityConfig` (function)
- `computeConfigChecksum` (function)
- `verifyConfigChecksum` (function)
- `renderSecurityConfig` (function)
- `validateSecurityConfig` (function)
- `GuardInput`
- `GuardResult`
- `RedactRawInput`
- `RedactRawResult`
- `isSecurityEnabled` (function)
- `guardOutput` (function)
- `redactRaw` (function)
- `formatGuardWarning` (function)
- `securityFlowGate` (function)

### Key files

- `src/security/config.ts` - imported by 16, imports 3
- `src/security/guard.ts` - imported by 10, imports 4
- `src/security/service.ts` - imported by 4, imports 8
- `src/security/security.test.ts` - imported by 0, imports 8
- `src/security/agent-hooks.ts` - imported by 5, imports 2
- `src/security/redact.ts` - imported by 5, imports 2

### Depends on

- `src/lib` - 9 import(s)
- `src/security/detect` - 3 import(s)
- `src/security/agent-hooks` - 1 import(s)
- `src/capability` - 1 import(s)

### Depended on by

- `src/commands` - 12 import(s)
- `src/security/detect` - 3 import(s)
- `src/testing` - 3 import(s)
- `src/mcp` - 2 import(s)
- `src/memory` - 2 import(s)
- `src/security/detect/injection` - 2 import(s)

### Graph signals

- Files: 16
- Cross-module imports: 14

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/security/detect](src-security-detect.md)
- [Module src/security/agent-hooks](src-security-agent-hooks.md)
- [Module src/capability](src-capability.md)
- [Module src/commands](src-commands.md)
- [Module src/testing](src-testing.md)
- [Module src/mcp](src-mcp.md)
- [Module src/memory](src-memory.md)

## Changelog

- 1.0.0 - Prose sections enriched by gdwiki enrich workflow (2026-07-10). Status set to accepted.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.
