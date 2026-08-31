# Change Report — Keryx Full Review Remediation

Version: 1.0.0
Status: **implemented and independently verified**.

## Delivered

- Removed the runtime background-registry/shell-exec cycle through a neutral
  process-spawn seam.
- Removed the runtime SAC triangle through narrow wrap-up evidence and harness
  facade modules.
- Replaced the spawn-subagent production dependency on TUI state with an
  injected fleet event sink composed by the shell.
- Separated declining and regressed health scopes while retaining the
  historical `regressions` compatibility count.
- Classified and covered C-01 through C-14; C-11 now returns the explicit,
  redaction-safe `binding_degraded` state.
- Centralized guarded sink materialization and applied guard-before-write to
  memory, wiki, SAC owner writers, project skills, metrics, testing, and
  coverage persistence.
- Enforced durable-write denial after untrusted web output while preserving
  read-only `read_file` research.
- Guarded session storage, session wrap-up, proposal lifecycle, and normal/RLM
  wiki enrichment; needs-approval confirmation now requires explicit human
  security acknowledgement.

## Verification Snapshot

- Focused architecture/health: 11 passed, 0 failed.
- Focused security/shell/catch: 189 passed, 0 failed, 2 live OS sandbox skips.
- Fleet regression suite: 14 passed, 0 failed.
- TypeScript: passed.
- Build: passed.
- Health: 93/100, stable, no gate conditions.
- Graph: background and SAC runtime cycles removed; the documented type-only
  modal-host/shell-chrome cycle remains.
- Full suite: 5372 passed, 48 failed, 18 skipped; no new failure identity.

Detailed full-suite evidence is stored in the flow artifact
`artifacts/full-suite-baseline-comparison.md`.

Independent architecture and security reviewers reported no actionable
findings. The code-verifier gate is PASS after a documentation-only whitespace
fix round.

## Compatibility and Residual Risk

The public health compatibility field `regressions` retains its historical
positive-score meaning. Guarded persistence can reject content that previously
reached a sink; this is the intended fail-closed security change. The existing
48 full-suite failures remain outside this remediation scope and should be
handled separately rather than masked here.
