# Launch prompt — Sync `docs/requirements` statuses and bump stale package versions
Version: 0.1.0

Copy the fenced block into a flow-orchestrator session. One flow, no phases.

---

```text
Run flow-orchestrator for ONE documentation-truth package: sync every
docs/requirements/<package>/ Status line with the actual codebase, add the two
missing packages to roadmap.md, and bump stale Version headers. Documentation
ONLY — no runtime code changes.

## Metaproject hard gate
Project root: keryx worktree on a clean dedicated branch.
Read `<project-root>/.metaproject/index.md` before any repo action.
Never edit flow.json by hand. All flow state: `keryx flow …` CLI only.
Run keryx via `bun ./src/cli.ts …` (the binary is not on PATH).

## Standing operator rule
When green: commit deliverables and push, create a DRAFT PR.
Then stop. Do not invent new requirements packages or features.

## Intent
A 12-package audit of docs/requirements/ found that the roadmap and several
package Status/Version lines contradict the actual src/ code. Fix those so the
docs tell the truth. This is a docs-only reconciliation flow.

## Baseline facts (verified during audit — do NOT re-derive, treat as inputs)
Per-package code reality:
- keryx-opentui-shell       — IMPLEMENTED and default shell (src/tui/tui-shell.ts,
                              src/commands/shell.ts:1043-1049, ADR-0005 Accepted).
                              Package Status today: "draft". MISSING from roadmap.
- keryx-metaproject-native  — Phases 1-3 landed (src/harness/tool/metaproject-
                              {port,adapter,operations}.ts, src/mcp/metaproject-tools.ts,
                              flow-state schema + `keryx flow schema` CLI). Phase 4 and
                              RunDeps.metaprojectPort wiring still pending.
                              Package Status today: "draft — no new runtime". MISLEADING.
- keryx-multi-agent-engine  — Entire A→B→C roadmap shipped as flows 088-101
                              (resolveChildModel, allowlist, caps, budget ledger with
                              cost-dimension, keryx agents monitor, quarantine,
                              escalation, worktrees, peer messaging).
                              Package Status today: "draft — no new runtime". FALSE.
- keryx-project-agent-harness — Substantially implemented (src/harness/ = 175 files,
                              Release 0 + most Release 1/2: resume, branch/compaction,
                              mutation guard, Anthropic+Ollama providers, child isolation,
                              sandbox integration). MISSING from roadmap entirely.
                              README v0.7.0 says "No runtime implementation is claimed".
- keryx-sandbox-credential-auto-mask — P0/Verify/P1/P2/P0.b ALL landed (PR #175-179,
                              flow 103/105/106/107/108). specification.md:17 still says
                              "draft — not implemented". prd/brainstorm/policies/
                              implementation-plan/metrics-and-validation/verification
                              all stuck at Version 0.1.0.
- keryx-execution-observability — prd.md and agent-protocol.md stuck at Version 0.1.0
                              while the rest of the package is at 0.2.0.
- keryx-os-sandbox          — Status accurate, but spec §2/§7-§9 and README index do
                              not mention mask-mode/auto-mask and dual-axis-report
                              modules that are wired into harness.ts.
- managed-review-feedback-loop, flow-reviewer, gdgraph-java-import-resolution,
  keryx-context-operations, keryx-telegram-transport — Status ACCURATE, no change
  needed beyond optional polish.

## Deliverables (all of these in this flow)

### Track A — roadmap.md reconciliation (highest priority)
1. Add rows for keryx-opentui-shell and keryx-project-agent-harness (currently
   missing from docs/requirements/roadmap.md Packages table).
2. Rewrite the keryx-metaproject-native row: change "draft" to reflect that
   Phases 1-3 are implemented, with Phase 4 + RunDeps wiring outstanding.
3. Rewrite the keryx-multi-agent-engine row: change "draft / no new runtime"
   to "implemented" with a short note on flows 088-101.
4. Bump roadmap Version by a minor (0.9.3 -> 0.9.4) and add a one-line
   changelog note at the top of the Status section.

### Track B — Status/Version corrections in stale packages
For each of these packages, edit the top-of-file `Version:` line and the
`## Status` block so they match code reality:
- keryx-opentui-shell/{README,prd,specification}.md : Status "draft" -> "implemented";
  Version 0.1.0 -> 0.2.0. Note that side-workers/MAE-spawn went beyond the
  original spec scope (cite flows 065/066/9b0ca29 if useful) and that --tui is
  default-on.
- keryx-metaproject-native/{README,prd,specification}.md : Status "draft — no new
  runtime" -> reflect Phases 1-3 implemented, Phase 4 + RunDeps.metaprojectPort
  pending. Bump Version 0.1.0 -> 0.2.0.
