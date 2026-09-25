# Flow 305 review round 3 (opus, PR #675 @ 6e25e3c1)

R2-F1..F4 closed (14 mutations, 12 killed). ctx hook outputs byte-identical to 90e90931 on 14 payloads. 0 blocker, 0 major, 2 minor.

```json keryx:findings
[
 {
  "id": "R3-F1",
  "severity": "minor",
  "title": "Surface decisionCodec and HarnessAdapter.decisionCodec are two sources of truth with no coherence check",
  "file": "src/integrations/registry.ts",
  "line": 239,
  "detail": "ctx-guard shell blocks use surface.decisionCodec; native-search refusal and security --runtime use adapter.decisionCodec; nothing asserts equality; R2-F1 parity test is circular.",
  "impact": "A W5-b stdout-JSON adapter could get mismatched codecs and fail open on native-search/security refusals.",
  "suggested_fix": "Single source: surface codec derived from the adapter, or coherence check with negative control.",
  "evidence": "Mutation: cursor adapter codec -> EXIT_CODE survives src/integrations.",
  "confidence": "high"
 },
 {
  "id": "R3-F2",
  "severity": "minor",
  "title": "R2-F4(d) does not test round-1 F1 error propagation in the installer wrappers",
  "file": "src/integrations/owner.test.ts",
  "line": 78,
  "detail": "Only installSurfaces/uninstallSurfaces exercised; circular assertion; wrapper mutations survive.",
  "impact": "Round-1 F1 fix has no regression test for security install or any uninstall path.",
  "suggested_fix": "Optional owner override on the wrappers; assert ok:false / throw with a fake-sibling owner; drop the circular assertion.",
  "evidence": "Mutations G5/G6 survive src/integrations, src/ctx, src/security, src/commands.",
  "confidence": "high"
 }
]
```
