# Metaproject Security: PRD

Version: 0.1.0

## 1. Problem

AI agents increasingly read external content, project memory, wiki pages, raw
logs and generated reports. Those surfaces can contain secrets, PII or hidden
instructions that attempt prompt injection or data exfiltration.

Existing project security checks focus on code and dependencies. They do not
provide a project-local policy layer for agent inputs, outputs and
`.metaproject/` artifacts.

## 2. Goal

Provide a local security module that lets agents, orchestrators and CI check,
redact, block and audit sensitive content before it is sent to a model, written
to long-term knowledge, published as a report or sent to an external channel.

## 3. Users

- Developers who need safer AI-agent usage in code repositories.
- Agents that need clear rules for external content and sensitive artifacts.
- Orchestrators that can enforce security gates in managed flows.
- CI systems that need publish-safe report artifacts.
- Security/compliance reviewers who need incident and redaction trails.

## 4. Requirements

### R1. Policy-Based Checks

The module must evaluate content against project-local policies:

- secrets;
- PII;
- prompt injection;
- data exfiltration;
- unsafe artifact persistence;
- unsafe external egress.

### R2. Advisory And Enforced Modes

The module must distinguish:

- advisory mode: agent-facing instructions and manual CLI checks;
- enforced mode: workflows controlled by `gd-metapro` orchestrators;
- CI mode: validation before publishing artifacts;
- future gateway mode: model/runtime proxy enforcement.

The module must not claim enforcement where `gd-metapro` does not control the
runtime.

### R3. Safe Defaults

The module must not store raw prompts, raw responses or raw external documents
by default. Reports should store policy ids, severities, source metadata, hashes,
redacted previews and actions.

### R4. CLI Surface

Planned namespace:

```bash
gd-metapro security status
gd-metapro security scan <path>
gd-metapro security check-input --source <user|external|file|web|tool>
gd-metapro security check-output --target <memory|wiki|report|external|task>
gd-metapro security redact <path>
gd-metapro security report
gd-metapro security policy validate
gd-metapro security incidents
```

### R5. Reports

The module must produce:

```text
.metaproject/data/security/artifacts/latest.md
.metaproject/data/security/artifacts/latest.json
```

Reports must be concise enough for agents and detailed enough for audits.

### R6. Integration

The module should integrate with:

- `gdctx` before summarizing large raw logs;
- `memory ingest` before long-term memory writes;
- `wiki collect` before writing drafts;
- `testing` before publishing logs/reports;
- `health` as an optional imported source of security findings;
- `gdskills` verifier/learner for recurring policy failures;
- `flow` gates before completing sensitive tasks.

## 5. Success Criteria

- Agents can discover and follow security rules from `.metaproject/index.md` and
  `skills/security/SKILL.md`.
- Orchestrated flows can require security checks before writes/publish steps.
- Reports never contain raw secrets by default.
- A failed policy produces actionable findings with file/source, policy id,
  severity and remediation.
- Security findings can be consumed by health, memory and gdskills without
  tight coupling.

## 6. Risks

- Overpromising prompt enforcement for hosted agents that bypass the CLI.
- False positives blocking useful agent workflows.
- False negatives giving a false sense of security.
- The security module itself becoming a sensitive raw-log store.
- Backend/model dependencies making the module heavy or hard to install.

## 7. Recommendation

Start with a local rules/regex/entropy MVP and optional pluggable model/API
backends later. Keep raw retention off by default. Treat prompt security as
policy-guided risk reduction, not a perfect guarantee.

