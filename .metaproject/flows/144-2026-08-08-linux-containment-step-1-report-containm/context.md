# Context

## Specification sources (read in full before editing)

| Document | What it pins |
|---|---|
| `docs/requirements/keryx-linux-containment/README.md` | Scope, related modules, the branch dependency |
| `docs/requirements/keryx-linux-containment/prd.md` | R4–R8, N1–N5, the measurements |
| `docs/requirements/keryx-linux-containment/specification.md` | §2 inventory, §5 third state, §6 probe contract, §7 CLI surface, §10 AC |
| `docs/requirements/keryx-linux-containment/implementation-plan.md` | Step 1 boundary; step 2/3 are Landlock and are NOT this flow |
| `docs/decisions/keryx-harness/ADR-0010-…` | The decision and the host measurement |

## Branch

Base: `feat/linux-containment-landlock` (already carries the merge of
`fix/benchmark-remediation-v2`, so `capability-matrix.ts`, `src/commands/sandbox.ts`,
the doc-sync test and `install.sh`'s sandbox reporting all exist — step 0 of the
plan is settled). Working branch: `feat/linux-containment-probe`. PR targets the
base branch, never `main`.

## Code touched

| File | State | Role |
|---|---|---|
| `src/harness/process/sandbox/probe.ts` | **new** | impure, injectable, cached trial containment |
| `src/harness/process/sandbox/probe.test.ts` | **new** | AC4, AC5 over a fake spawn |
| `src/harness/process/sandbox/capability-matrix.ts` | changed | third state + Linux kernel-mechanism axis |
| `src/harness/process/sandbox/capability-matrix.doc-sync.test.ts` | changed | AC7 — the third state cannot drift from the runbook |
| `src/commands/sandbox.ts` | changed | renders the probe (AC6) |
| `src/commands/sandbox.test.ts` | changed | AC6 over the render function |
| `scripts/install.sh` | changed | delegates to `keryx sandbox status` (R7) |
| `scripts/install-global.test.ts` | changed | the installer's new wording, end to end |
| `docs/verification/linux-sandbox-verification.md` | changed | documents the third state (doc-sync target) |

## Read but not modified

- `detect.ts` — the `available: boolean` seam. Spec §2 replaces it with a layer
  choice in **step 3**; step 1 leaves it alone and composes the probe on top.
- `bwrap.ts` / `seatbelt.ts` — the probe reuses `wrapBwrap` / `wrapSeatbelt` to
  build the trial command, so the trial runs under the *real* wrapper the
  product uses, not a hand-written approximation.
- `adapter.ts` — fail-closed. Not touched (N1 / AC8).

## Host facts (2026-08-08, this machine)

- Ubuntu 24.04, kernel 6.8.0-136-generic.
- `/etc/apparmor.d/bwrap` **is installed here**, so bubblewrap works on this
  host today. The failing state is therefore reproduced through the probe's
  injected spawn seam, never by removing that profile (the implementation plan's
  step 5 records why removing it would false-pass a different criterion).

## Constraints carried from the PRD

- **N1** fail-closed preserved; no new bypass, escape hatches unchanged.
- **N2** no new npm dependency.
- **N3** pure modules stay pure; the probe is the only new impure module and it
  is injectable exactly as `detect.ts` injects `existsSync`.
- **N4** at most one probe per process, cached; never probed on a path that is
  not reporting capability.
- **N5** no regression on macOS.
- **R8** name the AppArmor profile; **never** the machine-wide sysctl.
