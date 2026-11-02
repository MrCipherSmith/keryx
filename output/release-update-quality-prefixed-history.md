# Release/update quality gate — pre-fix snapshot

**PRE-FIX / NOT CLEARED FOR RELEASE.** All local automated checks below passed. The owner separately reported a failing real-Docker first-upgrade SSO-override assertion and a review finding that upgrading to an older version lacks compatibility preflight before stopping the current service. Hubctl fixes are underway. These external blockers are not concealed by the passing local unit/package checks; no final approval is issued here.

Worktree: `/Users/Goodea/.codex/worktrees/hub-work-management/keryx`
Branch: `feat-hub-work-management`
Start HEAD: `7995e7cac85fac1b9fa886499a9b16b5a25018ec`
End HEAD: `9480300f790ca56fdce1257e4a270ee0808295a5`
Manifest window: 2026-11-01T15:24:16Z–15:25:49Z; commands started at 15:24:43Z.

```yaml
VERIFICATION_RESULT:
  gate: FAIL
  automated_checks: PASS
  candidate_clearance: WITHHELD
  snapshot: PRE_FIX
  candidate:
    measured_files: 440
    scope_digest_before: ae8d70655523dfdc7f63f1290d9a32bafbf390f2b606436ab43c76f3089891ae
    scope_digest_after: e507ce7371d5dd30ac5eb736a9b4b6dcd6fca5e58c2cc069d1d72c6d1325d974
    changed_files:
      - docs/requirements/hub-release-update/specification.md
    source_code_content_changes_during_checks: 0
  checks:
    source_health:
      status: pass
      findings: 0
      coverage: partial_optional_sources
      generated_at: 2026-11-01T15:25:26.990Z
    root_type_check: { status: pass, errors: 0 }
    scripts_type_check: { status: pass, errors: 0 }
    changed_source_script_lint: { status: pass, errors: 0, warnings: 0 }
    cli_hubctl_reference_status_tests:
      status: pass
      passed: 116
      failed: 0
      files: 7
      expectations: 3176
      duration_seconds: 8.49
    packaging_tests:
      status: pass
      passed: 6
      failed: 0
      files: 1
      expectations: 40
      duration_seconds: 6.46
    embedded_assets:
      status: pass
      input_digest: 7e9ed0a2f870a5b77be4295a223ec48da69b6cf49ebfe9218a968c5e368c565f
    ui:
      status: retained_pass
      passed: 151
      failed: 0
      current_source_matches_prior_151_test_manifest: true
      repeated: false
    documentation_links:
      status: pass
      checked_links: 2039
      files: 689
      broken: 0
    changed_shell_syntax:
      status: pass
      files: [deploy/team-hub/hubctl, deploy/team-hub/release/e2e.sh]
  failed_local_checks: []
  external_blockers:
    - source: owner_report
      check: real_Docker_release_e2e
      status: fail
      description: First-upgrade SSO override assertion failed; diagnosis and fix pending.
    - source: independent_review_reported_by_owner
      severity: major
      status: fix_pending
      description: Older-version upgrade lacks compatibility preflight before stopping current service.
```

## Exact commands and evidence

Execution used the current source CLI context wrapper; the installed CLI was not used to verify code under review. Counts are separate scopes and are not added to historical totals.

