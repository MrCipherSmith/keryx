# ADR-0003: Security Profiles, Required Containment, and Fail-Closed Decision

**Status**: Accepted / Frozen 2026-07-12

**Decision ID**: D-03
**Task**: implementation-plan.md §W1 row D-03 (`S-04, R1-01, M-02`)
**Reviewer Track**: security
**Source of Truth**: docs/requirements/keryx-project-agent-harness/

---

## Context

Keryx executes model-directed actions in a repository. Its security objective,
frozen in `security-protocol.md` §Security Objective, is to ensure that
"untrusted content can influence reasoning but cannot silently expand
authority." Under ADR-0001 (D-01), Release 0 is an offline, read-only vertical
slice: no filesystem writes, shell, network, child agents, or executable
extensions. D-03 governs the moment that boundary is crossed — when mutation and
higher-risk operation become permitted in Release 1 and later — and freezes the
posture that keeps expanded authority explicit, contained, and fail-closed.

This decision does **not** re-decide the posture. The PRD §Decisions and Open
Questions already adopts baseline D4: "security profiles and fail-closed
containment are mandatory for higher-risk operation." The `brainstorm.md`
§Selected Decisions add D5 (Policy Is a First-Class Domain — permission
resolution is deterministic, testable, and independent of the CLI/TUI) and D4
(Tool Registry Before Prompt Features — the model may only affect the project
through typed tools; prompt templates, skills, and roles cannot bypass tool
policy). This ADR restates that frozen posture, structures it as a
profile/isolation matrix mapped to `policy-profile.schema.json`, and states the
fail-closed rule explicitly and unambiguously.

The three profiles are fixed by the schema enum and the frozen prose and are not
invented here:

- `policy-profile.schema.json` `profileId` enum: `read-only-review`,
  `monitored-trusted-local`, `unattended-untrusted`; `trustMode` enum:
  `read-only`, `trusted-local`, `untrusted`.
- `security-protocol.md` §Security Profiles and Containment defines the permitted
  scope, required containment, and release of each.
- `specification.md` §Security Boundary confirms: "Three profiles exist:
  `read-only-review`, `monitored-trusted-local`, and `unattended-untrusted`;
  Release 0 permits only `read-only-review`. A permission prompt is not a sandbox
  boundary."

---

## Decision

**Security profiles and fail-closed containment are mandatory for any operation
above the Release 0 read-only floor.** A permission prompt expresses consent; it
never substitutes for isolation. A run that requires containment it cannot obtain
returns a typed blocking result and performs no side effect. This posture is
frozen; no implementation worker may weaken it or substitute an unsandboxed
fallback.

The frozen source constraints that make this binding:

1. **Profiles are a first-class, schema-validated contract.** Every profile is a
   `policy-profile.schema.json` instance with `profileId`, `trustMode`,
   `defaults` (read/write/shell/network/delegate ∈ allow/ask/deny), and
   `requiredControls` (`isolation`, `redactionFailure`, `networkBrokerFailure`).
2. **The schema hard-wires the two extremes.** For `read-only-review` the schema
   forces `trustMode = read-only` and `write = shell = network = delegate = deny`.
   For `unattended-untrusted` the schema forces
   `requiredControls.isolation = required-fail-closed`.
3. **Redaction and network-broker failure are non-negotiable denies.** The schema
   fixes `requiredControls.redactionFailure = "deny"` and
   `networkBrokerFailure = "deny"` as constants for every profile.
4. **Hard denies cannot be overridden.** `security-protocol.md` §Policy Controls:
   "Hard denies cannot be overridden by a model message or a project file loaded
   as untrusted content." `harness-policy-decision.schema.json` enforces
   `override = false` (const) and, when `hardDeny = true`, `decision = "deny"`.

### Profile / isolation matrix

Columns map to `policy-profile.schema.json`. Profile names are taken verbatim
from the schema `profileId` enum and `security-protocol.md`; no weaker profile is
introduced.

