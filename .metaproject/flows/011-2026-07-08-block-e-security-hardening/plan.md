# Implementation Plan

Status: ready

## Approach

Deterministic early wins first (E2 exfil, E4-checksum PII, E5 multi-runtime hooks, E6 red-team
eval harness) — all pure, network-free detectors/utilities slotting into the existing
`runDetectors` pipeline and the shipped agent-hooks installer. Then the two opt-in models on the
pre-existing `config.backends` seam + Block 0 Asset Resolver (E1 Prompt Guard 2 injection adapter,
E4-NER PII adapter), each a `CapabilityAdapter` with lazy `await import` and a deterministic
fallback. E3 (scan-mcp) already shipped in Block A — a doc cross-reference only. Block-completion
gate = the package-wide byte-identical + no-network test with all backends off (AC0.1/AC0.2/AC0.3).

Single coherent implementer (shared single-writer files: security `config.ts`/`resolve.ts`/
`service.ts`/`types.ts`, `detect/*`, `agent-hooks.ts`, `package.json`, `assets.lock.json`).

## Steps (grouped from spec T1–T27)

1. **E2 exfil (T1–T6).** `policies.egress.allowlist` config; `detect/exfil.ts` (markdown image/link + `<img>`,
   redactable url mask); extend `detect/egress.ts` (non-allowlisted-domain deny-by-default + ssrf-metadata);
   wire into `runDetectors` under `policies.egress.enabled`; `fixtures/exfil/` + tests (100% flagged, benign not,
   redactable spans, empty-allowlist back-compat).
2. **E4-checksum PII (T7–T9).** pure validators in `detect/pii.ts` (IBAN mod-97, Luhn, SSN, IP range) each
   GATING its regex candidate; typed masks; `fixtures/structured-pii/` + tests (valid flagged, invalid NOT,
   fixed-width masks).
3. **E5 multi-runtime hooks (T10–T12).** `agent-hooks/runtimes.ts` registry (cursor/windsurf/generic-mcp +
   Claude Code); generalize the sentinel installer (`install/uninstall --runtime <...|all>`), merge-safe/
   idempotent; per-runtime validators + merge-safety + idempotent + targeted-uninstall tests.
4. **E6 red-team eval (T13–T16).** `fixtures/{injection,secret}/` + `fixtures/thresholds.json` (reuse exfil +
   structured-pii); `eval/harness.ts` (per-detector FN rate, deterministic report); `security eval --corpus
   --with-model` (non-zero exit on breach); CI job `security eval --corpus all` + seeded-regression flip test.
5. **E1 injection model (T17–T21).** `backends.injectionModel` config (default off); prompt-guard-2 assets in
   `assets.lock.json`; `detect/injection/adapter.ts` CapabilityAdapter (lazy import, isAvailable=dep+asset,
   run→prompt-injection gated by minConfidence, never throws); `runDetectors` merges model + regex, catches
   errors → deterministic; availability true (recall>regex baseline via stub) / false (byte-identical fallback,
   warn-once, exit 0) tests; escalation preserved.
6. **E4-NER (T22–T24).** wire `backends.piiModel`; `detect/pii/ner-adapter.ts` over resolveCapability; merge NER
   pii when available, no-op fallback; availability true/false tests.
7. **E3 cross-ref (T25).** doc pointer to Block A scan-mcp/redactRaw; confirm `detect/mcp.ts` conventions. No code.
8. **Package gate + docs (T26, T27).** package-wide C0-7 gate (all backends off + no assets ⇒ byte-identical;
   no-network sandbox); update roadmap-2026 README status (mark E ✅ landed — completes the roadmap).
9. **Review + PR.** Adversarial review (byte-identity / no-top-level-import / no-network / leak-safety / never-throw).

## Risks

- **Byte-identity regression (top):** any change to `runDetectors` default output breaks AC0.1. Mitigation: new
  detectors gated behind `policies.egress.enabled`/backends flags; empty allowlist ⇒ today's behavior; the
  existing security suite runs unchanged; package-wide byte-identical + no-network test is the hard gate.
- **PII false-positive elimination must not drop true positives:** checksum validators GATE the regex candidate —
  a valid-checksum item must still flag. Mitigation: `fixtures/structured-pii/` asserts both directions.
- **Egress back-compat:** the new deny-by-default rule must be inert when allowlist is empty (today's send-verb
  proximity behavior). Mitigation: AC2.3 test on the existing suite + empty-allowlist fixture.
- **Adapter never-throws / no top-level import:** Prompt Guard 2 / NER runtime lazy-imported inside the adapter
  only; errors caught by the seam → deterministic path + warn-once + exit 0. Extend the static import guard.
- **Model assets offline:** availability-true tests use a stubbed asset/adapter (deterministic); the fallback +
  no-network + byte-identical paths always run. FN-rate harness runs pure by default (`--with-model` optional).
- **Hook merge-safety:** a 2nd runtime install must preserve user keys + be idempotent; targeted uninstall only.
