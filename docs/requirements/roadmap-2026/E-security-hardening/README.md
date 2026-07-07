# Block E — Security Hardening

Version: 1.0.0
Status: **spec ready**
Language: EN (mirrors the existing `docs/requirements/security/` package, per `DOC-4`).
Mode: `task_in_project` — extends the **already-shipped** `security` module (`src/security/`); does NOT re-spec it.

Block E raises the **opt-in ceiling** of the shipped `security` module while keeping its
deterministic regex/checksum detectors as the **floor**. Every model feature rides the
module's *pre-existing* `config.backends` seam and Block 0's Asset Resolver / Capability
Seam; every non-model feature is a pure, network-free detector that slots into the
existing `runDetectors` pipeline and emits `DetectorMatch[]`. With zero opt-in flags set
and no assets present, the module behaves **byte-identically to today** (`C0-7`).

## Work items (this block) and how they map to the problem-statement goals

| Item | Title | Goal | Constraints | Kind |
|------|-------|------|-------------|------|
| **E1** | Semantic injection detection (Prompt Guard 2 22M/86M, opt-in local model) | `G-E1` | `E-1 E-2 E-13`, `C0-*`, `A-*` | opt-in model, rides `backends` seam |
| **E2** | Modern exfil coverage: markdown-image / reference-link (EchoLeak / CVE-2025-32711), deny-by-default egress **domain allowlist**, SSRF / private-IP / metadata-endpoint patterns | `G-E2` | `E-3 E-4`, `E-9` | deterministic, early win |
| **E3** | MCP-boundary scanning (`security scan-mcp` + routing MCP tool output through `redactRaw`) | `G-E3` | `E-5`, `M-5` | **specified in Block A — referenced here only** |
| **E4** | Checksum-verifiable deterministic PII (IBAN, credit-card + Luhn, SSN, IP) + optional NER backend (Presidio-style) | `G-E5` | `E-3 E-6`, `E-1 E-13`, `E-9` | deterministic validators + opt-in model |
| **E5** | Multi-runtime hook installer (Cursor / Windsurf / generic MCP-client configs, merge-safe) | `G-E4` | `E-7` | deterministic, early win |
| **E6** | Red-team / eval harness: labeled fixture corpus (injection / exfil / secret / PII) with a CI **false-negative-rate gate** | `G-E6` | `E-8`, `F-1..F-4` | deterministic, early win |

> **Numbering note (for the consistency-checker).** This block's item labels (E1…E6) follow
> the *block scope* handed to the spec-writer. The mapping to the problem-statement goals is
> the `Goal` column above: E4↔`G-E5` (PII) and E5↔`G-E4` (hooks) are transposed relative to the
> problem-statement's own E-numbering. All references below cite the **goal** (`G-E*`) and the
> **constraint** (`E-*`, `C0-*`, `A-*`, `M-*`, `F-*`) IDs, which are unambiguous.

## Sequencing (deterministic early wins first)

1. **E2, E4-checksum, E5, E6** are deterministic and network-free — they need only Block 0's
   fixture-harness convention and land first, independently of A.
2. **E1 and E4-NER** are opt-in models on the existing `backends` seam + Block 0 Asset Resolver
   — lowest integration risk, no A dependency.
3. **E3** ships **with Block A** (tool output untrusted from day one, `M-5`). Here it is only
   cross-referenced; its spec lives in `A-interop-mcp/`.

## Documents

- [prd.md](prd.md) — problem, goals + metrics, non-goals, user/agent stories, traceability.
- [specification.md](specification.md) — the injection-model adapter behind `backends`; the
  markdown-image / reference-link + egress-allowlist + SSRF detectors; deterministic checksum
  PII + optional NER; the multi-runtime hook installer; the red-team fixture corpus + FN-rate CI
  gate; and the E3 cross-reference to Block A. Follows the `DOC-3` section order.
- [acceptance-criteria.md](acceptance-criteria.md) — the hard, testable ACs.
- [tasks.md](tasks.md) — atomic T1..Tn with kinds and dependencies (incl. Block 0).

## Depends on

- **Block 0 — Capability Seam**: `resolveCapability(cwd, id) → Adapter | null`, the Asset Resolver
  (`assets.lock.json` + `security assets pull/list/verify`), and the fixture-corpora harness.
- **Block A** (for E3 only): the MCP surface whose tool output E3 routes through `redactRaw`.

## How to run this block via `gd-metapro flow`

```bash
gd-metapro flow init     roadmap-2026/E-security-hardening
gd-metapro flow freeze   <flow-id>
gd-metapro flow start    <flow-id>
gd-metapro flow task     <flow-id> <task-id>
gd-metapro flow ac       <flow-id> <ac-id>
gd-metapro flow check    <flow-id>     # gate incl. the E6 FN-rate harness
gd-metapro flow complete <flow-id>
```