| Profile (`profileId` / `trustMode`) | Allowed operations (`defaults`) | Required containment / isolation boundary (`requiredControls.isolation`) | Approval requirement | Fail-closed behavior when containment absent |
|---|---|---|---|---|
| `read-only-review` / `read-only` | Registered read-only tools only. Schema forces `write=deny`, `shell=deny`, `network=deny`, `delegate=deny`; `read=allow\|ask`. No mutation, credential, child-agent, or extension capability. | `isolation = not-required` (no mutation surface exists to contain). | None for reads within the worktree; any write/shell/network/delegate is a hard `deny`, not an `ask`. | Not applicable — there is no higher-risk path to fall back from. A write/shell/network request under this profile returns `policy_denied`. |
| `monitored-trusted-local` / `trusted-local` | Explicitly approved local mutation (`write`/`shell` resolve to `ask` by default, per `security-protocol.md` §Safe Defaults). | User-visible approval **plus** path/argv/environment/process controls (canonicalized paths, argv arrays, env allowlist, process-group termination). Explicitly **"not a sandbox claim."** `isolation = not-required` for interactive, attended local runs only. | Single-use approval bound to the canonical action fingerprint (`approval-request` / `approval-result`). A permission prompt is consent, never isolation. | A non-interactive `ask` fails closed with a typed approval-required result; the mutation does not execute. Redaction failure on the mutation path → `deny`. |
| `unattended-untrusted` / `untrusted` | No mutation by default. Any mutation requires the isolation boundary below to be present and verified first. | Real OS/container/remote isolation with explicit mount, UID, process-group, network, and credential boundaries. Schema forces `isolation = required-fail-closed`. | Approval alone is insufficient; isolation is a precondition of the operation, checked before approval can authorize it. | **If required isolation is unavailable → typed BLOCK (e.g. `environment_blocked` / `policy_denied`), never a silent or unsandboxed fallback.** This is the core fail-closed case (see below). |

Traceability of the matrix rows:

- **`policy-profile.schema.json`** — every row is a valid profile instance; the
  `read-only-review` and `unattended-untrusted` rows are additionally pinned by
  the schema's `allOf` conditionals.
- **S-04** (implementation-plan.md §W1 D-03 traceability id; `specification.md`
  §Security Boundary and acceptance scenarios `@SC_R05_HARD_DENY`,
  `@SC_R04_READ_ONLY_TOOL`) — hard-deny precedence and "a permission prompt is
  not a sandbox boundary" govern the Approval and Fail-closed columns.
- **R1-01** (Release 1 guarded-mutation/resume scenario cited by
  implementation-plan.md rows P-02, RS-01, M-01; PRD §Success Criteria Release 1)
  — "A guarded mutation is path-checked, scan-state-aware, approval-bound, and
  evidence-recorded; unattended/untrusted mutation fails closed without the
  required isolation boundary." This is the `monitored-trusted-local` and
  `unattended-untrusted` rows.
- **M-02** (implementation-plan.md §W10) — "Add monitored trusted-local mutation
  and execution receipt/reconciliation; keep unattended untrusted blocked without
  isolation." This binds the two mutation rows to their implementing task.

### Fail-closed decision (explicit and unambiguous)

**Absent required containment or isolation, a higher-risk operation is blocked
with a typed result and produces no side effect. The harness never silently
allows, downgrades, or falls back to an unsandboxed mutation.** This holds
regardless of model text, untrusted project content, or session hints.

Concretely:

1. **Missing isolation for `unattended-untrusted` mutation.** When a profile
   requires isolation (`requiredControls.isolation = required-fail-closed`) and
   the OS/container/remote boundary is unavailable or unverifiable, the run
   returns a typed blocking result — `environment_blocked` at startup/precondition
   time (`specification.md` §Error and Recovery Contracts:
   "`environment_blocked` — missing command/dependency/permission") or a
   `harness-policy-decision` with `decision = "deny"` at call time. It does not
   execute the mutation unsandboxed. Source: `security-protocol.md` §Security
   Profiles and Containment — "A run that requires unavailable containment returns
   a typed blocking result rather than falling back to an unsandboxed mutation."

2. **Headless / unattended `ask`.** A non-interactive `ask` always fails closed.
   `security-protocol.md` §Safe Defaults: "non-interactive `ask`: fail closed with
   a typed approval-required result." Acceptance `@SC_R05_HEADLESS_ASK`: "Keryx
   returns approval-required or denied … it does not auto-approve or execute the
   call." ADR-0001 signed row "Policy: Fail-closed for blocked actions" confirms
   the same for Release 0.

3. **Stale approval.** An approval is single-use and binds the canonical action
   fingerprint (tool id + schema hash, normalized input hash, policy/profile
   fingerprint, worktree/branch/context provenance, actor, expiry, scope). Any
   change makes a pending approval `stale`; it remains in immutable history but
   cannot be consumed, and a new approval is required before execution.
   Sources: `security-protocol.md` §Approval and Provenance Binding;
   `approval-result.schema.json` `decision` enum includes `expired`/`invalidated`
   with a required `reason`; acceptance `@SC_R05_STALE_APPROVAL`.

