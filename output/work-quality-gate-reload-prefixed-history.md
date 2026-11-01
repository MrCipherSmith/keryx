# Reload recovery candidate — pre-fix quality snapshot

**PRE-FIX / REVIEW PENDING. Candidate clearance is withheld.** All requested automated checks passed, but the owner reported a potential major review issue after this run: `retryOriginal` may erase the original pending envelope on a 4xx even though an earlier unknown operation could already have committed. Current authorization can return 403 before receipt lookup. Reproduction and remediation were still in progress when this report was written. This verifier did not reproduce or resolve that finding and makes no final candidate PASS claim.

Worktree: `/Users/Goodea/.codex/worktrees/hub-work-management/keryx`
Branch: `feat-hub-work-management`
HEAD: `dec5ecce4fc778f34ba8ce15f30d47bdc484ceaf`
Measured window: 2026-11-01T12:55:50Z through 2026-11-01T12:56:40Z.

```yaml
VERIFICATION_RESULT:
  gate: FAIL
  automated_checks: PASS
  candidate_clearance: WITHHELD_REVIEW_PENDING
  snapshot: PRE_FIX
  scope: reload recovery UI, root and scripts types, generated assets and packaging
  candidate:
    head_before: dec5ecce4fc778f34ba8ce15f30d47bdc484ceaf
    head_after: dec5ecce4fc778f34ba8ce15f30d47bdc484ceaf
    measured_files: 450
    scope_digest_before: 7672a89a0678c58a816403e1091f4b84fe8c9db73c6d90205b53352e49de99ce
    scope_digest_after: 7672a89a0678c58a816403e1091f4b84fe8c9db73c6d90205b53352e49de99ce
    runtime_digest_before: facf1b3bad6ecf7ea7e0dd2ab88b1f21a6fea12c143123e6e862fd8e5b6329c8
    runtime_digest_after: facf1b3bad6ecf7ea7e0dd2ab88b1f21a6fea12c143123e6e862fd8e5b6329c8
    changed_files_during_checks: []
    backend_changes_since_1783_pass: []
  checks:
    root_type_check: { status: pass, errors: 0 }
    scripts_type_check: { status: pass, errors: 0 }
    frontend_type_check: { status: pass, errors: 0 }
    frontend_lint: { status: pass, errors: 0, warnings: 0 }
    frontend_tests:
      status: pass
      passed: 148
      failed: 0
      files: 31
      duration_seconds: 13.29
    frontend_build:
      status: pass
      modules_transformed: 2239
    embedded_assets:
      status: pass
      regenerated_assets: 22
      input_digest: c1a0c0691e8d4bff111b927cf7a5701fa257e6427f1a3aaaf82e8e65269f3cf2
    packaging_tests:
      status: pass
      passed: 6
      failed: 0
      files: 1
      expectations: 40
      duration_seconds: 14.99
    requirement_schema_docs:
      status: pass
      markdown_files: 13
      prd_requirements: 14
      acceptance_criteria: 16
      schemas: 3
      valid_examples: 11
      invalid_examples: 16
    backend_tests:
      status: retained_pass
      passed: 1783
      failed: 0
      note: source byte comparison unchanged, generated UI asset excluded
  failed_automated_checks: []
  review_blockers:
    - severity: potential_major
      status: reproduction_in_progress
      source: owner_report
      description: Original unknown operation envelope may be discarded by retryOriginal after a 4xx response.
```

## Commands and evidence

All commands used the source CLI context wrapper. Counts are per scope; repeated historical runs are not added together.

Embedded assets were regenerated first using `bun --no-env-file src/cli.ts ctx run -- bun run build:hub-web`. Evidence: `.metaproject/data/gdctx/raw/2026-11-01T12-55-36-770Z-aa3842_run.log`. This authorized generation changed `src/hub/web-assets.generated.ts`; no manually authored production source was edited by the verifier.

