# Context — flow 111

## Package

`docs/requirements/keryx-sandbox-harness-hardening/` (H0 on main).

Must-read: README, prd, specification (AC-H1..H8), policies, agent-protocol,
metrics-and-validation, implementation-plan, brainstorm, schemas/probe-report.schema.json.

## Code touch-points

| Area | Path |
|------|------|
| Harness CLI exec | `src/commands/harness.ts` |
| Shared mask resolve | `src/harness/process/sandbox/mask-resolve.ts` (reuse; no fork) |
| Sandbox adapter | `src/harness/process/sandbox/adapter.ts` |
| Wrap / detect | `wrap.ts`, `detect.ts` |
| Shell path parity | `src/harness/tool/builtin/shell-exec-tool.ts` |
| Redaction helpers | `src/harness/process/sandbox/dual-axis-report.ts` (`countSecretLeaks`) |
| Executor | `src/harness/process/executor.ts` (spawn-error → blocked + reason) |
| ADR-0007 | `docs/decisions/keryx-harness/ADR-0007-tls-terminate-https-credential-masking.md` |
| Probe deliverable | `scripts/sandbox-deep-probe.sh` (new) |
| Operator guide (H3 light) | `docs/requirements/keryx-os-sandbox/operator-guide.md` |
| Roadmap | `docs/requirements/roadmap.md` |

## Findings

- `resolveMasksFromSandboxEnv` / `resolveCredentialMasks` already fail-closed for non-empty masks without TLS (manual mode / explicit TLS=0). Harness already calls the shared resolver early.
- Gap: harness early mask failure prints plain text (not structured `blocked` JSON); no dedicated harness-path unit test for mask-without-TLS.
- Gap: sandboxed helper failures often become `completed` + `exitCode: 71` with no `reason` / `sandbox.detail`.
- Probe script does not exist yet; matrix min A2,B1,B2,C1,C2,F1,R1 required on macOS.
- Zero new runtime npm deps; prefer shared mask-resolve.

## Graph / memory

- gdgraph on mask-resolve: limited dependents (harness, shell-exec, dual-axis).
- memory search: no prior accepted lessons for this package.

## Routing audit

- graph_used: yes (mask-resolve affected + ctx rg)
- wiki_used: not-relevant (package docs are source of truth; wiki path absent)
- ctx_used: yes
- raw_rg_used: no
