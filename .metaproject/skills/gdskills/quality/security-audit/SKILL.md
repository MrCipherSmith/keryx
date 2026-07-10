---
name: security-audit
description: "Use when checking for dependency vulnerabilities, accidentally committed secrets, or security issues in Docker images."
triggers:
  - "Security audit"
  - "Check vulnerabilities"
  - "Audit dependencies"
  - "Security scan"
  - "Check for CVEs"
  - "npm audit"
  - "Dependency vulnerabilities"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "quality"
license: "MIT"
compatibility: "cursor,codex,zed,opencode,claude"
---

<!-- keryx:execution-metrics:begin -->
## Execution Metrics (user-direct opt-in)

When this skill is invoked directly by a user, before task work:

1. Read `.metaproject/rules/core/execution-metrics.md`.
2. Ask exactly: **Collect execution statistics for this run? (yes / no)**
3. Wait for the answer. If yes, follow the rule's reporting and persistence contract; if no, continue normally.

When dispatched as a subagent, do not ask and do not emit a separate report. The top-level caller owns metrics.
<!-- keryx:execution-metrics:end -->

# Security Audit

## Purpose

Comprehensive security audit covering dependency vulnerabilities, secrets in code/git history, and container image scanning. Produces a prioritized remediation report.

**Input:** None (scans current project)
**Output:** Severity-grouped vulnerability report with remediation steps

## When to Use

- Before a release
- After adding new dependencies
- Periodic security review

## Steps

### Step 1 — Dependency vulnerabilities
Auto-detect: `bun.lockb` → `bun audit` | `package-lock.json` → `npm audit --json` | `yarn.lock` → `yarn audit`

Group by severity: **critical → high → moderate → low**

### Step 2 — Outdated packages
Run `bun outdated` or `npm outdated`. Flag packages more than 2 major versions behind.

### Step 3 — Secrets scan
- Check git history for `.env`, `.key`, `.pem` files
- Grep source for hardcoded passwords/API keys/secrets (excluding node_modules)

### Step 4 — Docker image scan
If Dockerfile present and Docker available: `docker scout cves`

### Report
- Total by severity
- Top 3 critical/high with CVE
- Recommended immediate actions
- Packages safe to ignore (dev-only, not reachable in prod)

## Rules

- Distinguish prod vs dev-only vulnerabilities
- Never suggest `npm audit fix --force` without explaining what it changes
