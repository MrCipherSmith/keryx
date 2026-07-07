# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `gd-metapro flow task done <id> <taskId>`.

| ID | Kind | Title | Satisfies |
|----|------|-------|-----------|
| T1 | context | Collect context + blast radius (done in Phase 1) | — |
| T2 | implement | Engine `src/security/`: detectors, config+checksum, redact/HMAC, resolve/gate, report, incidents, service, schemas | AC1–AC6 |
| T5 | implement | CLI `src/commands/security.ts` (status/scan/check-input/check-output/redact/report/policy/incidents) + cli.ts wiring + printHelp | AC1–AC5 |
| T6 | implement | Module registration: init/update manifest+scaffold, MODULE_COMMANDS, standard profiles, gitignore block | AC7 |
| T3 | test | §13 behavioral tests + schema validity; `bun run check` green | AC8 |
| T7 | docs | cli-reference, modules.md/architecture, roadmap, README, security spec status | AC9 |
| T4 | review | adversarial review (leak-focused) + code-verifier + draft PR | AC8 |

## Task detail

- **T2:** `types.ts`, `schemas.ts` (bundled finding+report schemas), `config.ts`
  (default §5 + deep-merge + load/validate + `configChecksum` §14), `detect/*`
  (secrets/entropy/pii/injection/egress per §10 + policies.md, with confidence),
  `redact.ts` (fixed-width length-hiding masks + HMAC-SHA256 keyed hashing + safe
  `redactedPreview`; local-only never-committed key — §10a), `resolve.ts`
  (precedence `block>require-approval>redact>warn>allow` + minConfidence downgrade
  + gate §7a), `report.ts` (latest.md/json; committable artifacts carry NO
  secret/PII hashes), `incidents.ts`, `service.ts` (`createSecurityService`).
- **T5:** thin handler; `scan`/`report` honor mode+gate (ci → exit 1 on blocker);
  `check-input --source`, `check-output --target`, `redact --out`, `report --since`,
  `incidents --limit`; `policy validate` checks config+checksum.
- **T6:** `security` module enabled by default (`--no-security`); scaffold config +
  `data/security/{artifacts,incidents,redactions,policies,raw}` + `core/security/
  README.md` + `modules/security.md`; MODULE_COMMANDS `security` entry; profiles
  (§12: recommended agent/ci, included full); managed `.gitignore` block for
  `data/security/raw/**` + HMAC key file.
- **T3:** one test per §13 scenario + schema validity + `standard validate` still
  passes on this repo.
