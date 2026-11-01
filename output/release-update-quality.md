# Release/update quality gate — Draft PR review candidate

**Gate: PASS for Draft PR1113 review.** This supersedes the earlier local pre-fix snapshot. It is not permission to merge, create a tag, publish a release/image/package, or deploy. The user requested personal review of the Draft PR before further action. Version `0.4.4` is unpublished preparation metadata in this candidate.

Worktree: `/Users/Goodea/.codex/worktrees/hub-work-management/keryx`
Branch: `feat-hub-work-management`
HEAD before/after: `9480300f790ca56fdce1257e4a270ee0808295a5`
Manifest window: 2026-11-01T16:11:19Z through 2026-11-01T16:13:27Z.
Checks started at 16:12:14Z; latest check finished at 16:12:58Z.

```yaml
VERIFICATION_RESULT:
  gate: PASS
  purpose: Draft_PR1113_owner_review_only
  merge_tag_publish_deploy: not_performed
  package_version: 0.4.4
  package_publication: not_performed
  candidate:
    measured_files: 445
    scope_digest_before: ee7aca205f52913bd79f605aac79665877920ab04fc4e963da1670f5609fcd17
    scope_digest_after: ee7aca205f52913bd79f605aac79665877920ab04fc4e963da1670f5609fcd17
    changed_files_during_checks: []
    ui_changes_since_151_pass: []
    backend_changes_since_7995e7cac: []
  checks:
    source_health:
      status: pass
      findings: 0
      coverage: partial_optional_sources
      generated_at: 2026-11-01T16:12:58.607Z
    root_type_check: { status: pass, errors: 0 }
    scripts_type_check: { status: pass, errors: 0 }
    scoped_typescript_lint: { status: pass, errors: 0, warnings: 0 }
    cli_reference_machine_status_tests:
      status: pass
      passed: 110
      failed: 0
      files: 6
      expectations: 3148
      duration_seconds: 7.71
    helper_wrapper_tests:
      status: pass
      passed: 10
      failed: 0
      files: 2
      expectations: 45
      duration_seconds: 5.18
      hubctl_cases: 7
      migration_wrapper_cases: 3
      nested_python_safety_tests: 10
      actual_loopback_HTTP_probes: 2
      note: Python tests and HTTP probes are nested within the wrapper scope, not additional Bun test counts.
    packaging_tests:
      status: pass
      passed: 6
      failed: 0
      files: 1
      expectations: 40
      duration_seconds: 7.03
    embedded_assets:
      status: pass
      input_digest: 7e9ed0a2f870a5b77be4295a223ec48da69b6cf49ebfe9218a968c5e368c565f
    documentation_links:
      status: pass
      checked_links: 2040
      files: 690
      broken: 0
    shell_syntax: { status: pass, files: 3 }
    python_AST_syntax: { status: pass, files: 2 }
    UI:
      status: retained_pass
      passed: 151
      failed: 0
      repeated: false
      note: current complete app content hashes match the prior passing UI manifest.
    backend:
      status: retained_owner_result
      passed: 1786
      failed: 0
      files: 159
      repeated: false
      note: Hub and remote runtime bytes match tested merged-main reference 7995e7cac; new CLI/helper additions tested separately.
  failed_checks: []
  findings: []
```

## Exact commands and evidence

All executions used the source CLI context wrapper, not an installed stale CLI. Counts are independent scopes, not a total that adds repeated or nested runs.

| Check | Exact command | Raw evidence |
|---|---|---|
| pr-health | `bun --no-env-file src/cli.ts ctx run -- bun --no-env-file src/cli.ts health run --changed --source eslint,typescript` | `.metaproject/data/gdctx/raw/2026-11-01T16-12-58-638Z-8a59cb_ru` |
| pr-types | `bun --no-env-file src/cli.ts ctx run -- bun run typecheck` | `.metaproject/data/gdctx/raw/2026-11-01T16-12-48-511Z-3eaab8_ru` |
| pr-script-types | `bun --no-env-file src/cli.ts ctx run -- bun run typecheck:scripts` | `.metaproject/data/gdctx/raw/2026-11-01T16-12-23-641Z-240aa7_ru` |
| pr-lint | `bun --no-env-file src/cli.ts ctx run -- bun node_modules/eslint/bin/eslint.js src/cli-registry.ts src/commands/hub.ts src/commands/hub-update.ts src/commands/hub-update.test.ts scripts/hubctl-release.test.ts scripts/hub-legacy-migration.test.ts` | `.metaproject/data/gdctx/raw/2026-11-01T16-12-17-011Z-79687a_ru` |
| pr-cli-tests | `bun --no-env-file src/cli.ts ctx run -- bun test src/commands/hub-update.test.ts src/commands/hub-machine.test.ts src/hub/status.test.ts src/cli-reference-coverage.test.ts src/standard/commands-by-task.test.ts src/standard/help-groups.test.ts` | `.metaproject/data/gdctx/raw/2026-11-01T16-12-23-499Z-6b8853_ru` |
| pr-helper-tests | `bun --no-env-file src/cli.ts ctx run -- bun test scripts/hubctl-release.test.ts scripts/hub-legacy-migration.test.ts` | `.metaproject/data/gdctx/raw/2026-11-01T16-12-21-044Z-ff0480_ru` |
| pr-package-tests | `bun --no-env-file src/cli.ts ctx run -- bun test scripts/package-team-hub.test.ts` | `.metaproject/data/gdctx/raw/2026-11-01T16-12-22-821Z-486d2e_ru` |
| pr-assets | `bun --no-env-file src/cli.ts ctx run -- bun scripts/build-hub-web.ts --check` | `.metaproject/data/gdctx/raw/2026-11-01T16-12-15-776Z-0e23c6_ru` |
| pr-doc-links | `bun --no-env-file src/cli.ts ctx run -- bun run check:doc-links` | `.metaproject/data/gdctx/raw/2026-11-01T16-12-16-251Z-5e6ee8_ru` |
| pr-shell-syntax | `bun --no-env-file src/cli.ts ctx run -- sh -n deploy/team-hub/hubctl deploy/team-hub/release/bundle.sh deploy/team-hub/release/e2e.sh` | `.metaproject/data/gdctx/raw/2026-11-01T16-12-15-794Z-0ce287_ru` |
| pr-python-syntax | `bun --no-env-file src/cli.ts ctx run -- python3 -c 'import ast,pathlib; [ast.parse(pathlib.Path(p).read_text(), filename=p) for p in ["deploy/team-hub/migrate-legacy.py", "deploy/team-hub/release/migrate-legacy.test.py"]]; print("Python AST syntax: 2 files passed")'` | `.metaproject/data/gdctx/raw/2026-11-01T16-12-15-870Z-006975_ru` |