| Check | Exact command | Raw evidence |
|---|---|---|
| reload-types | `bun --no-env-file src/cli.ts ctx run -- bun run typecheck` | `.metaproject/data/gdctx/raw/2026-11-01T12-56-27-457Z-5c0406_ru` |
| reload-script-types | `bun --no-env-file src/cli.ts ctx run -- bun run typecheck:scripts` | `.metaproject/data/gdctx/raw/2026-11-01T12-56-07-998Z-c63947_ru` |
| reload-frontend-tests | `bun --no-env-file src/cli.ts ctx run -- bun run --cwd apps/hub-web test` | `.metaproject/data/gdctx/raw/2026-11-01T12-56-05-376Z-c1b68d_ru` |
| reload-frontend-types | `bun --no-env-file src/cli.ts ctx run -- bun run --cwd apps/hub-web typecheck` | `.metaproject/data/gdctx/raw/2026-11-01T12-56-10-452Z-6b260b_ru` |
| reload-frontend-lint | `bun --no-env-file src/cli.ts ctx run -- bun run --cwd apps/hub-web lint` | `.metaproject/data/gdctx/raw/2026-11-01T12-56-00-594Z-a87fa4_ru` |
| reload-frontend-build | `bun --no-env-file src/cli.ts ctx run -- bun run --cwd apps/hub-web build` | `.metaproject/data/gdctx/raw/2026-11-01T12-55-53-004Z-158c91_ru` |
| reload-assets | `bun --no-env-file src/cli.ts ctx run -- bun scripts/build-hub-web.ts --check` | `.metaproject/data/gdctx/raw/2026-11-01T12-55-51-685Z-128c54_ru` |
| reload-packaging | `bun --no-env-file src/cli.ts ctx run -- bun test scripts/package-team-hub.test.ts` | `.metaproject/data/gdctx/raw/2026-11-01T12-56-06-655Z-93dac9_ru` |
| reload-docs | `bun --no-env-file src/cli.ts ctx run -- node docs/requirements/hub-work-management/verify.cjs` | `.metaproject/data/gdctx/raw/2026-11-01T12-55-52-657Z-2fdfd4_ru` |

The packaging suite used a real extracted allowlisted source archive, frozen production-only scripts-disabled offline dependencies in a disposable cache/home, and an isolated managed-work/authenticated MCP process. Docker context/schema-copy layout was checked through a disposable build, not through a real Docker daemon. No global installation, dependency update, live provider call, deployment or product acceptance was performed.

## Scope, retained evidence and next gate

Manifests: `output/work-quality-reload-start.json` and `output/work-quality-reload-end.json`. The full 450-file scope includes backend, remote/CLI, entire frontend, package/build scripts, deployment files, requirements and selected root configuration. The runtime digest excludes only Markdown inside this requirements package; runtime JSON schemas, generated OpenAPI, verification code and other contract inputs remain included. This separates subsequent owner evidence-writing from runtime changes without excluding runtime schemas from the pin.

All measured source contents and HEAD remained unchanged during this run. Backend source hashes matched the original 1783-pass integrated candidate, excluding the expected regenerated UI asset bundle, so full backend tests were not unnecessarily repeated. Earlier source-health partial-coverage and test-discovery-timeout limits remain documented in `output/work-quality-gate-final.md`; this affected-scope run used actual configured UI tests and explicit types/lint/package commands.

Requirements verification is a timestamped snapshot. The owner plans final evidence edits afterward; those Markdown changes require final documentation verification and a new documentation digest, and must not be represented as part of this unchanged snapshot.

After the reported review issue is resolved, rerun the affected regression plus full configured UI tests, UI types/lint/build, embedded asset regeneration/freshness and the six packaging cases. Root types need repeating if the fix changes relevant types. Independent review must clear before final candidate clearance. This pre-fix record is intentionally retained, not overwritten as though the issue had been tested here.

Routing audit: source ctx run used; graph not relevant to execution-only verification; prior wiki routing retained; raw_rg_used: no.