4. **Redaction or network-broker failure.** `policy-profile.schema.json` fixes
   `requiredControls.redactionFailure = "deny"` and
   `networkBrokerFailure = "deny"` for every profile. Scan/redaction failure is
   blocking for provider-bound, durable, external, and mutation paths
   (`specification.md` §Security Boundary). Network enforcement is the broker, not
   text detection (`security-protocol.md` §Network Broker).

5. **Hard deny is terminal.** Hard security denies always win over the last
   matching rule, model text, project content, and session hints
   (`specification.md` §Policy Decision; acceptance `@SC_R05_HARD_DENY`), and
   cannot be overridden (`override = false` const in
   `harness-policy-decision.schema.json`).

### Containment requirements per risk tier

| Risk tier (`trustMode`) | Containment obligation | Enforcing field |
|---|---|---|
| `read-only` | No mutation surface; reads confined to canonicalized worktree roots; traversal/symlink escape rejected. | `defaults` (write/shell/network/delegate = deny); `security-protocol.md` §Filesystem and Process Safety. |
| `trusted-local` | User-visible approval + path canonicalization, argv arrays (no shell interpolation), env allowlist, process-group termination, timeouts, bounded output. Explicitly **not** a sandbox. | `requiredControls.isolation = not-required`; `security-protocol.md` §Filesystem and Process Safety. |
| `untrusted` | Real OS/container/remote isolation: explicit mount, UID, process-group, network, and credential boundaries, verified present before any mutation. | `requiredControls.isolation = required-fail-closed`. |

Path canonicalization (resolve symlinks before authorization, reject escape from
approved roots), argv-over-shell, environment allowlisting, and process-group
control apply to **every** tier that permits mutation or shell, per
`security-protocol.md` §Filesystem and Process Safety.

---

## Consequences for Later Waves

**W10 — Guarded mutation and approval (M-01, M-02; Release 1).**
- M-01 implements policy profiles, canonical action fingerprints, single-use
  approvals, path/argv/env rules, and fail-closed scan state. It must realize the
  matrix and the fail-closed decision above; stale/denied/headless approvals never
  execute.
- M-02 adds `monitored-trusted-local` mutation with execution receipt and
  reconciliation and **keeps `unattended-untrusted` blocked without isolation**.
  M-02 may not enable unattended/untrusted mutation without the isolation boundary;
  doing so violates this ADR and the schema's `required-fail-closed` constant.

**W15 — Security and recovery hardening (H-01, H-02; Release 1/2+).**
- H-01 runs the security/recovery/replay/red-team hardening suites, including the
  `security-protocol.md` §Security Tests fixture family "fail-closed containment
  checks for unattended/untrusted mutation," plus approval-bypass,
  stale/single-use approval, and provenance-taint families. No unexplained
  high-severity finding may remain.
- H-02 defines deferred extension capability grants and isolation **without
  enabling them** in Release 0; the extension contract stays explicitly later
  scope and inherits the same fail-closed posture.

Network broker-mediated tools (`security-protocol.md` §Network Broker) remain
deferred past Release 0; when enabled they inherit `networkBrokerFailure = deny`.

---

## Traceability

**Normative sources** (frozen, never modified):
- [security-protocol.md](../../requirements/keryx-project-agent-harness/security-protocol.md) — §Security Objective, §Policy Controls, §Security Profiles and Containment, §Approval and Provenance Binding, §Safe Defaults, §Filesystem and Process Safety, §Network Broker, §Security Tests. **Primary source.**
- [schemas/policy-profile.schema.json](../../requirements/keryx-project-agent-harness/schemas/policy-profile.schema.json) — `profileId`/`trustMode`/`defaults`/`requiredControls`; `read-only-review` and `unattended-untrusted` conditionals.
- [schemas/harness-policy-decision.schema.json](../../requirements/keryx-project-agent-harness/schemas/harness-policy-decision.schema.json) — allow/ask/deny, `hardDeny`, `override=false`, `ask ⇒ approvalId + fingerprints`.
- [schemas/approval-request.schema.json](../../requirements/keryx-project-agent-harness/schemas/approval-request.schema.json), [schemas/approval-result.schema.json](../../requirements/keryx-project-agent-harness/schemas/approval-result.schema.json) — single-use, fingerprint-bound, `expired`/`invalidated` outcomes.
- [specification.md](../../requirements/keryx-project-agent-harness/specification.md) — §Security Boundary, §Policy Decision, §Error and Recovery Contracts (`environment_blocked`).
- [prd.md](../../requirements/keryx-project-agent-harness/prd.md) — §Decisions and Open Questions (baseline D4), §Success Criteria Release 1 (guarded mutation fails closed without isolation), R5/R15.
- [brainstorm.md](../../requirements/keryx-project-agent-harness/brainstorm.md) — §Selected Decisions D5 (Policy Is a First-Class Domain), D4 (Tool Registry Before Prompt Features).
- [implementation-plan.md](../../requirements/keryx-project-agent-harness/implementation-plan.md) — §W1 D-03 row (`S-04, R1-01, M-02`), §W10 M-01/M-02, §W15 H-01/H-02.
- [acceptance.feature](../../requirements/keryx-project-agent-harness/acceptance.feature) — `@SC_R05_HARD_DENY`, `@SC_R05_HEADLESS_ASK`, `@SC_R05_STALE_APPROVAL`, `@SC_R04_READ_ONLY_TOOL`.
- [ADR-0001](ADR-0001-d01-release0-boundary.md) — D-01 Release 0 read-only boundary that D-03 extends into Release 1+.

