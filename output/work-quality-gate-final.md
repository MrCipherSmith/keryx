# Final integrated candidate quality gate

Worktree: `/Users/Goodea/.codex/worktrees/hub-work-management/keryx`
Branch: `feat-hub-work-management`
HEAD: `c2109a7aad5be794680eed89e45d1d1040564ad3`
Verification window: 2026-11-01T11:21:35Z through 2026-11-01T11:23:02Z.

**Gate: PASS for the exact measured candidate.** This report supersedes prior failed or preliminary quality-gate snapshots. It does not constitute product acceptance, deployment approval, a security audit, or live-provider certification.

```yaml
VERIFICATION_RESULT:
  gate: PASS
  scope: integrated backend, frontend increment two, packaging, embedded assets and requirement schema checks
  candidate:
    head_before: c2109a7aad5be794680eed89e45d1d1040564ad3
    head_after: c2109a7aad5be794680eed89e45d1d1040564ad3
    measured_files: 415
    scope_digest_before: 3cbcae8b85663c8d30e68e294e5048b4434839cfc99a1c5ce796b7da00657186
    scope_digest_after: 3cbcae8b85663c8d30e68e294e5048b4434839cfc99a1c5ce796b7da00657186
    changed_files_during_checks: []
  checks:
    source_health:
      status: pass
      findings: 0
      coverage: partial_optional_sources
      generated_at: 2026-11-01T11:22:32.137Z
    backend_lint:
      status: pass
      errors: 0
      warnings: 0
    root_type_check:
      status: pass
      errors: 0
    scripts_type_check:
      status: pass
      errors: 0
    backend_tests:
      status: pass
      passed: 1783
      failed: 0
      files: 158
      expectations: 21189
      duration_seconds: 50.59
    packaging_tests:
      status: pass
      passed: 6
      failed: 0
      files: 1
      expectations: 40
      duration_seconds: 15.30
    frontend_tests:
      status: pass
      passed: 136
      failed: 0
      files: 29
      duration_seconds: 11.95
    frontend_type_check:
      status: pass
      errors: 0
    frontend_lint:
      status: pass
      errors: 0
      warnings: 0
    frontend_build:
      status: pass
      modules_transformed: 2236
    embedded_assets:
      status: pass
      input_digest: e87c72f08fea7547973f53635c3d6ad64af9aa005f4688d1a5a2ccfd802575c2
    requirement_schema_docs:
      status: pass
      markdown_files: 13
      prd_requirements: 14
      acceptance_criteria: 16
      schemas: 3
      valid_examples: 11
      invalid_examples: 16
    circular_imports:
      status: skipped
      reason: madge is not a configured dependency; nothing installed
    testing_module_discovery:
      status: not_rerun
      reason: prior timeout retained as historical limitation; actual complete relevant directories executed explicitly
  findings: []
```

## Exact commands and evidence

All execution used the source CLI context wrapper, not the installed `keryx` binary. Counts above are independent scopes, not an aggregate total.

