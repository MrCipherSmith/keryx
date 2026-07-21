# Implementation Plan

Status: ready

## Approach
Surgical Markdown edits only. For each stale package: update the top-of-file
`Version:` line and the `## Status` block; keep the rest of the prose intact
unless a short note is required to explain a status flip. Reconcile
`docs/requirements/roadmap.md` last so the package rows can be copy-finalized
from the just-updated package Status lines.

No subagent fan-out needed: every edit is small, deterministic, and interlinked
(roadmap summaries must match package Status lines), so doing them in one
coherent pass is cheaper than dispatching per-package workers.

## Steps
1. Track A — `roadmap.md`: bump Version 0.9.3 → 0.9.4; add rows for
   `keryx-opentui-shell` and `keryx-project-agent-harness`; rewrite the
   `keryx-metaproject-native` and `keryx-multi-agent-engine` rows.
2. Track B — per-package Status/Version corrections:
   - keryx-opentui-shell: 3 files, v0.1.0 → v0.2.0, draft → implemented.
   - keryx-metaproject-native: 3 files, v0.1.0 → v0.2.0, draft → "Phases 1-3 implemented; Phase 4 + RunDeps pending".
   - keryx-multi-agent-engine: 6 files, v0.1.0 → v0.2.0, draft → implemented (flows 088-101).
   - keryx-project-agent-harness: README v0.7.0 → v0.8.0; reconcile feature-summary.md; fix dead handoff link.
   - keryx-sandbox-credential-auto-mask: specification.md Status line + 6 more files bumped from v0.1.0.
   - keryx-execution-observability: prd.md + agent-protocol.md v0.1.0 → v0.2.0.
3. Track C — keryx-os-sandbox spec polish: add `mask-resolve.ts` /
   `dual-axis-report.ts` to spec §2 file index; document `--mask-mode` in §8;
   add the same modules to README file index.
4. Verify: `git diff main --stat` and `git diff main -- src/ | wc -l` == 0.
5. Review pass (docpack-review checklist): every edited Markdown still has a
   `Version:` header; no claim overstatement; roadmap rows match package Status.
6. Completion A → draft PR.

## Risks
- **R1 — Over-editing.** Tempting to rewrite prose while flipping Status.
  Mitigation: only touch the Status block + Version line + a one-line note.
- **R2 — Roadmap/package mismatch.** Roadmap summary must match package Status.
  Mitigation: edit packages first, then roadmap (already ordered in Steps).
- **R3 — Dead-link fix on harness README.** The `flow-orchestrator-handoff.md`
  target does not exist; either remove the reference or point to the actual
  handoff location if one exists. Investigate before deleting.
- **R4 — feature-summary.md vs README version.** Pick README as source of
  truth and bump feature-summary.md to match (or note the relationship).
