# Keryx Shared Agent Context — Implementation Plan
Version: 1.7.5

## Delivery status

As of 2026-08-13, Phases 0–5 and Phase 6a are implemented and merged into
`main`, released in `v0.2.32`. Phase 6 is split into **6a** — the runtime
enforcement guard (`resolvePolicySelection`), implemented and verified
(AC1–AC6, full SAC suite 88/88 green) — and **6b** — the real operator-data
readiness process, now partially implemented: a read-only readiness check
(`keryx workspace policy-readiness`) and an operator playbook exist, while
runtime re-ingestion of raw receipts/outcomes remains. All acceptance and review
work for phases 0–5 and 6a is complete; the temporary per-phase merge branches
have been deleted now that everything is on `main`.

| Phase | Status | Evidence |
| --- | --- | --- |
| 0 — Contract alignment | Implemented | Merged via PR #265; Flow completion commit `9b22203a` |
| 1 — Offline workspace registry | Implemented | Flow review commit `75e68cd6`; on `main` |
| 2 — FWK read path | Implemented | Merged via PR #269; on `main` |
| 3 — Proposal and review lifecycle | Implemented | Merged via PR #271; Flow completion commit `17cca58f` |
| 4 — Collaboration ergonomics | Implemented | Merged via PR #272; Flow completion commit `09769ef` |
| 5 — Opt-in policy experiment | Implemented | Merged via PR #273; Flow completion commit `883581a`; [phase-5 policy experiment report](phase-5-policy-experiment-report.md) |
| 6 — Opt-in readiness (6a runtime guard / 6b real-data readiness) | 6a Implemented · 6b Partial | 6a: runtime guard `resolvePolicySelection` in `src/sac/fwk-service.ts`; AC1–AC6 met; full SAC suite green; merged via PR #277, released in `v0.2.32`. 6b: readiness check `diagnosePolicyReadiness` (`keryx workspace policy-readiness`) + [operator playbook](phase-6b-operator-playbook.md) implemented; runtime re-ingestion of raw receipts/outcomes remains |

## Delivery rules

Every phase is a separate future Flow with frozen acceptance criteria, schema
fixtures, security review and health verification. No phase may claim runtime
delivery before its tests and target-module owners accept the contracts. UI,
remote sync and learned policy cannot bypass earlier exit gates.

## Phase 0 — Contract alignment — Implemented

- Confirm ownership boundaries with Context Operations, Flow, Harness, Wiki,
  Memory, MCP and Security maintainers.
- Adopt normative schemas, positive/negative fixtures, compatibility policy and
  typed-reference resolver contract.
- Define the server-created `ActorContext`, trusted local identity/role source,
  role-revision lookup and v1 MCP local-stdio trust boundary. Client-supplied
  actor IDs must be rejected as authorization inputs.
- Define the strict production egress/write guard used by SAC. Existing
  advisory/disabled behavior is not an eligible production guard.

**Exit:** all schemas validate; ownership matrix is accepted; no planned API
creates a parallel Flow or bypasses guarded writes; actor spoofing,
cross-workspace, revoked-role and TOCTOU test scenarios are approved.

## Phase 1 — Offline workspace registry — Implemented

- Implement future `WorkspaceService`: manifest CRUD, atomic persistence,
  activity events, typed resources and role checks.
- Add future CLI create/list/show/add-resource with no MCP mutations.
- Add fixture-based validation and disabled-floor regression tests.

**Exit:** AC-1, AC-7 (mutation portion) and AC-10 pass offline.

## Phase 2 — FWK read path — Implemented

- Implement Facts resolver, Flow-derived Work projection and accepted
  Know-how resolver through existing source facades.
- Implement overview limits, freshness/invalidation and AccessReceipt.
- Reuse the canonical Context Operations assembly/trace and correlation ID;
  record assembly/config revision, policy/config revision and selected/omitted
  item IDs rather than a second retrieval trace.
- Expose future read-only CLI/MCP adapters with normalized parity tests.

**Exit:** AC-2 through AC-6, AC-10 and AC-11 pass; no raw content appears in
receipts or derived context storage; missing mandatory context yields typed
`context_overflow` with no successful manifest, while partial results name only
omitted optional items.

