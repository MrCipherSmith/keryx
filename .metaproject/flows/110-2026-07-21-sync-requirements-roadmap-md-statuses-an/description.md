# Sync requirements/roadmap.md statuses and bump stale package versions

Status: ready
Source: 12-package audit of docs/requirements vs. src/ (chat with user)

## Problem
A 12-package audit of `docs/requirements/` compared each package's declared
Status (in README/prd/specification) and the roadmap row against actual runtime
code under `src/`. Five packages have statuses that contradict code:

- `keryx-opentui-shell` — Status `draft`, but it is implemented and the default
  shell (`src/tui/tui-shell.ts`, ADR-0005 Accepted). Also MISSING from roadmap.
- `keryx-metaproject-native` — Status `draft — no new runtime`, but Phases 1-3
  landed (`src/harness/tool/metaproject-{port,adapter,operations}.ts`,
  `src/mcp/metaproject-tools.ts`, flow-state schema + `keryx flow schema`).
- `keryx-multi-agent-engine` — Status `draft — no new runtime`, but the entire
  A→B→C roadmap shipped as flows 088-101.
- `keryx-project-agent-harness` — README says "no runtime implementation is
  claimed", but `src/harness/` is 175 files (Release 0 + most of Release 1/2).
  Also MISSING from `roadmap.md`.
- `keryx-sandbox-credential-auto-mask` — P0/Verify/P1/P2/P0.b all merged
  (PR #175-179) but `specification.md:17` still says `draft — not implemented`
  and most package docs are stuck at `Version: 0.1.0`.

Two minor staleness cases:
- `keryx-execution-observability`: `prd.md`/`agent-protocol.md` at 0.1.0 while
  the rest of the package is 0.2.0.
- `keryx-os-sandbox`: spec §2/§7-§9 and README file index omit
  `mask-resolve.ts`, `dual-axis-report.ts`, and the `--mask-mode` flag that are
  wired into `harness.ts`.

## Expected Outcome
`docs/requirements/roadmap.md` and the affected package README/prd/spec files
truthfully reflect the implemented runtime. Two missing packages are added to
the roadmap. Stale `Version:` headers bumped. **No source code changes.**

## Out of Scope
- Implementing any of the deferred items (metaproject-native Phase 4, MAE
  `reduceState`, Linux sandbox parity, etc.).
- Refactoring or splitting packages.
- Touching docs outside `docs/requirements/`.
