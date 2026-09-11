---
name: security-audit
description: "Use when checking for dependency vulnerabilities, accidentally committed secrets, or security issues in Docker images."
triggers:
  - "security audit"
  - "audit dependencies"
  - "scan secrets"
  - "Security scan"
  - "Check for CVEs"
  - "npm audit"
  - "bun audit"
  - "Dependency vulnerabilities"
metadata:
  author: "MrCipherSmith"
  version: "1.1.0"
  category: "quality"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

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

Detect from the **lockfile**, not from an installed binary. The lockfile is what
an audit reads; `bun` being on PATH says nothing about whether `bun audit` has a
lockfile to resolve.

| Lockfile present (repo root) | Command |
|---|---|
| `bun.lock` **or** `bun.lockb` | `bun audit --json` |
| `package-lock.json` **or** `npm-shrinkwrap.json` | `npm audit --json` |
| `pnpm-lock.yaml` | `pnpm audit --json` |
| `yarn.lock` | `yarn npm audit --json` (Yarn 2+), else `yarn audit --json` (Yarn 1) |

Check **both** Bun names — `bun.lock` and `bun.lockb`. Bun 1.2 replaced the
binary `bun.lockb` with the text `bun.lock`, so a project on current Bun has
only `bun.lock`, and a `bun.lockb`-only check (`bun.lock` unmatched) finds
nothing there.

**If no row matches, the dependency audit DID NOT RUN.** Say so:

```
dependency-audit: NOT RUN — no recognised lockfile in <path>
```

and carry `not measured` — never `0` — into every severity total in the report.
Do not fall through to another package manager's audit as a guess.

**A command that could not produce results is also NOT RUN.** `npm audit --json`
without a lockfile exits 1 and prints roughly 240 bytes of
`{"error":{"code":"ENOLOCK",...}}` — an object with **no `vulnerabilities` key
at all**. Grouping that by severity yields zero for critical, high, moderate and
low, which is indistinguishable from a clean project. So before grouping, check
that the payload actually carries vulnerability data (`vulnerabilities` /
`advisories` for npm, the per-package arrays for bun). If it does not, the
outcome is NOT RUN with the tool's own error, not a clean result.

Only once a command has produced real vulnerability data:

Group by severity: **critical → high → moderate → low**

### Step 2 — Outdated packages
Run `outdated` for the package manager Step 1 detected (`bun outdated`,
`npm outdated`, `pnpm outdated`, `yarn outdated`). Flag packages more than 2
major versions behind. If Step 1 found no package manager, this step is
`NOT RUN` for the same reason.

### Step 3 — Secrets scan
- Check git history for `.env`, `.key`, `.pem` files
- Grep source for hardcoded passwords/API keys/secrets (excluding node_modules)

### Step 4 — Docker image scan
If a Dockerfile is present and Docker is available: `docker scout cves`.
Otherwise report `container-scan: NOT RUN — <no Dockerfile | docker unavailable>`.
"No Dockerfile" and "scanned, nothing found" are different results.

### Report
- Per step: `RAN` or `NOT RUN — <reason>`. A step that did not run has no totals.
- Total by severity, for the steps that ran
- Top 3 critical/high with CVE
- Recommended immediate actions
- Packages safe to ignore (dev-only, not reachable in prod)

## Rules

- Distinguish prod vs dev-only vulnerabilities
- Never suggest `npm audit fix --force` without explaining what it changes
- **A check that did not run is not a check that passed.** Never report a
  severity total — least of all zero — for a step whose command was not
  selected, could not run, or returned no vulnerability data. Report `not
  measured` and name the reason. In a security report, silence read as "clean"
  is the most expensive defect available.
