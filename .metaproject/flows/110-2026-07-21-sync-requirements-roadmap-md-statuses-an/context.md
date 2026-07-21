# Context

Collected by flow-orchestrator from the 12-package docs/requirements audit.

## Audit conclusions (treat as inputs)

### Packages whose Status contradicts code
| Package | Claimed | Reality | Evidence |
|---|---|---|---|
| keryx-opentui-shell | `draft` (v0.1.0) | implemented, default shell | `src/tui/tui-shell.ts` (~80 KB); `src/commands/shell.ts:1043-1049` selects OpenTUI when stdout.isTTY; ADR-0005 Accepted (Phase 1); `package.json:48` `@opentui/core ^0.4.5` optionalDep. Also MISSING from roadmap. |
| keryx-metaproject-native | `draft — no new runtime` (v0.1.0) | Phases 1-3 landed | `src/harness/tool/metaproject-{port,adapter,operations}.ts`; `src/mcp/metaproject-tools.ts` (`toMcpTools`); `src/flow/schema.ts` + `keryx flow schema` CLI (flow 040). Pending: S1 `RunDeps.metaprojectPort`, Phase 4 policy-context, legacy adapter retirement. |
| keryx-multi-agent-engine | `draft — no new runtime` (v0.1.0) | A→B→C shipped | flows 088-101. `src/harness/child/{model,spawn,ledger,quarantine,escalation,worktree,peer}.ts`; `src/harness/monitor/reduce.ts` + `keryx agents monitor`. Cost-dimension (flow 101) — the documented "deferred" extension — is in. |
| keryx-project-agent-harness | `no runtime claimed` (README v0.7.0) | Release 0 + most of 1/2 | `src/harness/` = 175 files / 30 subdirs: session, policy, evidence, tool registry, provider (fake+anthropic+ollama), resume, branch, mutation, child, extension, sandbox. `keryx harness run|exec|extension|wave`. MISSING from roadmap. Dead link: `.metaproject/jobs/requirements-remediation--keryx-project-agent-harness/flow-orchestrator-handoff.md`. |
| keryx-sandbox-credential-auto-mask | `specification.md:17` says `draft — not implemented` | P0/P1/P2/P0.b merged | PR #175-179, flows 103/105/106/107/108. `src/harness/process/sandbox/mask-resolve.ts:329` `mode = "auto"`. Most package docs still at v0.1.0. |

### Minor staleness
- `keryx-execution-observability`: `prd.md` + `agent-protocol.md` at v0.1.0, rest at v0.2.0. No claim overstated.
- `keryx-os-sandbox`: spec §2/§7-§9 + README index omit `mask-resolve.ts`, `dual-axis-report.ts`, `--mask-mode auto|manual|off` (wired in `harness.ts`).

### Already accurate (no change)
managed-review-feedback-loop, flow-reviewer, gdgraph-java-import-resolution,
keryx-context-operations, keryx-telegram-transport.

## Affected files (docs-only)
- `docs/requirements/roadmap.md`
- `docs/requirements/keryx-opentui-shell/{README,prd,specification}.md`
- `docs/requirements/keryx-metaproject-native/{README,prd,specification}.md`
- `docs/requirements/keryx-multi-agent-engine/{README,prd,specification,agent-protocol,brainstorm,implementation-plan}.md`
- `docs/requirements/keryx-project-agent-harness/README.md` (+ reconcile `feature-summary.md`)
- `docs/requirements/keryx-sandbox-credential-auto-mask/{prd,brainstorm,policies,implementation-plan,metrics-and-validation,verification,specification}.md`
- `docs/requirements/keryx-execution-observability/{prd,agent-protocol}.md`
- `docs/requirements/keryx-os-sandbox/{README,specification}.md`
- NEW: `docs/requirements/_launch-prompts/requirements-sync-flow-orchestrator.md` (already created)

## Constraints
- No edits under `src/`.
- Preserve useful prose; fix only Status/Version lines + minimal notes.
- Every edited Markdown file must keep a `Version:` header.

## Code Health
- gate: pass (as of 2026-07-20T23:07:55.416Z)
- docs-only flow → no health regression expected.