**2026-08-13 addendum — live agent shell adapter.** The CLI and MCP (`sac.overview`/
`sac.read`) adapters this phase's exit already covered were both one-shot,
out-of-process readers. A running `keryx shell` agent turn had no way to reach
SAC at all — a real gap given SAC's whole point is giving an agent curated
context. Two new read-only tools, `workspace_overview`/`workspace_read`
(`src/harness/tool/builtin/workspace-context-tool.ts`, `risk: "read"`, same
shape as `read_file`/`list_dir`), wrap `createLocalFwkReadService` and are now
in both of `src/commands/shell.ts`'s tool arrays (TUI and readline surfaces).
No session↔workspace linkage exists anywhere in keryx, so the agent must pass
an explicit `workspaceId` on every call, same as the CLI/MCP adapters.
Confirmed local-only: `keryx serve`'s HTTP handler never touches this tool
array, so unlike the MCP `sac.*` tools (which explicitly refuse HTTP transport
— the local auth server derives its actor from the OS user, with no verified
per-request principal) this never needed that guard; it was already on the
same local-process trust boundary `shell_exec` operates under. Verified with 6
offline unit tests plus one live round-trip: a local model
(`rapid-mlx serve qwen3.5-9b-4bit`, since DeepSeek/Cerebras credentials were
both unusable at verification time) driven through the real `runAgentTurn`
loop actually called `workspace_overview`, got back a real signed access
receipt, and correctly reported the result. This closes the "read-path" gap
named as explicitly out of scope in the 2026-08-13 addenda under Phase 3
below.

## Phase 3 — Proposal and review lifecycle — Implemented

- Implement proposal construction from explicit session/Flow wrap-up output.
- Persist immutable `proposed` records and append-only transition events with
  idempotency, causal ordering and correlation IDs.
- Validate current reviewer authority, evidence/ACL freshness, exact security
  policy/version and target ownership before every transition; accept only after
  the owning guarded writer returns its target-write receipt.
- Test rejection, dismissal, stale, target-write failure, replay, actor
  spoofing, cross-workspace access, revoked role and TOCTOU paths.

**Exit:** AC-8 and AC-9 pass end-to-end with secret/PII/redaction fixtures.

**2026-08-13 addendum — real memory write-path composition.** The phase's exit
criteria were originally proven only against `createLocalProposalLifecycleService`,
whose owner writers all ship `unavailable` by design (fail-closed until each owning
subsystem composes a trusted implementation — SAC never edits Wiki, Memory or Skills
files itself). `createHarnessProposalLifecycleService`
(`src/sac/proposal-lifecycle.ts`) now composes a real session-based wrap-up resolver
(`src/sac/session-wrap-up.ts`) and memory's first real `GuardedOwnerWriter`
(`src/sac/memory-owner-writer.ts`), wired into `keryx workspace propose --session
<id>` / `review --decision accepted`. Verified live end-to-end (real keryx shell
session → hash-verified evidence export → accepted proposal → real file in
`.metaproject/memory/`) and with the full `src/sac/` suite green (103/103, 14
files). Wiki and skill owner writers remain `unavailable`/fail-closed — only memory
has a real composition today. The FWK read-path integration (an agent reading
workspace context live inside `keryx shell`) is a separate, larger piece of work and
was explicitly not started in this slice.

**2026-08-13 addendum 2 — real wiki write-path composition.** `wiki-update`
proposals are now real too: `src/sac/wiki-owner-writer.ts`
(`createRealWikiOwnerWriter`) lands an accepted proposal as a `Type: decision`
page under `.metaproject/wiki/decisions/`, guarded by the same `guardOutput({
target: "wiki" })` seam `keryx wiki collect` runs before publishing a generated
page. The proposal-read + evidence-hash-verification logic shared by memory and
wiki was pulled into `src/sac/proposal-evidence.ts`; `memory-owner-writer.ts` was
refactored onto it with no behavioral change. Verified live end-to-end the same
way as the memory path. **`skill` stays deliberately `unavailable`**: unlike
memory and wiki, it has no `SecurityTarget` in `src/security/types.ts` and its
write path (`createProjectSkill`, `src/gdskills/project-skills.ts`) runs no
security scan at all today — composing a real skill owner writer without first
giving it the same guard would be a real safety regression (skills are read as
agent routing instructions every turn), not a shortcut worth taking silently.
Full `src/sac/` suite green (115/115, 16 files) after this addendum.

