# Acceptance Criteria

- AC1: A canonical execution run record with `run_id`, `parent_run_id`,
  commit, branch, worktree, source timestamps, reliability labels, retries,
  final status, and artifact paths validates at runtime against the versioned
  JSON schema; canonical JSON and Markdown renderers are deterministic.
- AC2: Event aggregation reports exact Keryx/shell/tool/subagent/file/retry
  counts whenever structured events exist, separates active/wall/paused time,
  preserves `unknown` when lifecycle data is absent, and never invents
  token/cost/model values.
- AC3: Retry records accept only `task`, `keryx`, `environment`,
  `expected-tdd`, `external`, or `unknown`, and include a source/reason and
  final-outcome impact.
- AC4: Testing and health runs can write immutable per-run evidence linked to
  the root run and provenance; legacy Markdown and legacy full-report JSON are
  still readable.
- AC5: `latest.json` is an atomic, provenance-aware pointer to a finalized
  record and consumers detect stale or commit/branch/worktree-mismatched
  evidence instead of silently accepting it.
- AC6: Managed hooks resolve the Git common directory and pass in a linked
  worktree where `.git` is a file.
- AC7: Generated guidance contains no unsupported `keryx index refresh`, and
  supported refresh commands/help agree; the capability schema baseline passes
  for object-form module capabilities.
- AC8: Standard baseline/pr classification labels baseline-green,
  baseline-red, or baseline-unknown and does not attribute baseline failures to
  a PR without evidence.
- AC9: Lightweight mode selects gdgraph affected context, focused tests, and
  exactly one suitable reviewer, records every skipped phase and reason, and
  preserves required test/security gates.
- AC10: Direct-user ownership is one top-level opt-in; dispatched subagents do
  not prompt or emit independent final metrics reports and link via parent run.
- AC11: A reproducible benchmark harness validates 3–5 paired task runs and
  compares quality, active/wall time, context volume, retries, and human
  intervention while preserving unknowns and making no speed claim.
- AC12: Security redaction is applied before persistence/publication without
  removing required provenance, and package/docs/roadmap status claims match
  source and test evidence.