**Traceability id mapping** (implementation-plan.md §W1 D-03 lists `S-04, R1-01, M-02`):
- **S-04** → `specification.md` §Security Boundary + acceptance `@SC_R05_HARD_DENY`, `@SC_R04_READ_ONLY_TOOL` (hard-deny precedence; permission ≠ sandbox).
- **R1-01** → PRD §Success Criteria Release 1 (guarded mutation path-checked, approval-bound, fails closed without isolation); plan rows P-02, RS-01, M-01.
- **M-02** → implementation-plan.md §W10 (monitored trusted-local mutation; unattended untrusted kept blocked without isolation).

---

## Open Items (Explicitly Deferred — Never Guess)

| Item | Question | Deferred to | Status |
|------|----------|---|--------|
| **OPEN-1** | Concrete OS/container/remote sandbox mechanics for `unattended-untrusted` (macOS/Linux/Windows mount, UID, process-group, network, credential boundary implementation). | Release 1/2+ (W10 M-02, W15 H-01); brainstorm.md Critical Question 2 | OPEN — frozen sources require the boundary and its fail-closed behavior but defer the concrete mechanism; no worker may invent it. |
| **OPEN-2** | Network broker enforcement mechanics (scheme/port validation, DNS/redirect re-check, private/link-local/metadata denial, proxy/Unix-socket policy). | Post-Release 0 (`security-protocol.md` §Network Broker) | OPEN — network tools deferred from Release 0; broker contract inherits `networkBrokerFailure = deny`. |
| **OPEN-3** | Per-role budget/policy values beneath the global SLO ceilings (planning vs review vs build token/tool-call ceilings). | Release 1 (ADR-0001 OPEN-2) | OPEN — belongs to Task Manager evolution and provider-adapter tasks. |

No D-03 posture decision is OPEN. The security-profile set, the required
containment per tier, and the fail-closed rule are SIGNED and frozen; only the
deferred implementation mechanics above remain OPEN, exactly as the frozen
sources defer them.

---

## Acceptance Gate

This ADR satisfies acceptance criterion **AC3** from flow 003:

> D-03 — ADR-0003 freezes the security profiles and required containment as a
> profile/isolation matrix (mapped to `policy-profile.schema.json`, S-04, R1-01,
> M-02) and states an explicit fail-closed decision: absent required
> containment/isolation, higher-risk operation is blocked (typed block, never
> silent allow).

- ✓ Profile/isolation matrix with the three frozen profiles (`read-only-review`,
  `monitored-trusted-local`, `unattended-untrusted`) — names taken from
  `policy-profile.schema.json` and `security-protocol.md`, no invented posture.
- ✓ Matrix columns cover allowed operations, required containment/isolation,
  approval requirement, and fail-closed behavior when containment is absent.
- ✓ Rows mapped to `policy-profile.schema.json`, S-04, R1-01, and M-02.
- ✓ Explicit, unambiguous fail-closed decision covering missing isolation,
  headless/unattended `ask`, stale approval, redaction/broker failure, and hard
  deny — typed BLOCK, never silent allow.
- ✓ Containment requirements per risk tier; consequences for W10 and W15.
- ✓ Deferred OS sandbox and network-broker mechanics recorded as OPEN, not guessed.
- ✓ Frozen requirements package cited, never modified; decision restated, not
  re-decided.

---

**Decision made by**: Flow 003 (W1 decisions) documentation worker — dispatch 003-T7
**Date frozen**: 2026-07-12
**Approver**: Security (deferred to review workflow)
