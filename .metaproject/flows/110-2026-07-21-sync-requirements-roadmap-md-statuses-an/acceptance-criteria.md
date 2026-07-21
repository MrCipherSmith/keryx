# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `docs/requirements/roadmap.md` Packages table contains rows for `keryx-opentui-shell` and `keryx-project-agent-harness` with statuses that match code reality.
- AC2: roadmap rows for `keryx-metaproject-native` and `keryx-multi-agent-engine` no longer say "draft" or "no new runtime implemented"; they reflect implemented Phases 1-3 / flows 088-101.
- AC3: `keryx-opentui-shell/{README,prd,specification}.md` Status lines say "implemented" and `Version` >= 0.2.0.
- AC4: `keryx-metaproject-native` and `keryx-multi-agent-engine` README/prd/spec Status lines reflect implemented runtime; `Version` >= 0.2.0 on every edited doc.
- AC5: `keryx-project-agent-harness/README.md` Status no longer claims "no runtime"; dead handoff link fixed or removed; `feature-summary.md` vs README version mismatch resolved.
- AC6: `keryx-sandbox-credential-auto-mask/specification.md` no longer says "draft — not implemented"; every edited doc in that package carries an updated `Version` header.
- AC7: `keryx-execution-observability/{prd,agent-protocol}.md` `Version` bumped to 0.2.0.
- AC8: `keryx-os-sandbox` spec mentions `mask-resolve.ts` / `dual-axis-report.ts` and the `--mask-mode` flag; no code change.
- AC9: NO files under `src/` are modified. `git diff main -- src/` is empty.
- AC10: Every edited Markdown file still has a `Version:` line (docpack Iron Law 3).
