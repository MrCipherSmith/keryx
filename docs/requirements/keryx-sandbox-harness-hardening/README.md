# Keryx Sandbox Harness Hardening
Version: 0.1.0

## Status

**implemented (H1 + H2 + H3-light)** — runtime + portable probe landed; H0 docs were already on main.

Closes operator and security gaps found during a live macOS deep sandbox probe
(2026-07-21) and follow-on agent-shell UX work. Does **not** re-implement OS
sandbox containment (already landed in `keryx-os-sandbox` + credential
auto-mask). Focus is **fail-closed contracts, diagnostics, operator automation,
and harness ergonomics**.

| Track | Status |
|-------|--------|
| OS FS + network-off + allowlist (macOS) | **already implemented** — probe PASS |
| Tool-call budget 8→48 | **landed** (PR #180) |
| Multiline shell allow patterns | **landed** (PR #181) |
| Mask-without-TLS fail-closed (CLI/harness) | **landed** (H1) |
| `harness exec` exit-71 / path diagnostics | **landed** (H1) |
| Portable deep-probe script + REPORT contract | **landed** (H2) |
| Decisions-over-exitCode agent guidance | **landed** (H2/H3 docs) |

## Purpose

Make sandbox **operable and verifiable** without multi-hour agent thrash:

1. Security contracts that probe marked WEAK/UNKNOWN become **explicit fail-closed**.
2. Failures return **actionable reasons** (not bare exit 71).
3. Operators get a **one-shot probe** that writes RUN_DIR + REPORT.md.
4. Agents read **network.decisions** and blocked outcomes correctly.

## Document Index

| Document | Purpose |
|----------|---------|
| [README.md](README.md) | Overview, status, index, scope |
| [prd.md](prd.md) | Problem, goals, requirements, success, risks |
| [specification.md](specification.md) | Identity, surfaces, contracts, acceptance criteria |
| [policies.md](policies.md) | Fail-closed and operator safety rules |
| [agent-protocol.md](agent-protocol.md) | How agents run probes and interpret outcomes |
| [metrics-and-validation.md](metrics-and-validation.md) | Measurable gates and dual-axis links |
| [implementation-plan.md](implementation-plan.md) | Phased delivery (H0–H3) |
| [brainstorm.md](brainstorm.md) | Probe findings → decisions |
| [schemas/probe-report.schema.json](schemas/probe-report.schema.json) | REPORT.md companion JSON shape |
| [launch-prompts/README.md](launch-prompts/README.md) | flow-orchestrator launch prompts |

## Scope

**In scope**

- `keryx harness exec` mask/TLS fail-closed parity with shell resolver (ADR-0007).
- Structured diagnostics when sandboxed spawn fails (exit 71 class).
- Repo-owned portable deep-probe script + REPORT / redaction contract.
- Agent/operator guidance: decisions vs exitCode; no false-pass.
- Optional TUI/transcript hints for allowlist denials.

**Out of scope**

- New mask algorithms or providers.
- Making Linux restricted-network fully functional (still fail-closed per OS package).
- Default-on shell sandbox for interactive agent.
- Replacing Seatbelt/bubblewrap.
- P3 multi-agent fleet features.

## Related modules

- [keryx-os-sandbox](../keryx-os-sandbox/README.md) — containment baseline
- [keryx-sandbox-credential-auto-mask](../keryx-sandbox-credential-auto-mask/README.md) — maskMode auto / dual-axis
- [keryx-project-agent-harness](../keryx-project-agent-harness/README.md) — harness exec / receipts
- [keryx-opentui-shell](../keryx-opentui-shell/README.md) — interactive approval UX
- ADR-0006, ADR-0007 under `docs/decisions/keryx-harness/`
- Linux runbook: `docs/verification/linux-sandbox-verification.md`

## Honest baseline (probe 2026-07-21, macOS)

| Capability | Probe verdict |
|------------|---------------|
| Write inside workspace | PASS |
| Write outside / `/tmp` | PASS (denied) |
| Network off | PASS |
| Restricted allowlist + decisions | PASS |
| Structural metachar guard | PASS |
| Credential mask path | UNKNOWN / WEAK |
| Live bun smokes | SKIP (PATH) |
| Helper-script exec | exit 71 UNKNOWN |

## How to run the deep probe (H2)

From the repo root (macOS recommended for full restricted matrix; Linux documents fail-closed):

```bash
./scripts/sandbox-deep-probe.sh
# optional live section:
./scripts/sandbox-deep-probe.sh --live-smokes
```

- Creates `RUN_DIR` at `.metaproject/tmp/sandbox-probe-<utc>/`
- Writes `REPORT.md` + `report.json` (see [schemas/probe-report.schema.json](schemas/probe-report.schema.json))
- Uses portable `date` (no GNU `%N`), absolute paths, CONTROL runs on deny rows
- Overall is `PASS` | `PASS_WITH_GAPS` | `FAIL`; redaction hit → `FAIL`
- Fixtures use synthetic secrets only (`sk-fixture-…`)

Read only `RUN_DIR/REPORT.md` for the summary. Do not re-run the matrix
tool-by-tool unless the script is missing.

## Delivery phases (summary)

| Phase | Name | Outcome |
|-------|------|---------|
| **H0** | Contract locks | Spec + AC frozen; no silent regressions — **done** |
| **H1** | Fail-closed mask/TLS + diagnostics | Security + exit-71 reasons — **done** |
| **H2** | Operator probe automation | `scripts/sandbox-deep-probe.sh` + schema — **done** |
| **H3** | Agent UX polish (light) | decisions rule + operator-guide link — **done** (no heavy TUI) |
