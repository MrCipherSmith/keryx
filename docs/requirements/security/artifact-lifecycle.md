# Metaproject Security Artifact Lifecycle

Version: 0.1.0

## 1. Purpose

Security artifacts can themselves become sensitive. This lifecycle policy keeps
default storage safe.

## 2. Committable Artifacts

Usually committable:

```text
.metaproject/security.config.json
.metaproject/modules/security.md
.metaproject/skills/security/SKILL.md
.metaproject/data/security/artifacts/latest.md
.metaproject/data/security/artifacts/latest.json
```

Only commit latest artifacts if they contain redacted previews and no raw
sensitive text.

## 3. Local-Only Artifacts

Always local-only by default:

```text
.metaproject/data/security/raw/**
.metaproject/data/security/incidents/**
.metaproject/data/security/redactions/**
```

Projects may publish sanitized incident summaries through CI, but raw incident
payloads must remain local unless explicitly approved.

## 4. Raw Retention

Default:

```json
{
  "rawRetention": "off",
  "storeHashes": true,
  "storeRedactedSamples": true
}
```

Allowed raw retention modes:

- `off`;
- `local`;
- `ci-private`;
- `explicit`.

`explicit` requires a user or project policy opt-in.

## 5. Report Redaction

Reports may include:

- finding ids;
- policy ids;
- source path/kind;
- redacted preview;
- content hash;
- location offsets;
- action and severity;
- remediation.

Reports must not include:

- full secrets;
- full prompts;
- full memory entries;
- unredacted PII;
- complete raw logs with credentials.

