# Context

Enriched by flow-orchestrator (Phase 1) from the security spec and code.

## Spec (source of truth for requirements)

- `docs/requirements/security/specification.md` — module identity (§2), structure
  (§3), manifest entry (§4), config (§5), CLI (§6), service contract (§6a),
  actions (§7), resolution + gate (§7a), finding/report schema (§8/§9), detection
  MVP (§10), redaction/hashing safety (§10a), self-protection (§14), acceptance
  criteria (§13, gherkin), phases (§16).
- `docs/requirements/security/policies.md` — 6 categories + default actions,
  trust levels, severity mapping.
- `docs/requirements/security/schemas/security-finding.schema.json` — required:
  id, policyId, severity, category, source{kind}, action, confidence, createdAt.
- `docs/requirements/security/schemas/security-report.schema.json` — report shape.
- `docs/requirements/security/artifact-lifecycle.md`, `agent-protocol.md`,
  `policies.md`, `prd.md`.

## Key contract points to honor

- **Resolution precedence:** `block > require-approval > redact > warn > allow`.
- **Confidence:** exact regex/structural ~0.9–1.0; entropy/heuristic ~0.4–0.7;
  injection-intent < 0.5. A policy's action applies only at/above `minConfidence`
  (default 0.5); below → downgrade to `warn`.
- **Injection alone = warn; injection + egress escalates** to require-approval/block.
- **Safety (§10a):** fixed-width length-hiding masks (`[REDACTED:secret]`,
  `[REDACTED:email]`); `redactedPreview` shows only non-sensitive context;
  `hash` is HMAC-SHA256 keyed with a per-project **local-only, never-committed**
  key; committable `latest.md`/`latest.json` contain NO hashes of secrets/PII.
- **Self-protection (§14):** `configChecksum` = sha256 of normalized policy block;
  mismatch → `high` artifact-safety finding + incident; mode downgrade/policy
  disable is allowed but always surfaced (warn + incident).

## Reuse / patterns (blast radius)

- JSON-schema validation: `src/gdskills/contracts.ts` or the newer
  `src/standard/validate.ts` validator (draft-2020-12 with anyOf/format) — reuse
  for finding/report/config validation.
- Command shape: `src/commands/standard.ts` (thin handler → service; exitCode on
  failure) and `src/commands/health.ts` (multi-subcommand, report artifacts).
- Feature/service style: `src/health/` (sources/report/gate) and `src/memory/`.
- Config: `src/health/config.ts` / `src/memory/config.ts` (default + deep-merge +
  render) — mirror for `security.config.json`.
- Manifest registration: `src/commands/init.ts` (module block + `--no-<module>`
  flag + scaffolds), `src/commands/update.ts`, `src/commands/module-commands.ts`
  (MODULE_COMMANDS), `src/standard/profiles.ts` (AGENT/CI module sets), `src/cli.ts`
  (dispatch + printHelp), `.gitignore` (managed block).
- A bundled `metaproject-security` skill already exists under
  `src/gdskills/bundled/skills/quality/metaproject-security/` — do not duplicate.

## Baseline

- `bun run check` green at start (tsc + 107 tests). Health gate: warn.
- Conventions: thin `commands/*` → `<feature>/service` → `lib/*`; handlers own
  `process.exitCode`; new Date().toISOString() for timestamps; no external deps
  (Node/Bun built-ins only, incl. `node:crypto` for HMAC/entropy).
