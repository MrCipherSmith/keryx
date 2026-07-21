# Launch prompt — H1 fail-closed + diagnostics
Version: 0.1.0

```text
Run flow-orchestrator for ONE phase only: H1 of keryx-sandbox-harness-hardening
(mask/TLS fail-closed on harness + spawn failure diagnostics).

Hard gate: read <project-root>/.metaproject/index.md first.
Never edit flow.json by hand.

Package: docs/requirements/keryx-sandbox-harness-hardening/
Read: README, specification AC-H1/H2, policies P-SEC-1, implementation-plan H1.

Do NOT reimplement OS sandbox or mask-resolve core (already landed).
Do NOT raise tool budget or multiline allow (PR #180/#181 done).

Deliver:
1) harness exec / shell path: non-empty masks without TLS → fail closed + unit test
2) sandbox spawn failure surfaces reason/detail (not bare exit 71 only) + test
3) zero new npm deps; ADR-0007 intact

Done report: flow id, files, tests, PR URL, residual risks.
```
