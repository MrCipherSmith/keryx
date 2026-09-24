# Flow 305 review round 2 (opus, PR #675)

Round-1 fixes verified (probe P1-P9, 55 CLI parity scenarios byte-identical to 90e90931). 0 blocker, 0 major, 4 minor.

```json keryx:findings
[
 {
  "id": "R2-F1",
  "severity": "minor",
  "title": "refusalAction/allowAction id switch still decides refusal shape for ctx native-search refusals and security --runtime; new stdout-JSON adapters would fail open",
  "file": "src/integrations/codecs.ts",
  "line": 104,
  "detail": "src/ctx/hook.ts:54 uses refusalAction(runtime.id) rather than the runtime's decisionCodec; no test ties the switch to the surface codecs.",
  "impact": "A W5-b stdout-JSON adapter would fail open on native-search and security --runtime refusals.",
  "suggested_fix": "Host decisionCodecFor/refusalAction/allowAction in registry.ts, decisionCodec on HarnessAdapter, CtxRuntime.refuse for hook.ts, parity test.",
  "evidence": "keryx ctx rg refusalAction; no test references decisionCodec.",
  "confidence": "high"
 },
 {
  "id": "R2-F2",
  "severity": "minor",
  "title": "access migrates-legacy is an unverified self-declaration that bypasses the OQ-3 coherence check",
  "file": "src/integrations/registry.test.ts",
  "line": 400,
  "detail": "No test asserts a migrates-legacy key is never created when absent nor its type changed.",
  "impact": "A future surface can reintroduce hooks:array by mislabelling its slot.",
  "suggested_fix": "Assert migrates-legacy slots are never created/retyped by merge/strip; negative control.",
  "evidence": "probe2 Q1.",
  "confidence": "high"
 },
 {
  "id": "R2-F3",
  "severity": "minor",
  "title": "Surface id uniqueness enforced per adapter but owners key by id per file across adapters",
  "file": "src/integrations/registry.ts",
  "line": 187,
  "detail": "Two adapters' surfaces sharing an id on one file both run on apply.",
  "impact": "Latent for W5-b/W8 shared files.",
  "suggested_fix": "Reject duplicate surface ids per relativePath with a negative control.",
  "evidence": "probe2 Q2.",
  "confidence": "high"
 },
 {
  "id": "R2-F4",
  "severity": "minor",
  "title": "Round-1 fixes F2, F7 and F1 have no regression tests",
  "file": "src/integrations/settings-file.ts",
  "line": 43,
  "detail": "Mutations removing round-trip validation, unknown-id refusal and canonical ordering left all tests green; CLI refusal exit 1 untested.",
  "impact": "Fixes can regress silently.",
  "suggested_fix": "Owner tests for antigravity array container, unknown id, shuffled order; one CLI test for refused install exit 1.",
  "evidence": "mutation copy run: 215 pass / 0 fail.",
  "confidence": "high"
 }
]
```