**2026-08-13 addendum 3 — skill got its real security guard, but not a real
owner-writer yet.** `SecurityTarget` gained `"skill"` (`src/security/types.ts`,
plus the two other closed allow-lists that had to move with it:
`src/security/schemas.ts`'s finding-schema enum, `src/commands/security.ts`'s
`--target` list) and `createProjectSkill` (`src/gdskills/project-skills.ts`)
now runs `guardOutput({ target: "skill" })` on `SKILL.md`'s rendered content
before any write, exactly like memory/wiki. Verified genuinely blocking (not
just wired) with 3 new tests in the previously-nonexistent
`src/gdskills/project-skills.test.ts`: default (disabled) unaffected, a
planted secret actually refused with nothing written to disk in `enforced`
mode, the same content allowed through in `advisory` mode. This closes the
stated prerequisite from addendum 2 above. **A real skill owner-writer is
still not composed** — a second, independent blocker surfaced while
attempting it: `ProposalLifecycleService.targetWriteOrStale`
(`src/sac/proposal-lifecycle.ts:127`) requires a receipt's `targetRef` to
literally start with `./${owner}`. For memory/wiki this genuinely matches
where those owners store files (`.metaproject/memory/`,
`.metaproject/wiki/`); for `skill` it would not — real skills live under
`.metaproject/project-skills/`, not `.metaproject/skill/`. Building a skill
owner-writer today means either faking a `targetRef` that lies about the real
file location, or fixing `targetWriteOrStale`'s literal-prefix assumption
into a real per-owner prefix map first. Neither was done in this pass; the
user explicitly chose to stop at the guard fix and leave the owner-writer for
a separate future task.

**2026-08-13 addendum 4 — skill's real owner-writer, and the targetRef fix it
needed.** Fixed the blocker addendum 3 stopped at:
`targetWriteOrStale`'s literal `./${owner}` assumption is now
`ownerTargetPrefix(owner)`, a real per-owner map
(`memory→./memory`, `wiki→./wiki`, `skill→./project-skills`). Two new
regression tests in `proposal-lifecycle.test.ts` prove this enforces the
correct prefix rather than merely "always pass": a skill receipt shaped
`./skill/...` (what the OLD check would have accepted) still lands as
`stale`; one shaped `./project-skills/...` (the real location) is accepted.
`src/sac/skill-owner-writer.ts` (`createRealSkillOwnerWriter`) is skill's
real `GuardedOwnerWriter` — all three owners (memory, wiki, skill) now have
real compositions, none left `unavailable`. It reuses `createProjectSkill`
itself rather than writing `.metaproject/project-skills/` a second way;
every SAC-derived skill lands under a fixed `sac` module
(`.metaproject/project-skills/sac/<proposalId>/SKILL.md`). `keryx workspace
propose --kind <kind>` now accepts all six `ProposalKind` values (not just
`memory-entry`/`wiki-update`), since every kind routes to a real owner via
the existing `ownerFor`. Verified live end-to-end (real session →
hash-verified evidence → accepted `decision` proposal → real
`.metaproject/project-skills/sac/<id>/SKILL.md`, `metaproject.json` skill
registry and `skills/catalog.md` correctly updated, then cleanly reverted
after verification) plus 7 new unit tests including one proving the
addendum-3 security guard genuinely blocks a skill write end-to-end (planted
secret refused in `enforced` mode, nothing written). Full suite green:
typecheck clean; `src/sac`+`src/gdskills`+`src/security`+
`src/commands/security`+`src/commands/workspace` 309/309.