The normalized health report was read after completion. Required ESLint and TypeScript sources completed and parsed with zero findings. Optional oxlint, tests, dependency audit and SonarQube were not executed by health. Explicit types, scoped lint and actual tests above supplement its partial discovery coverage. Python was checked through AST parsing and the ten safety tests; shell scripts were checked with POSIX `sh -n`. No new Python or shell linter was installed.

## Tested behavior and boundaries

The CLI suite covers installed-tool ownership/path trust, literal argv handling, update/check/dry-run flags, confirmation routing, exact failing process exit status, dedicated help, existing machine/status behavior and CLI-reference coverage.

The seven hubctl cases cover checksummed release inspection, read-only dry run, incomplete/tampered/mutable release refusal, explicit downgrade refusal before Docker or install mutation, Work/SSO trial configuration preservation and required Access-role mounts.

The migration wrapper runs ten Python safety tests using disposable fixtures. It additionally extracts and runs the **actual** migration rehearsal JavaScript probe against a real loopback Hub HTTP server and executes the **actual** E2E curl activation command against that API. Both probes use matching operation/idempotency values and create managed work only in disposable test state. These are HTTP integration proofs, not merely copied request mocks.

Packaging tests cover deterministic archives, runtime import closure, Docker COPY/schema layout through a disposable build, symlink rejection, standalone context-client behavior, and a real extracted allowlisted source archive. The extracted-runtime fixture uses frozen production-only scripts-disabled **offline** dependencies in disposable cache/home and serves managed-work/authenticated MCP from an isolated process. No global installation, dependency upgrade, existing server mutation or registry operation occurred.

## Candidate pin and historical evidence

Before/after manifests: `output/release-update-final-start.json` and `output/release-update-final-end.json`. They include tracked and untracked new helper sources/tests, CLI/update source and registry, Hub/remote runtime, complete frontend, package/build scripts, deployment files, release requirements, changelog, version metadata and changed deployment/CLI/adoption documentation. The digest is SHA-256 over the sorted path-to-content-SHA256 mapping. All 445 measured contents and HEAD were identical across this run.

The UI matches the earlier 151-test candidate byte for byte, and embedded freshness was checked, so repeating the UI suite was unnecessary. Hub/remote runtime bytes match merged-main reference `7995e7cac`; the owner supplied the fresh 1786-pass backend result for that reference. This verifier did not rerun the broad backend suite or independently relabel the owner's result as a new run.

The old pre-fix report, including the historical failing Docker assertion and compatibility review blocker, is preserved at `output/release-update-quality-prefixed-history.md`. The owner subsequently reported core real-Docker E2E and isolated production-copy trial success; those external proofs remain maintained separately. This local report does not claim it executed Docker/Geekom or modified production. The new helper's final frozen safety changes were covered by the local tests above.

## Review-only limits

PR1113 must remain Draft for the user's review. This verifier made no PR-state change and did not merge, create a tag, publish a release/package/image, update production, or start a persistent server. The only servers/install processes used here were explicitly requested disposable tests.

Independent code review and the owner's actual Docker/copy-environment evidence are separate gates. Passing this quality gate supports review of this exact candidate; it does not replace user approval or authorize publication. Any later code, helper, schema, package-version, asset or measured-document change requires affected verification and an updated digest.

No source files were edited by this verifier. Only test fixtures, normalized health/context reports, scope manifests and this report were written.

Routing audit: graph not relevant to execution-only verification; source ctx run/read used; project testing context and normalized health report consulted; raw_rg_used: no.
