# Launch prompt — P0 Auto-mask (flow-orchestrator)
Version: 0.1.0

Copy everything inside the fenced block below into a new agent turn that runs
**flow-orchestrator** (Task Manager). One phase only.

---

```text
Run flow-orchestrator for ONE phase only.

## Metaproject hard gate
Project root: the keryx repo worktree where you start.
Before any search, shell, or subagent: read `<project-root>/.metaproject/index.md`.
Use gdgraph / gdctx / gdwiki / memory per Metaproject rules. Never edit flow.json by hand.
All flow state changes: `keryx flow …` CLI only.

## Intent
Implement **P0 only** of the Sandbox Credential Auto-Mask package:

Package:
  docs/requirements/keryx-sandbox-credential-auto-mask/

Must read before planning:
  - README.md
  - prd.md (FR1–FR5, SC1–SC5, NFR1–NFR4)
  - specification.md (resolver API, derivation rules, AC1–AC8)
  - policies.md (P-SEC, P-MASK, P-MASK-4 model-path exception)
  - implementation-plan.md → section "Phase P0"
  - schemas/mask-resolution.schema.json

Do NOT implement P1 (sandbox.json), P2 (project policy/init), or the full dual-axis
live operator runbook. Verify phase is a separate flow later. You MAY add unit/fixture
tests that satisfy AC1–AC8 as part of P0.

## Existing baseline (do not reimplement)
- Manual mask: KERYX_SANDBOX_MASK_ENV + KERYX_SANDBOX_TLS_TERMINATE (shell-exec-tool)
- parseMaskSpec + setupNetworkRun (network-run.ts)
- ADR-0006 / ADR-0007 (fail-closed: masks require TLS terminate)
- auth.json keys via applySavedApiKeys / envWithSavedApiKeys
- OPENAI_COMPAT_PROVIDERS in src/commands/providers.ts

## P0 deliverables
1. Pure resolver `resolveCredentialMasks` (suggested path:
   src/harness/process/sandbox/mask-resolve.ts) per specification.md.
2. Provider list for auto: OPENAI_COMPAT_PROVIDERS + Anthropic
   (ANTHROPIC_API_KEY @ api.anthropic.com); hostname from baseUrl; skip invalid URL
   with note, not whole-resolve throw when others remain valid.
3. maskMode: auto | manual | off via KERYX_SANDBOX_MASK_MODE.
   **Migration for this flow: P0.a** — when env unset, default **manual**
   (zero surprise). Document how to enable auto:
   `export KERYX_SANDBOX_MASK_MODE=auto`.
   Do NOT flip product default to auto in this flow (that is optional P0.b later).
4. Wire shell-exec-tool.ts: after applySavedApiKeys + env snapshot; when restricted
   network; resolve; on ok:false return tool error (no spawn); on success pass masks
   + tlsTerminate into setupNetworkRun.
5. Wire commands/harness.ts identically for contained runs; add --mask-mode and
   optional --auto-mask (alias for auto).
6. Unit tests AC1–AC6; shell-exec / harness fixtures AC7–AC8 (mock setupNetworkRun
   where needed). No secret values in test logs.
7. Short changelog / package note: P0.a default manual; auto opt-in via env.

## Frozen acceptance criteria (use these for the flow AC; do not invent softer ones)
AC1: Unit test — mode=auto + DEEPSEEK_API_KEY set + no MASK_ENV → mask
     DEEPSEEK_API_KEY @ api.deepseek.com.
AC2: Unit test — mode=manual + key set + no MASK_ENV → empty masks.
AC3: Unit test — mode=off + explicit MASK_ENV → empty masks (explicit ignored).
AC4: Unit test — merge: auto KEY@a + explicit KEY@b → injectHosts from explicit;
     source merged/explicit as specified.
AC5: Unit test — masks non-empty + tls unset + allowAutoTls → tlsTerminate true,
     tlsSource auto-derived.
AC6: Unit test — masks non-empty + tlsExplicit false → ok:false.
AC7: Fixture — shell_exec restricted path invokes resolver and does not spawn when
     resolve fails; passes masks/tls into setupNetworkRun when ok.
AC8: Fixture — harness contained path produces same MaskResolution for equivalent
     inputs as shell path (or shared resolver unit golden).
AC-POL: No API keys written to project tree, init, or committed fixtures as real secrets.
AC-DOC: Requirements package status remains honest (still not "implemented" for P1/P2);
        note P0 runtime slice landed only if code+tests prove AC1–AC8.

## Constraints
- Zero new runtime npm dependencies (dependencies: {} policy).
- Never log or assert full real API key values; fixtures use fake keys.
- Model/subagent credential path is OUT OF SCOPE (do not strip parent LLM keys).
- Prefer smallest coherent change; reuse parseMaskSpec / setupNetworkRun.
- TDD where project rules require: tests first or with implementer workflow.
- code-verifier + focused tests + review-orchestrator before completion choice.
- Never edit flow.json or frozen AC by hand.

## Flow lifecycle
1. keryx flow list — resume only if an active flow is clearly this P0 work; else:
   keryx flow init --title "P0 sandbox credential auto-mask resolver + shell/harness wire-up"
2. Enrich description/context/plan/tasks from the package docs + gdgraph on
   shell-exec-tool, harness.ts, network-run, providers, shell-config.
3. Freeze AC (map to ACn above), keryx flow start.
4. Execute via gdskills workers (tests-creator / task-implementer / code-verifier /
   review-orchestrator) with explicit subagent-dispatch context.
5. When green: STOP and ask completion choice A/B/C (draft PR / verified handoff /
   keep open). Do not invent a PR if user is not available — leave handoff report.

## Out of scope (reject scope creep)
- P1 sandbox.json
- P2 .keryx/sandbox-policy.json and init scaffolding
- Live dual-axis RUN_DIR operator protocol (Verify phase)
- Changing default maskMode to auto globally (P0.b)
- Go-tool CA workarounds beyond existing ADR-0007 docs

## Done report (required)
- flow id + status
- files created/changed
- test commands + results
- AC evidence table
- residual risks
- explicit statement: P1/P2/Verify NOT done
```

---

## After you finish P0

Reply in the docpack session with:

1. flow id  
2. completion choice (A/B/C)  
3. link to PR if any  
4. whether AC1–AC8 are green  

Then request: **«дай промпт Verify»** — the next launch prompt will be written
to `launch-prompts/Verify-flow-orchestrator.md` and pasted for you.