**2026-08-13 addendum 5 — the MCP transport now actually exposes the real SAC
write path.** Two independent, pre-existing bugs meant `sac.propose`/
`sac.review` (`src/mcp/tools.ts`) never worked over MCP, unrelated to
anything built earlier this session: (1) `sac.propose` had an empty input
schema and unconditionally returned `trusted_wrap_up_required`; `sac.review`
called the fail-closed `createLocalProposalLifecycleService` instead of the
real `createHarnessProposalLifecycleService` the CLI/keryx-shell paths use —
fixed by composing the real thing, adding the needed exports
(`createHarnessProposalLifecycleService`, `sessionEvidenceRef`,
`proposalNotePath`, `findSession`) to `src/sac/service.ts`, the one facade
`src/mcp/` is allowed to import from (`boundary.test.ts`'s M-3 guard). (2)
even with that fixed, `sac.*` tools were entirely invisible over MCP:
`buildMcpModuleEntry()`'s default `expose.modules` allowlist
(`src/mcp/client-config.ts`) never included `"sac"`. Verified with a real
`@modelcontextprotocol/sdk` `Client`/`Server` round-trip (`InMemoryTransport`,
real protocol serialization) against a real session and workspace:
`tools/list` returns all 5 `sac.*` tools, `sac.propose`/`sac.review` land a
real file over the wire. New `src/mcp/sac-tools.test.ts` (3 tests — zero
prior coverage). Also connected this repo for real
(`keryx mcp install --runtime claude`) — confirmed safe first, since
`enableMcpModule` is a surgical patch of just `modules.mcp`, unlike
`keryx modules enable <name>`'s full-reconciliation `initCommand()` path
that regressed real content earlier in this session when run from this dev
checkout. 246/246 across `src/mcp`+`src/sac`+`src/commands/security`+
`src/gdskills`, typecheck clean.

## Phase 4 — Collaboration ergonomics

- Add worktree/session references, local activity feed and owner operations.
- Add optional TUI/IDE clients only as clients of stable CLI/MCP contracts.
- Conduct user evaluation on unfamiliar-component onboarding and handoff tasks.

**Exit:** usability report and no contract divergence between clients.

## Phase 5 — Policy experiment (optional)

- Build anonymised/minimised offline corpus from AccessReceipts and independent
  task verification outcomes. Each included receipt must be immutable or
  integrity-linked, point to an independent verifier/outcome reference and name
  its policy/config revision.
- Publish a corpus manifest with provenance, selection/redaction rules,
  quarantine criteria, holdout split and adversarial cases. Self-reported
  receipt outcome alone is not training or evaluation evidence.
- Compare candidate policy against deterministic baseline in a sandbox.
- Ship only opt-in experiment with version pin, kill switch and rollback test.

**Exit:** AC-12 plus published evaluation report. Without this exit, learned
policy remains absent from runtime.

Implementation evidence is published in the
[Phase 5 policy experiment report](phase-5-policy-experiment-report.md). The
committed corpus is synthetic mechanism evidence only; default configuration
keeps the learned candidate disabled and the kill switch active.

## Phase 6 — Opt-in readiness (6a runtime guard / 6b real-data readiness)

Full detail: [phase-6-real-opt-in-readiness.md](phase-6-real-opt-in-readiness.md).

### 6a — Runtime enforcement guard — Implemented

- Runtime binding `resolvePolicySelection` in `src/sac/fwk-service.ts` switches
  from deterministic baseline to candidate policy only when explicit config pins
  and the full fixed-order integrity chain (baseline → candidate → corpus →
  evaluation report → deterministic activation) succeed.
- Fail-closed to baseline on any error/mismatch; candidate off-by-default;
  kill-switch and `rollbackPolicyExperiment` enforced; no public CLI/MCP schema
  change.
- **Exit (met):** AC1–AC6; evidence `src/sac/fwk-service.test.ts`; full SAC
  suite 88/88 green.

### 6b — Real operator-data readiness — Partially implemented

Implemented:

- Read-only readiness check `diagnosePolicyReadiness` (`src/sac/fwk-service.ts`),
  exposed as `keryx workspace policy-readiness`: validates the full integrity chain
  even while the experiment is disabled, reports each gate's pass/fail, and exits
  non-zero when not ready — so an owner can prove readiness before flipping
  `enabled: true`.
- Documented owner-run playbook with reviewable rollout/rollback criteria:
  [phase-6b-operator-playbook.md](phase-6b-operator-playbook.md).
- Default behavior unchanged: the guard is read-only and candidate stays off by
  default.

Remaining:

- Runtime re-ingestion of the raw `receipts.jsonl` hash-chain and independent
  verifier outcome artifacts at activation time (today verified at corpus-build
  time and bound transitively through the evaluation report digest).
- Real, non-synthetic artifact set beyond the committed synthetic fixtures.

## Rollback order

1. Disable SAC adapter/capability; preserve existing module behavior.
2. In production, a strict enforced guard denies uncertain or failed tool
   output, MCP resource reads, remote egress and guarded writes. It covers both
   tools and resources; redacting tool output alone is insufficient.
3. In disabled or advisory mode SAC is a non-production/readiness path: no
   proposals, remote egress or production context disclosure may be enabled.
   If the strict guard is unavailable, malformed or errors, refuse the SAC
   operation rather than falling back to the current advisory/fail-open seam.
4. Stop new proposals and reads if a security or data-integrity incident occurs.
5. Revoke affected workspace role/reference, mark derived receipts stale and
   retain only permitted audit metadata.
6. Roll back policy version; never roll back or mutate accepted target knowledge
   outside its owning module's audited correction path.

## Security delivery modes

- **Disabled:** SAC capability is off; no SAC side effect, MCP resource exposure
  or egress is permitted.
- **Advisory:** findings may be evaluated for development diagnostics only; the
  mode is explicitly non-authorizing and cannot satisfy a production gate.
- **Strict enforced:** required before production exposure; the same gate covers
  CLI, Harness, MCP tools, MCP resources and egress, records policy/config
  revision, and fails closed on unavailable or indeterminate checks.
- **Rollback:** remove the SAC capability first, preserve owner-module data,
  then revoke roles/references and retain only allowed diagnostic metadata.

## Explicit deferrals

- Transcript upload/ingestion, automatic summarisation into accepted knowledge.
- Cloud sync, global identity, multi-tenant storage and external catalog.
- SAC-authored task states or autonomous Flow completion.
- Online self-modification, weight updates and policy-controlled security gates.
