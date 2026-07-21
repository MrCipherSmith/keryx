# Acceptance criteria — flow 103

- AC1: Unit — mode=auto + DEEPSEEK_API_KEY set + no MASK_ENV → mask DEEPSEEK_API_KEY @ api.deepseek.com.
- AC2: Unit — mode=manual + key set + no MASK_ENV → empty masks.
- AC3: Unit — mode=off + explicit MASK_ENV → empty masks.
- AC4: Unit — merge auto KEY@a + explicit KEY@b → injectHosts from explicit.
- AC5: Unit — masks + tls unset + allowAutoTls → tlsTerminate true, tlsSource auto-derived.
- AC6: Unit — masks + tlsExplicit false → ok:false.
- AC7: shell_exec restricted path uses resolver; fail closed on resolve error; wires masks/tls for setupNetworkRun when ok.
- AC8: harness path produces same MaskResolution as shell for equivalent inputs (shared resolver golden).
- AC9: No real secrets in project fixtures; P0.a default maskMode is manual when env unset.
- AC10: Package docs note P0.a opt-in `KERYX_SANDBOX_MASK_MODE=auto`; P1/P2/Verify not claimed implemented.