| Check | Exact command | Raw evidence |
|---|---|---|
| release-health | `bun --no-env-file src/cli.ts ctx run -- bun --no-env-file src/cli.ts health run --changed --source eslint,typescript` | `.metaproject/data/gdctx/raw/2026-11-01T15-25-27-027Z-da96ee_ru` |
| release-types | `bun --no-env-file src/cli.ts ctx run -- bun run typecheck` | `.metaproject/data/gdctx/raw/2026-11-01T15-25-18-493Z-8b215a_ru` |
| release-script-types | `bun --no-env-file src/cli.ts ctx run -- bun run typecheck:scripts` | `.metaproject/data/gdctx/raw/2026-11-01T15-24-51-264Z-3590ab_ru` |
| release-lint | `bun --no-env-file src/cli.ts ctx run -- bun node_modules/eslint/bin/eslint.js src/cli-registry.ts src/commands/hub.ts src/commands/hub-update.ts src/commands/hub-update.test.ts scripts/hubctl-release.test.ts` | `.metaproject/data/gdctx/raw/2026-11-01T15-24-45-138Z-199b79_ru` |
| release-cli-tests | `bun --no-env-file src/cli.ts ctx run -- bun test src/commands/hub-update.test.ts src/commands/hub-machine.test.ts src/hub/status.test.ts src/cli-reference-coverage.test.ts src/standard/commands-by-task.test.ts src/standard/help-groups.test.ts scripts/hubctl-release.test.ts` | `.metaproject/data/gdctx/raw/2026-11-01T15-24-52-823Z-89ec62_ru` |
| release-package-tests | `bun --no-env-file src/cli.ts ctx run -- bun test scripts/package-team-hub.test.ts` | `.metaproject/data/gdctx/raw/2026-11-01T15-24-50-793Z-910c44_ru` |
| release-assets | `bun --no-env-file src/cli.ts ctx run -- bun scripts/build-hub-web.ts --check` | `.metaproject/data/gdctx/raw/2026-11-01T15-24-44-360Z-c549d3_ru` |
| release-doc-links | `bun --no-env-file src/cli.ts ctx run -- bun run check:doc-links` | `.metaproject/data/gdctx/raw/2026-11-01T15-24-44-647Z-7afeb6_ru` |
| release-shell-syntax | `bun --no-env-file src/cli.ts ctx run -- bash -n deploy/team-hub/hubctl deploy/team-hub/release/e2e.sh` | `.metaproject/data/gdctx/raw/2026-11-01T15-24-44-307Z-4b019d_ru` |

The normalized source-health report was read after completion. Required ESLint and TypeScript sources completed and parsed with zero findings. Optional oxlint, tests, dependency audit and SonarQube were skipped by health; explicit lint, typechecks and actual tests supplement that partial discovery scope.

## Coverage and candidate pin

Manifests: `output/release-update-quality-start.json` and `output/release-update-quality-end.json`. They capture tracked and untracked Hub/update command sources and tests, CLI registry, Hub/remote runtime, complete frontend, package/build and hubctl-test scripts, deployment/configuration, new release requirements and changed CLI/deployment docs. The digest is SHA-256 over the sorted path-to-content-SHA256 mapping.

Root committed during verification, advancing HEAD. Only `docs/requirements/hub-release-update/specification.md` changed within the measured file content; code bytes were stable. The documentation-link result is a snapshot from its execution time and needs affected verification if later documentation adds links.

The complete frontend matched the earlier 151-test source manifest byte for byte; repeating the UI suite was unnecessary. The owner supplied a fresh merged-backend result of 1786 passing tests across 159 files from this turn. That broader backend suite was not repeated by this affected release/update verifier.

The CLI/helper suite covered update flag validation and routing, installed-tool ownership and path trust, literal argv execution, preserved nonzero process status, dedicated help, existing machine CLI/status and help-reference coverage. Hubctl tests exercised checksummed release inspection, read-only dry run, mutable/incomplete/tampered release refusal, and trial Work/SSO settings parsing without credentials. They are local unit/helper proofs, not substitutes for the separately failing real-Docker upgrade test.

Packaging again exercised deterministic archives, import closure, Docker COPY/schema layout in a disposable build, symlink rejection, standalone client behavior and an extracted allowlisted source runtime. The explicitly requested packaging fixture installed frozen production-only dependencies **offline** into a temporary cache/home and ran an isolated smoke process. No production install, dependency update, persistent server operation, registry publication, image push or deployment was performed. No local Docker daemon was required or used by this verifier.

## Required next gate

Retain this pre-fix snapshot. After hubctl/source fixes are frozen, rerun only the affected helper/release regression tests, scoped script lint and shell syntax, relevant packaging tests and changed documentation links. Root/scripts types remain valid if TypeScript inputs are unchanged. The actual Docker SSO-upgrade and downgrade-compatibility preflight scenarios must pass separately before candidate clearance. The user intends to perform the production update; this report does not claim a release was published or a server was updated.

Routing audit: source ctx run/read used; graph not relevant to execution-only verification; testing context and normalized health report consulted; raw_rg_used: no.