- keryx-multi-agent-engine/{README,prd,specification,agent-protocol,brainstorm,
  implementation-plan}.md : Status "draft" -> "implemented (flows 088-101)".
  Bump Version 0.1.0 -> 0.2.0. Note keryx agents monitor <file> surface drift.
- keryx-project-agent-harness/README.md : Status "No runtime implementation is
  claimed" -> reflect Release 0 + most of Release 1/2 implemented. Bump Version
  0.7.0 -> 0.8.0. Reconcile feature-summary.md (1.0.0) vs README version.
  Remove/fix the dead link to .metaproject/jobs/.../flow-orchestrator-handoff.md.
- keryx-sandbox-credential-auto-mask/specification.md : change line 17
  "Status: draft — not implemented" -> "implemented (P0–P0.b, PR #175-179)".
  Bump prd.md, brainstorm.md, policies.md, implementation-plan.md,
  metrics-and-validation.md, verification.md Version 0.1.0 -> at least 0.2.0
  (or match README 0.5.0 where content was actually edited by PR #179).
- keryx-execution-observability/{prd,agent-protocol}.md : Version 0.1.0 -> 0.2.0.

### Track C — minor spec completeness for keryx-os-sandbox
- Add a "Recent additions" subsection (or extend the file index in spec §2) to
  mention src/harness/process/sandbox/mask-resolve.ts and dual-axis-report.ts,
  and add the --mask-mode auto|manual|off CLI surface to spec §8.
- No code change required; doc-only.

## Frozen acceptance criteria
- AC1: roadmap.md Packages table contains rows for keryx-opentui-shell and
  keryx-project-agent-harness with statuses that match code reality.
- AC2: roadmap rows for keryx-metaproject-native and keryx-multi-agent-engine no
  longer say "draft" or "no new runtime implemented"; they reflect implemented
  Phases 1-3 / flows 088-101.
- AC3: keryx-opentui-shell README/prd/specification Status lines say
  "implemented" and Version >= 0.2.0.
- AC4: keryx-metaproject-native and keryx-multi-agent-engine README/prd/spec
  Status lines reflect implemented runtime; Version >= 0.2.0 on every edited doc.
- AC5: keryx-project-agent-harness README Status no longer claims "no runtime";
  dead handoff link fixed or removed; feature-summary vs README version
  mismatch resolved.
- AC6: keryx-sandbox-credential-auto-mask specification.md no longer says
  "draft — not implemented"; every edited doc carries an updated Version header.
- AC7: keryx-execution-observability prd.md and agent-protocol.md Version
  bumped to 0.2.0.
- AC8: keryx-os-sandbox spec mentions mask-resolve.ts / dual-axis-report.ts and
  the --mask-mode flag; no code change.
- AC9: NO files under src/ are modified (docs-only flow). `git diff main -- src/
  | wc -l` returns 0.
- AC10: Every edited Markdown file still has a `Version:` line (per Iron Law 3
  of docpack-orchestrator).

## Constraints
- Documentation ONLY. No runtime code changes; no new tests; no schema changes.
- Preserve useful existing prose; do not rewrite whole documents — only fix the
  Status/Version lines and add the minimum needed notes.
- Do not invent new requirements packages or new "future" phases.
- Every edited Markdown file must still carry a `Version:` header.
- Do not bump versions that are already correct (e.g., telegram-transport,
  context-operations, flow-reviewer stay at their current versions).
- Never edit flow.json / frozen AC by hand.

## Out of scope
- Implementing Phase 4 of metaproject-native, finishing MAE reduceState, Linux
  sandbox parity, or any other code work flagged by the audit.
- Refactoring doc structure; renaming files; splitting/merging packages.
- Touching docs/ outside docs/requirements/ and docs/decisions/.

## Flow lifecycle
1. keryx flow init --title "Sync requirements/roadmap.md statuses and bump
   stale package versions"
2. Freeze AC1..AC10; start; execute; verify (git diff --stat, docpack review);
   completion A (draft PR).

## Done report
flow id, list of files touched (per package), git diff --stat summary,
draft PR URL, residual risks, explicit: "docs-only reconciliation; no src/
changes".
```

---

## Scope down (if operator wants a smaller flow)

| Sub-prompt title | Only tracks |
|------------------|-------------|
| Roadmap sync only | Track A + AC1, AC2, AC9, AC10 |
| Stale package versions only | Track B + AC3..AC7, AC9, AC10 |
| os-sandbox spec polish only | Track C + AC8, AC9, AC10 |
