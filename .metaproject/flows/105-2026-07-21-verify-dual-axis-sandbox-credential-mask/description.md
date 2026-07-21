# Verify dual-axis sandbox credential masking

## Problem

P0 landed a shared mask resolver, but operators need a documented dual-axis
protocol (model path ≠ shell mask path) plus automated redaction/axis tests so
a green model call is never treated as mask proof.

## Expected outcome

- Automated tests: axis separation, S1–S4 reassert, REPORT redaction gate.
- Operator runbook with RUN_DIR layout.
- Pure REPORT builder helper (unit-tested).
- Package README marks Verify delivered; P1/P2 still future.

## Out of scope

P1 sandbox.json, P2 project policy/init, P0.b default=auto, live CI dual-axis.
