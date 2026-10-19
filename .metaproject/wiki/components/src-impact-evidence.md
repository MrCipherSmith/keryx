# Module src/impact-evidence

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/impact-evidence` is the impact-evidence gate: before a file-editing or destructive shell tool call, it decides whether to allow, ask or deny, and attaches each file's importers, related tests and accepted memory caveats as evidence. It groups 9 file(s), depends on `src/lib`, `src/security` and `src/gdgraph`, and exposes 14 public symbol(s).

## Overview

`src/impact-evidence` owns the decision a PreToolUse-style gate makes about a proposed change. Given a request (files, or a shell command, plus the session and the security profile), it computes what depends on each file and which tests cover it, and returns an `allow`, `ask` or `deny` outcome with a named reason. Its purpose is to put impact context in front of an agent or a human before a change lands, without re-running the graph or test tools by hand. Host delivery is not wired yet: `hostDeliveryStatus` reports every adapter as `not-registered`, as the `src/impact-evidence/index.ts` header comment notes.

## How it works

The module is split into four layers with a one-way dependency: `types.ts` at the bottom, then `evidence.ts` and `state.ts`, then `provider.ts` on top. `index.ts` only re-exports.

- **Types (`types.ts`).** Pure core-zone types with no I/O. They define the `ImpactEvidenceRequest` and `ImpactEvidenceDecision` shapes, the closed sets of outcomes, reasons and log events, and the `IMPACT_EVIDENCE_HOOK_ID` constant. `ImpactEvidenceProfile` is a local string union on purpose, so the module never imports the harness's profile type.
- **Evidence (`evidence.ts`).** `computeImpactEvidence` composes three sources for one file: the affected-importers report from `src/gdgraph`, the related-tests report from `src/testing`, and memory caveats from `src/memory`. Only memory entries that are `accepted`, have no `validTo` and carry a non-empty caveat that names the file are kept. The importer and test JSON is stored verbatim, so the gate and `keryx gdgraph affected --json` cannot drift. `renderEvidenceBlock` turns a batch into the text that is injected as `additionalContext`.
- **State (`state.ts`).** Per-session state (`touched`, `denials`, `pendingAck`) is stored as JSON under `.metaproject/data/security/impact-evidence/sessions`. The filename is the sanitized session id plus a short SHA-256 of the raw id, so two ids cannot share a file. Writes and appends to the append-only `log.jsonl` go through the contained-write helpers so a symlinked data directory cannot redirect them.
- **Provider (`provider.ts`).** `createImpactEvidenceProvider` returns the `(request) => Promise<ImpactEvidenceDecision>` function that the `keryx.impact-evidence` slot will call. It resolves the security config through `src/security/service`, normalizes every requested path to a root-relative POSIX path, and then applies rules in a fixed order: the `KERYX_DISABLE_IMPACT_GATE` kill switch, `config.enabled`, path rejection, and untrusted config. Only after those does `computeDecision` run. Its shell branch uses `isDestructiveCommand` to demand a rollback line. Its edit branch skips exempt globs and already-touched files, computes evidence for first-touch files, and in strict mode asks for an acknowledgement.

The hook class is set once from `config.strict`: `gate` (strict) can return `ask` or `deny`, while `gate-advisory` only allows and surfaces context. Within `gate`, a service failure fails closed.

## Key concepts

- **Hook class (`gate` / `gate-advisory`).** Derived from `config.strict` by `impactEvidenceHookClass`. A `gate` blocks, and `gate-advisory` never does.
- **Profile.** The posture of the caller: `read-only-review`, `monitored-trusted-local` or `unattended-untrusted`. Only `unattended-untrusted` turns advisory failures into denials. The two supervised profiles only warn.
- **Outcome and reason.** `allow`, `ask` or `deny`, each with a stable `ImpactEvidenceReason` such as `rollback-line-required`, `acknowledgement-required`, `path-outside-root` or `hook-crashed`. Callers are meant to branch on the reason, not on free text.
- **Touched file.** A file already shown to the agent this session. A repeat edit is logged as `skipped-repeat` and allowed without evidence. A file is marked touched only after it is shown and the request is not a denial retry.
- **Denial dampening (`denials`, `dampenAfter`).** A caller that reports a prior prompt was denied (`request.denied`) bumps the counter for each file. Once a file reaches `dampenAfter`, it gets a condensed notice instead of the full evidence block. Dampening is decided per file, not per batch.
- **Pending acknowledgement (`pendingAck`).** In strict mode, the files a previous `ask` already showed. A follow-up request that still lacks a non-empty acknowledgement gets the condensed form, and it counts toward dampening as well.
- **Redacted command record.** `redactCommandForLog` stores only a 12-character SHA-256 prefix and the command family (for example `rm` or `git`) in the log. The raw command never reaches `log.jsonl`.
- **Config trust.** `resolveImpactEvidenceConfigTrusted` ignores the loosening fields (`enabled`, `exemptGlobs`, `dampenAfter`) of an `impactEvidence` block with no checksum or a mismatched one. It logs `config-untrusted` and uses safe defaults instead.
- **Log events.** The closed set in `state.ts#isEventKnown`, such as `injected`, `dampened`, `path-rejected` and `service-failed`. The `not-applicable` event exists only on the in-memory record and is never written to `log.jsonl`.

