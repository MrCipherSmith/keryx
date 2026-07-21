# Acceptance criteria — flow 105

- AC1: Automated tests cover dual-axis separation (Axis A is not mask proof; Axis B is mask).
- AC2: S1–S4 reasserted in unit form (auto derive, manual empty, TLS fail-closed, merge hosts).
- AC3: Redaction gate — fixture secret substring fails a scan of sample REPORT artifact.
- AC4: Operator runbook documents Preflight + A/B/C + RUN_DIR + fail if secret leaks.
- AC5: No P1 sandbox.json and no P2 project policy/init in this flow.
- AC6: Default CI path does not require live network dual-axis (no unflagged live tests).
