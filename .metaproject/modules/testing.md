# Testing Module

## Purpose

Builds project testing context, runs tests through the existing project runner,
and writes normalized test reports for agents, Code Health and gdskills.

## Commands

- `keryx test init`
- `keryx test analyze`
- `keryx test run [--changed]`
- `keryx test status`
- `keryx test context`
- `keryx test explain <file-or-scope>`
- `keryx test related <file>`
- `keryx test report latest [--json]`
- `keryx test suggest <file> [--provider <p>] [--model <m>] [--json]` — model-backed: propose a prioritized test plan from project frameworks + related tests. Fail-closed without a credential.

## Data

- `data/testing/context.md`
- `data/testing/context.json`
- `data/testing/recommendations.md`
- `data/testing/artifacts/latest.md`
- `data/testing/artifacts/latest.json`

## Skills

- `skills/testing/SKILL.md`