| Check | Exact command | Raw evidence |
|---|---|---|
| final-health | `bun --no-env-file src/cli.ts ctx run -- bun --no-env-file src/cli.ts health run --changed --source eslint,typescript` | `.metaproject/data/gdctx/raw/2026-11-01T11-22-32-169Z-0655b4_ru` |
| final-types | `bun --no-env-file src/cli.ts ctx run -- bun run typecheck` | `.metaproject/data/gdctx/raw/2026-11-01T11-22-17-615Z-df912d_ru` |
| final-script-types | `bun --no-env-file src/cli.ts ctx run -- bun run typecheck:scripts` | `.metaproject/data/gdctx/raw/2026-11-01T11-21-53-986Z-20c389_ru` |
| final-backend-lint | `bun --no-env-file src/cli.ts ctx run -- bun node_modules/eslint/bin/eslint.js src/hub src/remote-control src/remote src/commands/hub.ts src/commands/hub-machine.ts src/commands/hub-machine.test.ts scripts/package-team-hub.ts scripts/package-team-hub.test.ts scripts/build-hub-web.ts scripts/build-hub-web.test.ts` | `.metaproject/data/gdctx/raw/2026-11-01T11-21-51-311Z-f4825c_ru` |
| final-backend-tests | `bun --no-env-file src/cli.ts ctx run -- bun test src/hub/ src/remote-control/ src/remote/ src/commands/hub-machine.test.ts src/cli-reference-coverage.test.ts src/standard/commands-by-task.test.ts src/standard/help-groups.test.ts` | `.metaproject/data/gdctx/raw/2026-11-01T11-22-27-644Z-1fbb9b_ru` |
| final-packaging-tests | `bun --no-env-file src/cli.ts ctx run -- bun test scripts/package-team-hub.test.ts` | `.metaproject/data/gdctx/raw/2026-11-01T11-21-52-146Z-2ee4bf_ru` |
| final-frontend-tests | `bun --no-env-file src/cli.ts ctx run -- bun run --cwd apps/hub-web test` | `.metaproject/data/gdctx/raw/2026-11-01T11-21-49-588Z-190b2e_ru` |
| final-frontend-types | `bun --no-env-file src/cli.ts ctx run -- bun run --cwd apps/hub-web typecheck` | `.metaproject/data/gdctx/raw/2026-11-01T11-21-57-171Z-7eac1b_ru` |
| final-frontend-lint | `bun --no-env-file src/cli.ts ctx run -- bun run --cwd apps/hub-web lint` | `.metaproject/data/gdctx/raw/2026-11-01T11-21-42-950Z-2fd8c3_ru` |
| final-frontend-build | `bun --no-env-file src/cli.ts ctx run -- bun run --cwd apps/hub-web build` | `.metaproject/data/gdctx/raw/2026-11-01T11-21-39-176Z-f48dfd_ru` |
| final-embedded-assets | `bun --no-env-file src/cli.ts ctx run -- bun scripts/build-hub-web.ts --check` | `.metaproject/data/gdctx/raw/2026-11-01T11-21-36-986Z-36f3f4_ru` |
| final-schema-docs | `bun --no-env-file src/cli.ts ctx run -- node docs/requirements/hub-work-management/verify.cjs` | `.metaproject/data/gdctx/raw/2026-11-01T11-21-37-678Z-ee00d2_ru` |

The normalized source-health report was read after completion. Its required ESLint and TypeScript sources completed and parsed with zero findings. Optional oxlint, tests, dependency audit and SonarQube were not executed by health; explicit lint, types and actual test suites above supplement its partial discovery coverage.

## Candidate scope

The before/after manifests are `output/work-quality-final-start.json` and `output/work-quality-final-end.json`. They include tracked and untracked files in the complete Hub/work backend, remote protocol/control sources, Hub launchers, full frontend, package/build scripts, requirements package and selected root configuration files. The digest is SHA-256 over the sorted path-to-content-SHA256 mapping. All 415 measured files and HEAD remained identical throughout these checks.

Backend execution included all `src/hub/` tests, including previously untracked work domain/HTTP/storage/observation/runtime tests, legacy Hub and machine-v2 regressions, MCP/bridge/status/context connector tests, all `src/remote-control/` and `src/remote/`, Hub machine CLI and CLI-reference/help coverage. Frontend scripts covered the entire application and second UI increment. Generated embedded assets were checked after the owner's regeneration.

Packaging tests independently exercised deterministic bounded archives, runtime relative-import closure, Docker COPY/context/schema layout through a disposable build, symlink rejection, the standalone context client boundary, and an actual extracted source archive. The extracted archive used frozen, production-only, scripts-disabled, **offline** dependencies copied from the existing cache into a disposable cache and home, then served managed-work metadata and authenticated MCP from an isolated process. This was not a Docker daemon/container execution or a Linux runtime proof.

## Limits

No source edits, dependency upgrades, global installs, deployment, live GitHub/vendor calls, user credential inspection, or acceptance Decisions were performed by this verifier. Vite generated ignored build output; requested tests and health/context tooling generated temporary fixtures and reports. The isolated offline dependency installation was part of the explicitly requested packaging test only.

Root-wide tests outside the requested backend/remote/CLI scope were not run. Circular-import analysis was not installed. The earlier source testing-discovery timeout was not retried; its missing normalized result is not represented as a pass. Direct test scopes completed successfully. Documentation checks validate package structure, closed schemas and examples; they do not replace independent semantic review.

This report covers only the measured candidate. Any subsequent native-control, UI-review, runtime, schema or embedded-asset change requires affected-scope revalidation and a new candidate digest. Browser visual/accessibility journeys, independent reviewer judgments and owner acceptance remain separate evidence.

Routing audit: graph_used: not-relevant (execution-only checks); wiki_used: existing index context, no architecture inference; ctx_used: source run/read wrappers and normalized health report; raw_rg_used: no.

## Native execution UI delta gate — latest candidate

**Gate: PASS.** This appendix supersedes the preceding frontend and asset counts for the third UI increment. Backend runtime files were compared with the earlier 1783-test candidate and are byte-identical, excluding the regenerated frontend asset bundle; that backend result is retained rather than counted again.

