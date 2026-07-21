# Launch prompt — H2 portable deep probe
Version: 0.1.0

```text
Run flow-orchestrator for ONE phase only: H2 of keryx-sandbox-harness-hardening
(portable sandbox deep-probe script + REPORT).

Hard gate: read <project-root>/.metaproject/index.md first.
Never edit flow.json by hand.

Package: docs/requirements/keryx-sandbox-harness-hardening/
Read: specification AC-H3–H5, metrics-and-validation, schemas/probe-report.schema.json,
agent-protocol, implementation-plan H2.

Deliver:
1) scripts/sandbox-deep-probe.sh — portable (no date %N), absolute paths, CONTROLs
2) RUN_DIR under .metaproject/tmp/sandbox-probe-<ts>/
3) REPORT.md + optional report.json; redaction fail on secret substrings
4) Matrix min: A2,B1,B2,C1,C2 (macOS)/fail-closed note (Linux), F1, R1
5) zero new npm deps; no real secrets in fixtures

Done report: flow id, files, sample REPORT path, residual risks.
```
