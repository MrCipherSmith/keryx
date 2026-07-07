# Implement Metaproject Security v0.1 (Phase 1+2: security command + deterministic engine)

Status: formalized
Source: docs/requirements/security/ (review-hardened spec v0.2.0)

## Problem

`docs/requirements/security/` ships a review-hardened spec (v0.2.0) for
**Metaproject Security** — the security/privacy/exfiltration-control layer for
agent inputs, outputs and `.metaproject/` artifacts. Status: "ready for
implementation. Runtime not started." No `gd-metapro security` command exists in
`src/cli.ts`. Implement the deterministic core so the reference implementation
actually provides the module.

## Expected Outcome (scope: spec §16 Phase 1 + Phase 2)

- `src/security/` module: a `SecurityService` (`check`/`redact`/`report`/`gate`)
  with deterministic detectors (secrets, entropy, PII, prompt-injection, egress),
  the resolution precedence + confidence + gate (§7a), config load/validate with
  `configChecksum` self-protection (§14), and redaction/hashing safety (§10a:
  fixed-width masks, HMAC-keyed hashes, no secret/PII leakage into committable
  artifacts).
- Bundled `security-finding` and `security-report` JSON schemas.
- CLI `gd-metapro security status | scan | check-input | check-output | redact |
  report | policy validate | incidents`, wired into the dispatcher + help. `scan`
  and `report` honor the gate/mode (ci exits non-zero on a blocker).
- Reports write `.metaproject/data/security/artifacts/latest.md` + `latest.json`;
  raw retention defaults off; incidents under `data/security/incidents/`.
- `security` registered as a module in `init`/`update` (manifest entry, config +
  data-dir scaffold, gitignore block for `raw/` + HMAC key, module manifest doc,
  MODULE_COMMANDS entry, standard-profile wiring per §12), enabled by default with
  a `--no-security` opt-out.
- The §13 behavioral acceptance scenarios pass; `bun run check` green; docs updated.

## Out of Scope (later phases)

- **Phase 3** — in-process `check()` gates at memory ingest / wiki collect /
  testing publish / gdctx large-output / flow completion write seams.
- **Phase 4** — optional model/API detection backends, `gateway` mode.
- Re-implementing `security-audit` concerns (dependency/secret-in-git scanning)
  — that stays with the `security-audit` skill (§15).
