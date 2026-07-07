# Implementation Plan

Status: ready

## Approach

Additive feature, following `cli → commands → feature/service → lib`. `security`
is a real module (manifest key `security`, config, data dir, skill) plus a
top-level `gd-metapro security` command. Build the deterministic engine as an
in-process `SecurityService` (the CLI is a thin wrapper), so Phase 3 write-seam
integrations can later call `createSecurityService().check(...)` without rework.
Reuse the `src/standard/validate.ts` draft-2020-12 validator for schema checks
and `node:crypto` for HMAC hashing + entropy. Detectors are pure regex/entropy
functions returning findings; resolution/gate is pure logic; only report/incident
writing touches the filesystem.

## Steps

1. **T2 — Engine (`src/security/`).** types.ts; schemas.ts (bundled finding +
   report schemas); config.ts (default config §5, deep-merge, load/validate,
   `configChecksum` compute/verify §14); detect/ (secrets, entropy, pii,
   injection, egress detectors per §10 + policies.md); redact.ts (fixed-width
   masks + HMAC hashing + safe `redactedPreview`, §10a; local-only key mgmt);
   resolve.ts (precedence + confidence downgrade + gate §7a); report.ts
   (SecurityReport + latest.md/json, committable-artifact leak rule); incidents.ts;
   service.ts (`createSecurityService`: check/redact/report/gate §6a).
2. **T5 — CLI (`src/commands/security.ts`) + wiring.** status/scan/check-input/
   check-output/redact/report/policy validate/incidents; `--json`, `--source`,
   `--target`, `--file`, `--out`, `--since`, `--limit`. Register `security` in
   `cli.ts` dispatch + `printHelp`. `ci` mode → non-zero exit on gate fail.
3. **T6 — Module registration.** init/update manifest entry (`security` enabled,
   `--no-security`), scaffold `security.config.json` + `data/security/{artifacts,
   incidents,redactions,policies,raw}` + `core/security/README.md` + module
   manifest `modules/security.md`; add `security` to MODULE_COMMANDS; wire the
   standard profiles (§12: recommended in agent/ci, in full); add a managed
   `.gitignore` block for `data/security/raw/**` + the HMAC key.
4. **T3 — Tests.** Encode the §13 gherkin scenarios: secret → block + no raw in
   latest.* + HMAC (not plain) hash; PII → redact with typed masks; injection
   alone → warn, injection+egress → escalate; ci mode → non-zero on blocker;
   config downgrade → warn + incident; checksum mismatch → high artifact-safety
   finding + incident. Plus schema-validity of findings/reports. `bun run check`
   green.
5. **T7 — Docs.** cli-reference (security command), modules.md + architecture
   (new module), roadmap (Security → implemented Phase 1+2), README module list,
   security spec/README status notes (Phase 1+2 shipped, Phase 3+4 pending).
6. **T4 — Review + draft PR.** adversarial review (focus: secret leakage in
   outputs, gate/resolution correctness, HMAC key never committed) → code-verifier
   → draft PR → CI → `flow implemented --pr`.

## Risks

- **The module must not leak what it detects.** Highest-risk area: `redactedPreview`,
  `latest.*` committable artifacts, and the HMAC key. Reviewer must specifically
  try to make a secret/PII value appear in a committable artifact.
- **HMAC key lifecycle:** generate per-project, store local-only (`data/security/
  raw/` or keychain), never commit; ensure the gitignore block lands.
- **False positives:** injection heuristics must default to `warn` (low confidence)
  to avoid blocking normal work; only escalate with egress.
- **Self-compliance:** adding a new default-on module must keep `standard validate`
  passing (module manifest + config + data paths present or warning-only).
- **Scope creep:** Phase 3 write-seam integrations are OUT — do not modify memory/
  wiki/testing/gdctx/flow write paths in this flow.
