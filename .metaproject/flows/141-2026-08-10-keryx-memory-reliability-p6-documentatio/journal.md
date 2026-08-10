# Flow Journal

- 2026-08-10T18:52:42.820Z - flow created

- 2026-08-10 - Context collected from P0–P5 flows, requirements package,
  accepted `src-memory` wiki, gdgraph, testing, memory, and health artifacts.
  Frozen 11 P6 criteria; flow 111 intentionally remains in progress for a
  verified handoff without PR.
- 2026-08-10 - Backed up and hash-verified the exact legacy files before
  deleting only `.metaproject/data/memory/artifacts/latest.md` and `.json` with
  `apply_patch`. Backup: `/private/tmp/keryx-memory-latest-backup-2026-08-10/`.
  SHA-256 md=`02ffcdc4fda1133613e73ce02d8b401329e3f81101406b0b83e11b76c617fac6`,
  json=`ec9f67830a693d2641439d6c8d4519f3c23361ed967c9f71c958a02cec6453f3`.
- 2026-08-10 - Updated source registry/module metadata, memory templates and
  workspace references, CLI/module/architecture/setup/workflow docs, package
  status/version/roadmap, changelog, and accepted `src-memory` wiki. Wiki index
  and links: 38 pages indexed; 41 pages/228 links checked; 0 broken.
- 2026-08-10 - Targeted suites PASS 319/0/2 (61 files), post-doc regression
  suite PASS 25/0, and TypeScript PASS. Full Bun suite is an explicit concern:
  1,862 pass, 10 skip, 15 live loopback proxy/sandbox failures (port 0 bind),
  owned by harness/sandbox maintainers; not mislabeled as pass. Health remains
  WARN score 92/regression 3. Non-empty memory fixture intentionally warns with
  12 dedup/conflict issues and missing optional catalog; project memory check
  passes. Flow check has one pre-existing flow-002 checksum mismatch.
- 2026-08-10 - The system `keryx` executable was found stale during a CLI smoke
  and recreated only the two legacy latest artifacts. Their exact second
  contents were backed up under the required backup root's
  `rerun-after-global-cli/` subdirectory (md=`ba18dc8d7600a7a049282f086816bda8cf9d098d031a810a6e563d98e7b08526`,
  json=`08c77d9d8b46d3c849da90403dc8950aef60907f81816bc6e49619d9db1b6e29`),
  then only those two files were deleted again with `apply_patch`; final absence
  was verified. Current-source CLI was verified with `bun run src/cli.ts`.
- 2026-08-10T18:54:25.768Z - frozen: 11 criteria; checksum recorded
- 2026-08-10T18:54:28.147Z - started
- 2026-08-10T19:01:23.924Z - task-done: T1: Collect remaining context
- 2026-08-10T19:05:31.406Z - task-done: T2: Implement per plan
- 2026-08-10T19:05:31.930Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-10T19:05:32.217Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-10T19:05:41.693Z - ac-confirmed: AC1: Source CLI help/registry verified: pure search, --save-report, transition, validation, catalog/migration metadata; command registry tests pass.
- 2026-08-10T19:05:41.840Z - ac-confirmed: AC2: Updated module/architecture/setup/workspace/memory docs/templates/skill/index; stale-claim scan found only other-module latest artifacts or explicit migration/history wording.
- 2026-08-10T19:05:42.027Z - ac-confirmed: AC3: src-memory wiki updated to 1.1.0; wiki index, check-links (228 links/0 broken), and validate pass.
- 2026-08-10T19:05:42.274Z - ac-confirmed: AC4: Package/roadmap/plan/metrics versions/status updated honestly; metrics contains PRD AC-1..AC-12 evidence mapping.
- 2026-08-10T19:05:42.431Z - ac-confirmed: AC5: Exact latest.md/json backed up and hash-verified under /private/tmp/keryx-memory-latest-backup-2026-08-10/, then only those files removed via apply_patch; ignore/migration tests pass.
- 2026-08-10T19:05:42.603Z - ac-confirmed: AC6: Targeted requested suite 319 pass/0 fail/2 skip; post-doc regression 25 pass/0 fail; exceptions and owners recorded.
- 2026-08-10T19:05:42.779Z - ac-confirmed: AC7: tsc exit 0; one stable full bun run recorded honestly as 1862 pass/10 skip/15 live proxy failures with owner/follow-up.
- 2026-08-10T19:05:42.949Z - ac-confirmed: AC8: Non-empty fixture check recorded: 6 entries, expected 12 dedup/conflict + missing optional catalog warnings; project store check passes.
- 2026-08-10T19:05:43.134Z - ac-confirmed: AC9: Structural check: 6 Markdown files versioned, README links complete, schema valid; adversarial review has zero blockers and warnings documented.
- 2026-08-10T19:05:43.330Z - ac-confirmed: AC10: Final gdgraph build 562 nodes/1203 edges; affected contexts inspected for registry/module/templates/gitignore/wiki anchors; wiki links pass.
- 2026-08-10T19:05:43.623Z - ac-confirmed: AC11: Unreleased changelog and migration guidance cover reports/catalogs/embeddings, legacy latest advisory, lifecycle and validation behavior.
- 2026-08-10T19:42:14.081Z - renumbered: 111 -> 141: ID collision after rebase onto origin/main
- 2026-08-10T19:42:53.752Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/261 (tracker unavailable: existence not verified)
