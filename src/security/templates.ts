// Canonical capability identifiers advertised by the security module in the
// generated manifest (specification.md §4). Kept here as the single source of
// truth so init and update never drift.
export const SECURITY_CAPABILITIES = [
  "security.secrets",
  "security.pii",
  "security.prompt-injection",
  "security.egress-control",
] as const;

export function securityCapabilities(): string[] {
  return [...SECURITY_CAPABILITIES];
}

export function renderSecurityManifest(): string {
  return `# security

Version: 0.1.0

## Purpose

Policy-based scanning, redaction, guardrails, and audit reports for project
artifacts, external content, agent outputs, and orchestrated flows. Enforcement
is guaranteed only where \`gd-metapro\` controls the workflow; elsewhere the
module provides agent-facing rules, validation commands, and advisory reports.

Ownership boundary: this module owns the agent/artifact boundary (prompts,
external text, tool output, writes to memory/wiki/reports/task context, prompt
injection, exfiltration, redaction, incident trail). Dependency vulnerabilities
and committed-secret history stay with the \`security-audit\` skill.

## Agent Entry

- Read this manifest before claiming security status or gate results.
- Prefer the curated report \`data/security/artifacts/latest.md\`.
- Treat findings as signals; verify against source before acting.

## Commands

- \`gd-metapro security status\`
- \`gd-metapro security scan <path> [--json] [--source <kind>]\`
- \`gd-metapro security check-input [--source <kind>] [--file <path>]\`
- \`gd-metapro security check-output [--target <kind>] [--file <path>]\`
- \`gd-metapro security redact <path> [--out <path>]\`
- \`gd-metapro security report [--since <ref>] [--json]\`
- \`gd-metapro security policy validate\`
- \`gd-metapro security incidents [--limit <n>]\`

## Config

- \`security.config.json\` (mode, raw retention, policies, backends, gate,
  \`configChecksum\`).

## Data

- \`data/security/artifacts/\` - committable \`latest.md\` / \`latest.json\`
  (masked previews, categories, severities, actions - never raw secrets).
- \`data/security/incidents/\` - incident trail.
- \`data/security/redactions/\` - redacted samples.
- \`data/security/policies/\` - policy snapshots.
- \`data/security/raw/\` - local-only: HMAC key, self-protect state, local hash
  report. Never committed (gitignored).

## Capabilities

- \`security.secrets\`
- \`security.pii\`
- \`security.prompt-injection\`
- \`security.egress-control\`

## Generated Artifacts

- \`data/security/artifacts/latest.md\` and \`latest.json\` on \`scan\` / \`report\`.
- Committable artifacts contain no hashes of secrets or PII; keyed HMAC hashes,
  when kept, live only in local-only reports under \`data/security/raw/\`.

## Lifecycle

- \`init\` scaffolds config, data folders, and this manifest (optional module,
  opt out with \`--no-security\`).
- \`update\` refreshes service files (this manifest, core README, config if
  missing) without touching \`data/security\`.
- Raw retention defaults to \`off\`; the module operates without persisting raw
  content. A \`configChecksum\` mismatch or a mode downgrade is always surfaced
  as a finding plus an incident entry (self-protection, specification.md §14).
`;
}

export function renderSecurityCoreReadme(): string {
  return `# security Core

Local Metaproject Security service layer.

Responsibilities:

- run rules + entropy + PII + injection/egress detectors over content;
- resolve the most restrictive action per span and compute the gate
  (\`block > require-approval > redact > warn > allow\`);
- redact with fixed-width, length-hiding masks and safe previews;
- keep HMAC-keyed hashes local-only (\`data/security/raw/\`), never plain digests
  and never in committable artifacts;
- verify \`configChecksum\` and record incidents on tamper or mode downgrade.

The service is an in-process library seam (\`createSecurityService().check(...)\`)
called before side-effecting writes; the CLI is a thin wrapper over it. In
\`advisory\` mode \`check\` never throws; in \`enforced\`/\`ci\` mode a
\`fail\`/\`needs-approval\` decision must stop the write.
`;
}
