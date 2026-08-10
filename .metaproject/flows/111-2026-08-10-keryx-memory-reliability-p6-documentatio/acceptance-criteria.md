# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: CLI help/reference and `src/standard/command-registry.ts` plus module command metadata document pure default search, `--save-report`, `memory transition`, validation, optional catalog semantics, and migration behavior; registry output and `keryx memory --help` are verified.
- AC2: Module, architecture, complete-setup/workflow, workspace, memory manifest/index/template/skill, and generated data references consistently state that Markdown is canonical, default search is filesystem-pure, reports/catalogs/embeddings are disposable, and search does not consume an inverted index.
- AC3: The accepted `.metaproject/wiki/components/src-memory.md` accurately describes current service/search/report/lifecycle/catalog behavior, has a bumped version/changelog, and `keryx wiki index`, `keryx wiki check-links`, and `keryx wiki validate` pass.
- AC4: The requirements package, implementation plan, metrics evidence, PRD status/progress dashboard, roadmap, and documentation versions are updated honestly; all twelve PRD ACs map to executable tests or explicit verification evidence.
- AC5: The two tracked legacy artifacts are copied byte-for-byte to `/private/tmp/keryx-memory-latest-backup-2026-08-10/`, hashes are verified, then only those two repository files are deleted with `apply_patch`; generated ignore and non-destructive downstream migration policy are verified and documented.
- AC6: Targeted memory, harness, MCP, flow, command, init/update, security, and embedding suites pass with exact counts recorded, and any exception is reproduced, scoped, assigned an owner/follow-up, and not labeled pass.
- AC7: `tsc --noEmit` and one stable full Bun test suite run are recorded with exact counts/results; pre-existing or environment warnings are separately classified.
- AC8: `keryx memory check` runs against a non-empty fixture/store, reports the expected clean or warning state, and the exact command/result is recorded.
- AC9: Requirements/docpack structural verification and adversarial consistency review report zero blockers, including H1/version/link/traceability and no stale latest/inverted-index claims.
- AC10: `keryx gdgraph build` refreshes graph data after final code/doc changes; changed-file blast radius and documentation/wiki links are inspected and recorded.
- AC11: Migration guidance and an Unreleased changelog/release entry explain explicit report cleanup, generated-data ignore policy, legacy latest untracking advisory, and lifecycle/validation behavior without claiming a PR or completed flow.
