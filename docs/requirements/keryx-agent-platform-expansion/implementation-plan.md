# Keryx Agent Platform Expansion — Implementation Plan
Version: 0.1.3

## Status

Future program plan. This document sequences work; it does not start it. Flow
IDs are assigned only when each flow actually starts — none are pre-created by
this plan, consistent with the project convention that flow ids are minted on
`main` when a flow starts.

## Operating model

- One workstream (or named slice of a workstream, e.g. W5-a vs W5-b), one
  managed Flow, one worktree, one review bundle, one verification bundle per
  implementation unit.
- Freeze each workstream's acceptance criteria (its own `W<n>-AC<m>` list)
  before implementation starts.
- Run only dependency-independent slices in parallel, per the integration map
  in [specification.md](specification.md#integration-map).
- Model tier per task type, applied when dispatching implementation
  subagents:

| Task type | Suggested model tier | Examples |
|---|---|---|
| Mechanical | light | Schema scaffolding from an agreed shape, boilerplate exporter stubs, regenerating a catalog index. |
| Implementation | standard | Writing the stack-detection logic, the hook runtime, the bundle export/import commands, the audit scanners. |
| Review | deep | Reviewing hook-tightening semantics, promotion-boundary code, the security audit's own detectors, cross-workstream contract changes. |

## Wave 0 — Foundations

**Workstreams:** W7 (gdgraph/gdctx correctness), W5-a (unified harness adapter
registry, no new adapters yet).

**Deliverables:**
- W7: defect register with reproductions for GDCTX-1/2/3, regression tests,
  the correctness benchmark, the `GIT_READONLY_ALLOW` ctx hook allowlist,
  POSIX flag bundling, trust-aware redaction, stdout/stderr-aware error
  classification, fixture coverage for the existing gdgraph freshness
  self-check (`src/gdgraph/staleness.ts`) rather than a new self-check, the
  `.metaproject/index.md` hard-gate pointer-table rewrite (GDCTX-5), and
  memory entries for each closed defect.
- W5-a: one harness adapter registry replacing `src/ctx/runtimes.ts`,
  `src/ctx/orient-runtimes.ts`, and `src/security/agent-hooks/runtimes.ts`'s
  overlapping responsibilities, with capability flags and the
  merge/strip/validate path that removes the `securityHooks` (OQ-3)
  clobbering class. No new harnesses added yet — this slice is the registry
  shape, not coverage expansion.

**Entry criteria:** This package (README/prd/specification/brainstorm/
implementation-plan/metrics + all eight workstream files + all seven schemas)
has been reviewed and the review's blockers are resolved.

**Exit criteria:** W7's regression tests pass and are wired into CI; the ctx
guard false-block rate on the R7.3 allowlist is zero; W5-a's registry passes
its own guard test proving neither the ctx guard nor the security check-input/
output hook can clobber the other's config for any existing runtime.

**Dependencies:** None beyond package review.

**Risk:** Rewriting three registries into one touches every existing
host-hook installer; a regression here breaks currently-working Claude/Codex/
Cursor/Windsurf hook installation. Mitigated by requiring the existing
`agent-hooks.coexistence.test.ts`-style regression tests to keep passing
before any new capability is added.

## Wave 1 — Enforcement

**Workstreams:** W6 (keryx shell lifecycle hooks), W5-b (new adapters +
generated matrix), W8 (harness-config security audit + impact-evidence gate).

**Deliverables:**
- W6: the hook runtime (events, `.metaproject/hooks.json` / `~/.keryx/hooks.json`,
  Claude-Code-compatible JSON I/O), composition with the policy engine
  (tighten-only, per decision D-5), fail-closed/fail-open semantics, and the
  built-in hooks (ctx guard, security check-input/output, W3 observer stub,
  W8 evidence injector stub) registered through it.
- W5-b: Gemini CLI, Kiro, GitHub Copilot (agent), and Zed-via-ACP adapters
  added to the Wave 0 registry; the generated, CI-validated capability
  matrix; `keryx integrations install|doctor|uninstall --runtime <id>` (a
  namespace distinct from, and non-disruptive to, the existing `keryx harness
  run|exec|extension|wave` agent-runtime commands).
- W8: `keryx security audit-harness`, its detectors, and the impact-evidence
  gate (deterministic evidence via `keryx gdgraph affected` / `keryx test
  related`, not self-attestation).

**Entry criteria:** Wave 0 exit criteria met (W7 fixes merged; W5-a registry
in place).

**Exit criteria:** W6's hook runtime passes a guard test proving a hook can
never turn a policy-engine `deny` into `allow`; W5-b's matrix CI check passes
for every listed harness with every required field populated; W8's audit
produces findings with severity/score on a labeled fixture set and its
fix-proposals never apply themselves.

**Dependencies:** W6 and W8's evidence injector depend on W5-a's registry
shape (to register through the same mechanism host-harness hooks use). W8's
audit surfaces include W5-b's new adapter config files.

**Risk:** W6 is the first time keryx shell exposes a genuinely pluggable hook
system; an under-specified fail-closed rule here is worse than no hook system,
since it would be trusted immediately. Mitigated by requiring the deep-review
tier for the tighten-only composition logic before merge.

## Wave 2 — Catalog structure

**Workstreams:** W1 (detection, install profiles, governance — not yet stack
content), W2 (format, compiler, exporters — not yet the full agent catalog).

**Deliverables:**
- W1: `keryx stack detect`, the install-manifest schema and `keryx skills
  install --profile` plan/apply, `doctor`, uninstall, and the three
  governance gates (`scout`, `eval`, `stocktake`) with no stack packs
  authored yet beyond what is needed to exercise the gates.
- W2: the `.metaproject/agents/<name>.md` format, the compiler that produces
  `spawn_subagent`-shaped dispatch contracts from it, and exporters to Claude
  Code / Codex / Kiro / OpenCode / keryx shell child agents (support per
  harness recorded honestly via W5's matrix). The initial generic catalog
  (architect, planner, code-explorer, tdd-guide, refactor-cleaner,
  silent-failure-hunter, doc-updater, security-reviewer, performance-
  reviewer, e2e-runner) ships in this wave; per-stack pairs wait for Wave 4.

**Entry criteria:** Wave 1 exit criteria met (W6 hook runtime and W5-b matrix
available for W2's exporters to record support against; W8 audit available to
scan the new `.metaproject/agents/` files).

**Exit criteria:** `keryx stack detect` is deterministic and offline
(verified by running it twice against the same fixture repo with no network
and identical output); every generic agent in the initial catalog passes
`keryx agents verify`; every exporter's output is scanned clean by W8's audit.

**Dependencies:** W2's exporters depend on W5-b's matrix (to know which
harnesses to honestly claim support for).

**Risk:** Building the compiler before the multi-agent-engine team has
reviewed decision D-2 risks rework. Mitigated by treating D-2 review as a
Wave 2 entry gate, not something discovered mid-implementation.

## Wave 3 — Learning & portability

**Workstreams:** W3 (self-learning loop), W4 (portability).

**Deliverables:**
- W3: Observe (hooks from W6/W5 → bounded JSONL), Extract (deterministic
  signals first), the learned-pattern schema and record, review/consent
  commands, Apply (reusing `applyLearningProposal`), Promote (candidate-only,
  human-confirmed), Graduate (into W1/W2 creators), and the reviewer-profile
  learning generalization. Requires the `skill-lifecycle.mdc` amendment from
  decision D-3 to be merged first.
- W4: `keryx bundle export|import|inspect|verify`, the `~/.keryx/` user-level store,
  cross-harness memory handoff fields, read-only external-catalog vetting,
  and harness-specific instruction-file export via W5 adapters.

**Entry criteria:** Wave 2 exit criteria met (W1 governance gates and W2
compiler exist, since W3's Graduate stage and W4's export both target them);
W8's audit is available to scan bundle imports (R4.2) and learned-pattern
content (R3.4).

**Exit criteria:** Zero learned patterns exist in `accepted` status without a
recorded human accept action; a bundle export→import→inspect round-trip is
byte-identical for checksummed content on a fixture bundle; no import
overwrites a file the fixture marks user-modified.

**Dependencies:** W3's Promote step and W4's cross-harness memory handoff
both depend on the "no automatic promotion" invariant already established
system-wide by `shared-agent-context-generational-memory` — this wave adds no
new promotion mechanism, it reuses the existing constraint.

**Risk:** W3's Observe stage is the first hook-driven data collection in the
project; scope creep toward capturing more than bounded, redacted,
TTL'd JSONL would violate the SAC package's "no complete session transcript"
non-goal. Mitigated by a deep-review pass specifically checking Observe's
output against that non-goal before Wave 3 exit.

## Wave 4 — Content scale-out

**Workstreams:** W1 (stack packs), W2 (per-stack agents).

**Deliverables:** Stack packs (rules + skills + agent refs) and per-stack
reviewer/build-error-resolver agent pairs for the stacks named in the W1
target-stack table (`workstreams/W1-stack-catalog.md`), delivered in batches
of roughly four stacks. Each batch must pass
W1's `eval` gate (trigger-eval accuracy including negatives, behavior evals
at each defined strictness level, pass@k) before the next batch starts.

**Entry criteria:** Wave 2's governance gates have run successfully at least
once (on the initial generic catalog); Wave 3's W3/W4 are far enough along
that graduated skills/agents have somewhere to land, though Wave 4 does not
require Wave 3 to be fully complete.

**Exit criteria:** Each batch's stack packs and agent pairs pass `keryx
skills eval` and `keryx agents verify`; the stack-coverage count in
[metrics-and-validation.md](metrics-and-validation.md) increases only after a
batch passes its gate, never before.

**Dependencies:** Depends on W1's governance tooling (Wave 2) existing and
having been exercised; does not block on W3/W4 completion, only on their
existence as a landing target for anything Wave 4 content later graduates
into via W3/W4's own mechanisms.

**Risk:** This is the highest-visibility, most content-heavy wave and the
one most tempting to rush ahead of its gate. Mitigated by decision D-7
(governance before scale-out) being a hard entry criterion, not a suggestion.

## Cross-wave notes

- No wave pre-creates flow IDs; each workstream's Flow is initialized when
  that workstream's implementation actually starts, per project convention.
- A workstream may start early only if its specification is frozen and its
  declared dependencies (per the integration map) are satisfied or explicitly
  waived by the package owner, mirroring the wave-rule pattern used by
  `shared-agent-context-improvements-program`.
- Every wave's exit criteria must be demonstrated with evidence (a passing
  test, a CI check, a fixture run) — narrative completion is not sufficient,
  consistent with this program's own honest-status invariant.
