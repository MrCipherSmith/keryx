# Flow 019 — Release 1 boundary re-run (W16 evidence E-01…E-03 + H-01 provider negatives)

Status: formalized
Source: user description (harness runbook — Release 1 boundary; W16 re-runs each boundary)

## Problem

All 16 implementation waves are built (W1–W15 + the last wave W14 real provider). Two
boundary tasks remain to CLOSE Release 1: (A) produce the Release 1 release-evidence
package (W16 E-01…E-03, mirroring the W16(R0) boundary docs) for the whole Release 1
surface (W8–W15 + W14), and (B) run the H-01 provider negative families that were
deferred because they depended on the W14 real adapter — now that the Anthropic adapter
exists, red-team it offline. This is docs + tests only; no new runtime code except the
H-01 provider-negative test files.

## Expected Outcome

### (B) H-01 provider negatives (test-only, done first so the evidence reflects it)
- A non-vacuous, OFFLINE red-team suite over the W14 `src/harness/provider/anthropic/`
  adapter covering the deferred provider negative families — timeout, rate-limit,
  malformed event, truncation, egress-deny, cancellation, authentication — each asserted
  fail-closed (correct `ProviderErrorKind`, no spurious `model_end`, credential never
  leaked). Reuse the W14 adapter + recorded fixtures + mocked `fetch`; no live network.

### (A) Release 1 evidence (docs + review only)
- **E-01** — `docs/decisions/keryx-harness/E-01-release1-evidence-matrix.md`: a
  capability → source / test / commit matrix for the Release 1 surface (W8 resume, W9
  branch/compaction, W10 mutation, W11 flow integration, W12 child agents, W13 parallel
  scheduling, W15 hardening, W14 real provider — incl. the T5 provider negatives) plus a
  research-ledger update and migration notes; every claim marked
  implemented / planned / deferred (traceability gate).
- **E-02** — `docs/decisions/keryx-harness/E-02-release1-review-package.md`: an
  independent multi-lens review (architecture / contract / logic / security /
  testing-replay / performance / Gherkin over S-01…S-12) of the built Release 1, with a
  GO / NO-GO verdict and any P0/P1. Read-only — the source under review is not modified.
- **E-03** — `docs/decisions/keryx-harness/E-03-release1-handoff.md`: promote the
  roadmap/package and write the Release 1 → Release 2 handoff (DAG, frozen-AC proposal,
  gates, constraints, out-of-scope), **only if E-02 finds no BLOCKER/P0/P1**.

## Out of Scope (do NOT touch)

- No new runtime/production code — E-01/E-02/E-03 are docs/reviews only; the ONLY code
  added is the H-01 provider-negative TEST files under `src/harness/provider/anthropic/`.
- No Release 2 work: the `@release-2` scenarios (child dispatch canonical result,
  bounded parallel wave, extension provenance/escalation) are documented as the next
  track in E-03, NOT implemented here.
- The frozen requirements package + frozen ADR-0001…0004 + canonical contract schemas +
  `src/eval/` + `src/contracts/` — read/cite only. New docs go under
  `docs/decisions/keryx-harness/` (Release 1 files; do NOT overwrite the R0 boundary
  docs — they are the historical R0 record).
- No live network (recorded transcripts / mocked `fetch` only); no new dependency
  (`dependencies` stays `{}`); the harness never writes flow.json (D-02); deterministic
  (no `Date.now`/`Math.random`).
