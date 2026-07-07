# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `gd-metapro flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `gd-metapro flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `gd-metapro security scan <file>` on content containing an AWS access key produces a finding with category `secret`, severity `critical`, action `block`; the raw key value appears in neither `latest.md` nor `latest.json`, and any stored `hash` is HMAC-keyed (not a plain sha256 digest).
- AC2: `gd-metapro security check-output --target memory` on content with an email and a phone number produces `pii` findings with action `redact`, and the redacted output replaces each value with a fixed-width typed mask (e.g. `[REDACTED:email]`), never a partial or length-preserving reveal.
- AC3: `gd-metapro security check-input --source external` on "ignore previous instructions" produces a `prompt-injection` finding with action `warn`; when the same content also instructs sending private data to an external URL, an `egress` finding is produced and the decision escalates to `require-approval` or `block` (resolution precedence `block > require-approval > redact > warn > allow`, honoring per-finding confidence and `minConfidence`).
- AC4: In `ci` mode a blocked finding makes `gd-metapro security report` (and `scan`) exit non-zero; in `advisory` mode the same commands report and exit 0.
- AC5: Changing `mode` from `enforced` to `advisory`, or a `configChecksum` mismatch (policies edited outside the tool), is never silent — the run emits a warning line and records an incident, and a checksum mismatch also yields a `high` `artifact-safety` finding (§14 self-protection).
- AC6: Findings validate against `security-finding.schema.json` and reports against `security-report.schema.json`; committable artifacts (`latest.md`/`latest.json`) contain only policy ids, categories, severities, masked previews, locations, and actions — no hashes of secrets/PII and no raw sensitive values (§10a).
- AC7: `security` is registered as a module: `init` scaffolds it (config, `data/security/*`, `modules/security.md`, manifest entry, gitignore block for `data/security/raw/**` + HMAC key) enabled by default with a `--no-security` opt-out; `update` refreshes service files without touching `data/security`; the HMAC key and `raw/` are gitignored; `gd-metapro standard validate` still passes on this repo.
- AC8: New tests encode each §13 behavioral scenario (secret/PII/injection+egress/ci-exit/config-downgrade/checksum) plus finding/report schema validity; `bun run check` (typecheck + full suite) passes.
- AC9: Docs updated to match: `docs/docs/cli-reference.md` documents `gd-metapro security` + subcommands, `modules.md`/`architecture.md` add the module, `roadmap.md` marks Metaproject Security implemented (Phase 1+2), the security spec/README status notes reflect shipped Phase 1+2 (Phase 3+4 pending); no doc↔code drift for the new surface.