```yaml
VERIFICATION_RESULT:
  gate: PASS
  scope: third native execution UI delta plus root types, embedded assets and isolated packaging
  candidate:
    head_before: d01d5328ada7a0bd32d4167ded15f59b60f691b7
    head_after: d01d5328ada7a0bd32d4167ded15f59b60f691b7
    measured_files: 447
    scope_digest_before: f314ee647fa45e4ceb58e076a2f36252145335eafd62d3500e4625e812c8c3bf
    scope_digest_after: f314ee647fa45e4ceb58e076a2f36252145335eafd62d3500e4625e812c8c3bf
    changed_files_during_checks: []
  checks:
    root_type_check: { status: pass, errors: 0 }
    scripts_type_check: { status: pass, errors: 0 }
    frontend_type_check: { status: pass, errors: 0 }
    frontend_lint: { status: pass, errors: 0, warnings: 0 }
    frontend_tests:
      status: pass
      passed: 142
      failed: 0
      files: 30
      duration_seconds: 8.51
      note: complete configured suite includes new native execution and API transport cases
    frontend_build:
      status: pass
      modules_transformed: 2237
    embedded_assets:
      status: pass
      input_digest: a75ed7ace75f55c4965513fd69da0ed9fd90f1bdb0acfa4459d30207ec98f491
    packaging_tests:
      status: pass
      passed: 6
      failed: 0
      files: 1
      expectations: 40
      duration_seconds: 10.62
    backend_tests:
      status: retained_pass
      passed: 1783
      failed: 0
      note: unchanged source hashes; full suite not unnecessarily repeated
  findings: []
```

The delta commands started at 2026-11-01T11:53:05Z. All commands completed successfully; the latest root type-check log was written at 11:53:35Z. The end manifest was captured at 2026-11-01T12:35:41Z; both HEAD and all 447 measured contents remained identical. Manifests: `output/work-quality-native-ui-start.json`, `output/work-quality-native-ui-end.json`. The expanded scope includes deployment Docker/runtime configuration as well as the prior source, UI, package scripts and requirements paths.

| Check | Exact command | Raw evidence |
|---|---|---|
| native-types | `bun --no-env-file src/cli.ts ctx run -- bun run typecheck` | `.metaproject/data/gdctx/raw/2026-11-01T11-53-35-489Z-edc4a4_ru` |
| native-script-types | `bun --no-env-file src/cli.ts ctx run -- bun run typecheck:scripts` | `.metaproject/data/gdctx/raw/2026-11-01T11-53-17-070Z-80325c_ru` |
| native-frontend-tests | `bun --no-env-file src/cli.ts ctx run -- bun run --cwd apps/hub-web test` | `.metaproject/data/gdctx/raw/2026-11-01T11-53-14-939Z-b71a04_ru` |
| native-frontend-types | `bun --no-env-file src/cli.ts ctx run -- bun run --cwd apps/hub-web typecheck` | `.metaproject/data/gdctx/raw/2026-11-01T11-53-19-200Z-4df23e_ru` |
| native-frontend-lint | `bun --no-env-file src/cli.ts ctx run -- bun run --cwd apps/hub-web lint` | `.metaproject/data/gdctx/raw/2026-11-01T11-53-10-611Z-6a2bb8_ru` |
| native-frontend-build | `bun --no-env-file src/cli.ts ctx run -- bun run --cwd apps/hub-web build` | `.metaproject/data/gdctx/raw/2026-11-01T11-53-07-677Z-315548_ru` |
| native-assets | `bun --no-env-file src/cli.ts ctx run -- bun scripts/build-hub-web.ts --check` | `.metaproject/data/gdctx/raw/2026-11-01T11-53-06-060Z-0592a7_ru` |
| native-packaging | `bun --no-env-file src/cli.ts ctx run -- bun test scripts/package-team-hub.test.ts` | `.metaproject/data/gdctx/raw/2026-11-01T11-53-16-404Z-9655ef_ru` |

The six packaging cases again passed against the third UI's regenerated assets, including a real extracted allowlisted archive, frozen offline installation into disposable cache/home, isolated managed-work and authenticated MCP smoke, runtime import closure, Docker COPY/schema-context layout and symlink rejection. No real Docker container or vendor service was invoked by these checks.

No source edits, global installation, deployment or product acceptance occurred. Builds generated ignored output and tests used disposable fixtures only. Counts are per scope and supersede their corresponding previous runs; repeated runs are not added together. Independent UI review and browser validation remain separate evidence. Any later code or asset change invalidates this exact candidate proof and requires affected-scope revalidation.
