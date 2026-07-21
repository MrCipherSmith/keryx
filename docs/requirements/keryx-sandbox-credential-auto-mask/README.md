# Keryx Sandbox Credential Auto-Mask
Version: 0.2.0

## Purpose

Define an implementation-ready requirements package for **safe, automatic
credential masking** in Keryx sandboxed shell/harness runs.

Today Keryx can already:

1. Store API keys in the **user-global** `auth.json` (via shell `/connect`);
2. Inject those keys into process env for model providers (`applySavedApiKeys`);
3. Optionally mask named env vars behind an allowlist proxy with TLS
   termination (ADR-0006 / ADR-0007) — but only when the operator manually sets
   `KERYX_SANDBOX_MASK_ENV` and `KERYX_SANDBOX_TLS_TERMINATE`.

The gap: a key entered once in the shell still appears **in cleartext inside
sandboxed child processes** unless the operator remembers a second, error-prone
manual mask configuration. This package closes that gap without putting secrets
into project repos or `keryx init`.

Recommended delivery order (this package):

| Phase | Name | Outcome |
|-------|------|---------|
| **P0** | Auto-mask from provider registry | Known provider keys → mask specs at runtime when sandbox network is restricted |
| **Verify** | Dual-axis verification protocol | Separates model/network path from shell_exec mask path; redacted evidence |
| **P1** | Global sandbox defaults | `~/.local/share/keryx/sandbox.json` for shell/tls/maskMode |
| **P2** | Project policy + init skeleton | Non-secret project policy; `keryx init` scaffold only |

## Status

**draft (P0 + Verify landed; P1/P2 future)**

| Phase | Status |
|-------|--------|
| **P0** | **landed** (PR #175) — shared resolver + shell/harness wire-up; P0.a default `maskMode=manual` |
| **Verify** | **landed** — dual-axis contract tests, REPORT/redaction helpers, operator [verification.md](verification.md) |
| **P1** | not implemented — global `sandbox.json` |
| **P2** | not implemented — project policy + init skeleton |
| **P0.b** | not implemented — product default flip to `auto` |

Opt in to auto-mask:

```bash
export KERYX_SANDBOX_MASK_MODE=auto
# TLS auto-derived when masks apply under auto
```

Harness: `--mask-mode auto` or `--auto-mask`.

Live dual-axis network checks are **operator-run / flag-gated** — not required on default CI (see verification.md).

## Document Index

| Document | Purpose |
|---|---|
| [README.md](README.md) | Overview, status, scope, index. |
| [prd.md](prd.md) | Problem, goal, users, requirements, success criteria, risks, recommendation. |
| [specification.md](specification.md) | Identity, config, resolver semantics, CLI/env surface, acceptance criteria. |
| [brainstorm.md](brainstorm.md) | Decision history: levels of config, options, rejected approaches. |
| [policies.md](policies.md) | Secret vs policy placement; fail-closed rules; MITM constraints. |
| [implementation-plan.md](implementation-plan.md) | P0 → Verify → P1 → P2 file touch-points and gates. |
| [metrics-and-validation.md](metrics-and-validation.md) | Dual-axis verification protocol and measurable acceptance checks. |
| [schemas/sandbox-defaults.schema.json](schemas/sandbox-defaults.schema.json) | Global `sandbox.json` shape (P1). |
| [schemas/mask-resolution.schema.json](schemas/mask-resolution.schema.json) | Resolved mask set + provenance for logging/tests. |
| [schemas/project-sandbox-policy.schema.json](schemas/project-sandbox-policy.schema.json) | Optional project policy (P2). |
| [launch-prompts/](launch-prompts/README.md) | Per-phase flow-orchestrator launch prompts (operator-run). |
| [verification.md](verification.md) | Dual-axis operator runbook (Preflight + A/B/C + RUN_DIR + redaction). |

## Scope

**In scope**

- Runtime **auto-derivation** of mask specs from the OpenAI-compat provider
  registry (`src/commands/providers.ts`) plus Anthropic, when a non-empty key is
  present in env or `auth.json`.
- Fail-closed coupling of masks to **TLS terminate** (ADR-0007).
- Parity between **shell_exec** env path and **harness CLI** flag path.
- Global sandbox defaults file (no secrets).
- Optional project policy (no secrets) and init skeleton.
- Dual-axis verification protocol (spawn_subagent network ≠ shell mask).

**Non-goals**

- Storing API keys in the project tree, git, or `keryx init` output.
- Masking arbitrary env vars by default (only known provider keys + explicit
  extras).
- Making TLS MITM the default for all sandbox runs without masks.
- Changing model-provider credential *resolution* for the agent itself (parent
  still needs real keys for LLM calls).
- Go-based tools that ignore CA env vars under TLS terminate (documented
  limitation, ADR-0007).

## Related Modules

- **ADR-0006** — OS sandbox for shell execution  
  (`docs/decisions/keryx-harness/ADR-0006-os-sandbox-shell-exec.md`)
- **ADR-0007** — TLS terminate for HTTPS credential masking  
  (`docs/decisions/keryx-harness/ADR-0007-tls-terminate-https-credential-masking.md`)
- **Project Agent Harness** — security profiles, containment  
  (`docs/requirements/keryx-project-agent-harness/`)
- **Multi-Agent Engine** — child network/policy inheritance  
  (`docs/requirements/keryx-multi-agent-engine/`)
- **Code (implemented baseline)** — `src/lib/shell-config.ts`,  
  `src/commands/providers.ts`, `src/harness/tool/builtin/shell-exec-tool.ts`,  
  `src/harness/process/sandbox/network-run.ts`, `src/commands/harness.ts`

## Honest baseline (current code)

| Capability | Status |
|---|---|
| Global `auth.json` API keys | **implemented** |
| Manual `KERYX_SANDBOX_MASK_ENV` + TLS | **implemented** |
| Harness `--mask-env` / `--tls-terminate` | **implemented** |
| Auto-mask from registry | **not implemented** (this package P0) |
| Global `sandbox.json` defaults | **not implemented** (P1) |
| Project policy + init scaffold | **not implemented** (P2) |
