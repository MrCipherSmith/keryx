# Metaproject Security

Version: 0.2.2

Status: Phase 1+2 AND Phase 3 implemented (v0.1) - the deterministic engine (`src/security/`) and the `gd-metapro security` CLI are shipped, the module is enabled by default at `init`, and the Phase 3 write-seam integrations are wired: an in-process guard (`src/security/guard.ts`) runs at memory ingest, wiki collect, testing raw-log publish, gdctx raw-output redaction, and flow completion. Advisory (default) reports and continues without blocking; enforced/ci blocks or suppresses the write with a masked reason; disabled is a no-op. Phase 4 (model/API backends, gateway mode) remains future work; see specification.md §16 for the phased breakdown.

## 1. Purpose

Metaproject Security is the security, privacy and exfiltration-control layer for
agent workflows and `.metaproject/` artifacts.

It is intentionally separate from Code Health and `security-audit`:

- Code Health imports dependency/security findings as code quality signals.
- `security-audit` scans dependencies, committed secrets and container images.
- Metaproject Security protects prompts, external content, generated outputs,
  memory/wiki/report writes and orchestrated agent flows.

## 2. Documents

- [prd.md](prd.md) - product requirements and success criteria.
- [specification.md](specification.md) - technical module specification.
- [policies.md](policies.md) - policy model and default policies.
- [agent-protocol.md](agent-protocol.md) - agent usage rules and enforcement
  boundaries.
- [artifact-lifecycle.md](artifact-lifecycle.md) - storage and retention rules
  for sensitive security artifacts.
- [schemas/](schemas/) - draft JSON Schema contracts.

## 3. Draft Scope

The MVP focuses on:

- secret detection and redaction;
- basic PII detection and redaction;
- prompt-injection and data-exfiltration heuristics;
- artifact safety checks for memory, wiki, reports and task context;
- normalized Markdown/JSON reports;
- integration points with gdctx, memory, gdwiki, health, testing, gdskills and
  flow.

## 4. Non-Goals

- Guarantee that third-party hosted agents route every prompt through
  `gd-metapro`.
- Replace code-level security review, dependency audit or infrastructure
  security tools.
- Store raw prompts, raw responses or raw external documents by default.
- Make any model backend mandatory.

