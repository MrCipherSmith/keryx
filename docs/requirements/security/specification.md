# Metaproject Security: technical specification

Version: 0.1.0

Status: draft. Runtime implementation is future work.

## 1. Purpose

Metaproject Security provides policy-based scanning, redaction, guardrails and
audit reports for project artifacts, external content, agent outputs and
orchestrated flows.

Enforcement is guaranteed only where `gd-metapro` controls the workflow.
Elsewhere the module provides agent-facing rules, validation commands and
advisory reports.

## 2. Module Identity

- Module name: `Metaproject Security`
- Manifest key: `security`
- CLI namespace: `gd-metapro security`
- Skill path: `.metaproject/skills/security/SKILL.md`
- Config: `.metaproject/security.config.json`

## 3. Structure

```text
.metaproject/
  security.config.json
  core/
    security/
      README.md
  data/
    security/
      artifacts/
      incidents/
      redactions/
      policies/
      raw/
  modules/
    security.md
  skills/
    security/
      SKILL.md
```

`raw/` is local-only and ignored by default. The module should operate without
persisting raw content.

## 4. Manifest Entry

```json
{
  "security": {
    "enabled": true,
    "version": "0.1.0",
    "core": ".metaproject/core/security",
    "data": ".metaproject/data/security",
    "manifest": ".metaproject/modules/security.md",
    "config": ".metaproject/security.config.json",
    "commands": [
      "status",
      "scan",
      "check-input",
      "check-output",
      "redact",
      "report",
      "policy",
      "incidents"
    ],
    "capabilities": [
      "security.secrets",
      "security.pii",
      "security.prompt-injection",
      "security.egress-control"
    ]
  }
}
```

## 5. Config

```json
{
  "schemaVersion": 1,
  "mode": "advisory",
  "rawRetention": "off",
  "storeHashes": true,
  "storeRedactedSamples": true,
  "policies": {
    "secrets": { "enabled": true, "action": "block" },
    "pii": { "enabled": true, "action": "redact" },
    "promptInjection": { "enabled": true, "action": "require-approval" },
    "egress": { "enabled": true, "action": "block" },
    "artifactSafety": { "enabled": true, "action": "redact" }
  },
  "backends": {
    "rules": { "enabled": true },
    "entropy": { "enabled": true },
    "piiModel": { "enabled": false, "provider": "custom" },
    "externalApi": { "enabled": false }
  }
}
```

Modes:

- `advisory` - report and recommend actions.
- `enforced` - block/redact inside `gd-metapro` controlled workflows.
- `ci` - validate publishable artifacts and exit non-zero on configured
  blockers.
- `gateway` - future model/runtime proxy mode.

## 6. CLI

```bash
gd-metapro security status
gd-metapro security scan <path> [--json]
gd-metapro security check-input [--source <kind>] [--file <path>]
gd-metapro security check-output [--target <kind>] [--file <path>]
gd-metapro security redact <path> [--out <path>]
gd-metapro security report [--since <ref|date>]
gd-metapro security policy validate
gd-metapro security incidents [--limit <n>]
```

`check-input` and `check-output` may read stdin in the implementation, but the
spec does not require raw stdin retention.

## 7. Actions

Policy result actions:

- `allow` - no material risk.
- `redact` - content is safe after redaction.
- `block` - content must not be used or published.
- `require-approval` - human confirmation required.
- `warn` - low-confidence or advisory finding.

## 8. Finding Schema

See [schemas/security-finding.schema.json](schemas/security-finding.schema.json).

Core fields:

- `id`;
- `policyId`;
- `severity`;
- `category`;
- `source`;
- `target`;
- `action`;
- `confidence`;
- `redactedPreview`;
- `hash`;
- `location`;
- `remediation`.

## 9. Report Schema

See [schemas/security-report.schema.json](schemas/security-report.schema.json).

Reports must include:

- `schemaVersion`;
- `createdAt`;
- `mode`;
- `gate`;
- finding counts by severity/action/category;
- top findings;
- storage policy and raw retention mode;
- integration metadata.

## 10. Default Detection MVP

MVP detectors:

- token/key regexes for common providers;
- private key blocks and `.env` style assignments;
- URL credentials;
- JWT-like token shape;
- high-entropy string heuristic;
- basic email/phone/address/person-name PII patterns;
- prompt injection phrase and intent heuristics;
- external URL egress attempts;
- references to private memory/wiki/raw files in external content instructions.

Model backends such as local PII classifiers or external privacy APIs are
optional implementation plugins, not standard requirements.

## 11. Integration Points

### gdctx

`gdctx` should be able to run security redaction before summarizing raw logs or
large command output.

### memory

`memory ingest` should call `security check-output --target memory` before
writing accepted entries.

### gdwiki

`wiki collect` should call `security check-output --target wiki` before writing
drafts.

### testing

Testing reports should run security checks before publishing raw or normalized
logs.

### health

Health may import security reports as a source, but Security owns prompt,
artifact and exfiltration policies.

### gdskills

`skill-verify-skill` should treat repeated security findings as skill-learning
signals when the skill owns the affected workflow.

### flow

Sensitive flows may require a clean security gate before `implemented` or
`complete`.

## 12. Standard Profile

Metaproject Standard profiles should treat `security` as:

- optional in `minimal`;
- recommended in `agent`;
- recommended in `ci`;
- included in `full`.

## 13. Acceptance Criteria

- `gd-metapro init` can eventually offer the Security module as optional.
- `gd-metapro update` can refresh service files without touching security data.
- The module writes `latest.md` and `latest.json`.
- Raw retention is off by default.
- Agent skill clearly states advisory versus enforced boundaries.
- Reports are consumable by health, memory and gdskills without direct imports.

