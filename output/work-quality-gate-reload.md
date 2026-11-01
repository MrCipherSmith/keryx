# Reload recovery quality gate — approved fix

**Latest gate: PASS.** This supersedes the earlier review-pending snapshot. The owner reports that the original pending operation is now preserved after an uncertain outcome followed by 4xx, the ID validator is aligned, and independent review returned APPROVE. This verifier completed the affected automated checks below; it did not perform product acceptance or deployment.

Worktree: `/Users/Goodea/.codex/worktrees/hub-work-management/keryx`  
Branch: `feat-hub-work-management`  
HEAD: `dec5ecce4fc778f34ba8ce15f30d47bdc484ceaf`  
Source window: 2026-11-01T13:00:19Z through 2026-11-01T13:01:20Z.

```yaml
VERIFICATION_RESULT:
  gate: PASS
  snapshot: POST_FIX
  scope: approved reload recovery fix, generated UI assets, packaging and final documentation snapshot
  candidate:
    head_before: dec5ecce4fc778f34ba8ce15f30d47bdc484ceaf
    head_after: dec5ecce4fc778f34ba8ce15f30d47bdc484ceaf
    measured_files: 453
    scope_digest_before: 2a52dfeb504c0533c3b824358e2ba9895831a433eccb3992b183b618e734f4cf
    scope_digest_after: 2a52dfeb504c0533c3b824358e2ba9895831a433eccb3992b183b618e734f4cf
    runtime_digest_before: 615b170c47c2539a0c8a9099598cb228dcb7a7d84208bd777cbc6701518cd9d5
    runtime_digest_after: 615b170c47c2539a0c8a9099598cb228dcb7a7d84208bd777cbc6701518cd9d5
    changed_files_during_checks: []
    backend_changes_since_1783_pass: []
  checks:
    root_type_check: { status: pass, errors: 0 }
    scripts_type_check: { status: pass, errors: 0 }
    frontend_type_check: { status: pass, errors: 0 }
    frontend_lint: { status: pass, errors: 0, warnings: 0 }
    frontend_tests:
      status: pass
      passed: 151
      failed: 0
      files: 31
      duration_seconds: 8.53
    frontend_build:
      status: pass
      modules_transformed: 2239
    embedded_assets:
      status: pass
      regenerated_assets: 22
      input_digest: 7e9ed0a2f870a5b77be4295a223ec48da69b6cf49ebfe9218a968c5e368c565f
    packaging_tests:
      status: pass
      passed: 6
      failed: 0
      files: 1
      expectations: 40
      duration_seconds: 10.66
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
      note: exact source hashes unchanged, excluding regenerated frontend asset bundle
  failed_checks: []
  findings: []
```

## Commands and evidence

Assets were regenerated first: `bun --no-env-file src/cli.ts ctx run -- bun run build:hub-web`. Evidence: `.metaproject/data/gdctx/raw/2026-11-01T13-00-09-544Z-4cc2dc_ru`. This authorized generation changed `src/hub/web-assets.generated.ts`; no manually authored production source was edited by this verifier.

All checks used the source CLI context wrapper. Counts are separate scopes, not an accumulated total of repeated runs.

| Check | Exact command | Raw evidence |
|---|---|---|
| postfix-types | `bun --no-env-file src/cli.ts ctx run -- bun run typecheck` | `.metaproject/data/gdctx/raw/2026-11-01T13-00-51-669Z-e920a1_ru` |
| postfix-script-types | `bun --no-env-file src/cli.ts ctx run -- bun run typecheck:scripts` | `.metaproject/data/gdctx/raw/2026-11-01T13-00-32-205Z-4ee3a2_ru` |
| postfix-frontend-tests | `bun --no-env-file src/cli.ts ctx run -- bun run --cwd apps/hub-web test` | `.metaproject/data/gdctx/raw/2026-11-01T13-00-29-972Z-719147_ru` |
| postfix-frontend-types | `bun --no-env-file src/cli.ts ctx run -- bun run --cwd apps/hub-web typecheck` | `.metaproject/data/gdctx/raw/2026-11-01T13-00-34-512Z-070bfa_ru` |
| postfix-frontend-lint | `bun --no-env-file src/cli.ts ctx run -- bun run --cwd apps/hub-web lint` | `.metaproject/data/gdctx/raw/2026-11-01T13-00-25-978Z-c50599_ru` |
| postfix-frontend-build | `bun --no-env-file src/cli.ts ctx run -- bun run --cwd apps/hub-web build` | `.metaproject/data/gdctx/raw/2026-11-01T13-00-22-492Z-803d58_ru` |
| postfix-assets | `bun --no-env-file src/cli.ts ctx run -- bun scripts/build-hub-web.ts --check` | `.metaproject/data/gdctx/raw/2026-11-01T13-00-21-001Z-91a3ed_ru` |
| postfix-packaging | `bun --no-env-file src/cli.ts ctx run -- bun test scripts/package-team-hub.test.ts` | `.metaproject/data/gdctx/raw/2026-11-01T13-00-31-535Z-b9cbe4_ru` |
| postfix-docs | `bun --no-env-file src/cli.ts ctx run -- node docs/requirements/hub-work-management/verify.cjs` | `.metaproject/data/gdctx/raw/2026-11-01T13-00-21-455Z-00c317_ru` |

The packaging suite passed against the regenerated post-fix assets. It exercised deterministic bounded archives, runtime import closure, Docker COPY/schema-context layout through a disposable build, symlink rejection, the standalone context-client boundary, and a real extracted allowlisted source archive. The extracted runtime used frozen production-only scripts-disabled offline dependencies copied into a disposable cache/home, then served managed-work metadata and authenticated MCP from an isolated process. This was not a real Docker daemon/container or Linux execution.

## Candidate pin and retained backend evidence

Manifests: `output/work-quality-postfix-start.json` and `output/work-quality-postfix-end.json`. The full 453-file scope includes Hub/work, remote/CLI, full frontend, package/build scripts, deployment files, requirements, final handoffs/runbook and root configuration. The digest is SHA-256 over the sorted path-to-content-SHA256 mapping. All measured contents and HEAD were identical before and after the checks.

The runtime digest excludes only Markdown under `docs/`; JSON schemas, generated OpenAPI, contract verification code and other runtime inputs remain included. Final requirement and handoff wording was already present in this measured snapshot. Backend source hashes exactly match the 1783-pass integrated candidate, excluding the regenerated frontend asset bundle, so the broad backend suite was not repeated without a backend change.

Earlier source-health optional-coverage and testing-discovery-timeout limitations remain in historical gate reports. This run used actual configured UI tests and explicit type/lint/build/package commands. Full root tests outside the retained backend and affected UI scope were not run. No circular-import dependency was installed.

## Historical note and limits

The full earlier blocked record is preserved at `output/work-quality-gate-reload-prefixed-history.md`. Its 148-test pre-fix results and WITHHELD verdict remain historical; they are not silently relabeled as evidence for this fix. The latest 151-test result above replaces the affected UI count.

No dependency upgrade, global installation, live vendor call, source feature edit, deployment or product acceptance was performed. Temporary offline installation was confined to the explicitly requested packaging fixture. Builds generated ignored output and the authorized embedded asset artifact. Browser journeys and independent reviewer judgments remain separate evidence.

Any subsequent code, schema, asset or measured document change requires affected-scope verification and an updated digest before reusing this candidate proof. Owner packaging/archive publication and preview activities are subsequent work.

Routing audit: source ctx run used; graph not relevant to execution-only verification; prior wiki routing retained; raw_rg_used: no.