_Hook class, profile and outcome are the three axes the decision logic is written against._

## Main flows

1. **Edit of a file.** The request arrives with `files` and no `command`. `normalizeRequestFiles` turns each path into a root-relative POSIX path, and paths outside the root are dropped. The provider then loads session state. Exempt files are skipped. Each first-touch file goes through `computeImpactEvidence`, and `renderEvidenceBlock` builds the context. In `gate` mode with no acknowledgement, the provider logs `injected`, saves the files to `pendingAck` and returns `ask` with `acknowledgement-required`. Otherwise it marks the files touched and returns `allow` with the context.
2. **Destructive shell command.** The request carries `command`, and `isDestructiveCommand` classifies it. With no `rollbackLine`, the provider logs `rollback-required` with the redacted command and returns `ask` with `rollback-line-required`. With a rollback line, it logs `rollback-accepted` and returns `allow`. A non-destructive command returns `allow` and writes no log line.
3. **Service failure.** If `computeEvidence` throws, the provider logs `service-failed`. A `gate` returns `deny` with `hook-crashed`. `unattended-untrusted` returns `deny` with `hook-advisory-failed`. The two supervised advisory profiles return `allow` with a warning and no evidence.

The host side of flow 1 is `src/commands/security-impact-evidence.ts`, which the `index.ts` header names as the Claude delivery path. It maps an `ask` that needs a prompt to Claude Code's own permission UI, because the PreToolUse payload has no acknowledgement field.

---

<!-- keryx:reference:begin v=1 hash=6ddfedb6c71a1e6598df934b48df252ec771e63b55d59abc7b700e97d22cdd34 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `IMPACT_EVIDENCE_HOOK_ID`
- `computeImpactEvidence`
- `renderEvidenceBlock`
- `appendLogRecord`
- `impactEvidenceDataRoot`
- `loadSessionState`
- `logPath`
- `readLogRecords`
- `saveSessionState`
- `sanitizeSessionId`
- `createImpactEvidenceProvider`
- `impactEvidenceHookClass`
- `normalizeRequestFiles`
- `hostDeliveryStatus`

### Key files

- `src/impact-evidence/index.ts` - imported by 7, imports 5
- `src/impact-evidence/provider.ts` - imported by 2, imports 8
- `src/impact-evidence/evidence.ts` - imported by 3, imports 5
- `src/impact-evidence/state.ts` - imported by 4, imports 4
- `src/impact-evidence/provider.test.ts` - imported by 0, imports 5
- `src/impact-evidence/types.ts` - imported by 5, imports 0

### Depends on

- `src/lib` - 7 import(s)
- `src/security` - 2 import(s)
- `src/gdgraph` - 1 import(s)
- `src/memory` - 1 import(s)
- `src/testing` - 1 import(s)
- `src/integrations` - 1 import(s)

### Depended on by

- `src/commands` - 1 import(s)
- `src` - 1 import(s)
- `src/lib` - 1 import(s)

### Dependency basis

- Production imports only: 9 import(s) from test file(s) (e.g. `src/commands/agent-hooks.test.ts`) excluded from the two sections above in both directions.

### Entry points

- `src/impact-evidence/index.ts`

### Graph signals

- Files: 9
- Cross-module imports: 13
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/security](src-security.md)
- [Module src/gdgraph](src-gdgraph.md)
- [Module src/memory](src-memory.md)
- [Module src/testing](src-testing.md)
- [Module src/integrations](src-integrations.md)
- [Module src/commands](src-commands.md)
- [Module src](src.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-10-19T10:13:19.815Z. Prose sections are drafts for the gdwiki enrich workflow.
