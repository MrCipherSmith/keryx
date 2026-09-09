# T68 spec — three residuals left by T61/T65 (T62 F-002, F-003, F-004)

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`). Written
before coding, per `tdd-workflow.mdc`.

Ownership for this task: `src/security/self-protect.ts`, `src/security/service.ts`,
`src/security/security.test.ts`, `src/security/templates.ts` and its tests, and
the gateway lines in `docs/docs/cli-reference.md`. Not touching
`src/security/guard.ts`, `src/security/config.ts`, `src/security/types.ts`,
`src/commands/security.ts`, `src/security/detect/*`, or any other doc site
F-004 named outside `templates.ts`/`cli-reference.md` (out of ownership,
disclosed rather than fixed).

## Reproduction, verified before any edit

- `bun .metaproject/flows/.../artifacts/T62-state.ts` (baseline log
  `T68-T62-state-before.log`): row `B1 broken mode + REAL policy disable in
  the same file` shows `trueDisableSuppressedDuringWindow: true` — F-003
  reproduces exactly as described.
- `bun .metaproject/flows/.../artifacts/T62-mode.ts` (baseline log
  `T68-T62-mode-before.log`): `M3 rank` shows
  `{"from":"gateway","to":"ci","downgradeDetected":true}` and
  `{"from":"gateway","to":"enforced","downgradeDetected":true}`, while `M1`/`M2`
  in the same run show `gateway`, `ci`, `enforced` are behaviourally identical
  at all four command surfaces and both module seams — F-002 reproduces
  exactly as described.
- `docs/docs/cli-reference.md:2096` reads "gateway mode (Phase 4) are not
  implemented" — read directly, false since T61/T65: gateway blocks the write
  seam, fails the flow gate, and exits non-zero at scan/report/check-input/
  check-output. `src/security/templates.ts:62-64` and `:124` enumerate only
  `enforced`/`ci` as blocking, omitting `gateway` — read directly, same
  defect, and this text is written into user projects by `keryx init`/`update`.

All three residuals reproduce as described. Proceeding to fix all three.

## Fix 1 — F-002: `MODE_RANK`

`self-protect.ts`'s `MODE_RANK` currently gives `gateway: 3`, `enforced: 2`,
`ci: 2`, `advisory: 1`. Every behavioural site (`isBlockingMode` in
`guard.ts`, `exitCodeFor`/`reportExitCode` in `commands/security.ts`,
`guardOutput`/`securityFlowGate`'s module seams) now treats `gateway` as
identical to `enforced`/`ci` (T61, T65). The rank table alone still asserts
`gateway` is stricter, so `gateway → enforced`/`gateway → ci` writes a
durable `mode-downgrade` incident + warning ("enforcement weakened") for a
transition that changes nothing observable.

**Decision: rank `gateway` at 2, tied with `enforced`/`ci`.** This expresses
what the rank table should mean now that behaviour has converged: three modes
block identically and rank equally; `advisory` alone is weaker, at 1. A
transition between any two of `{gateway, enforced, ci}` is same-rank (silent,
correctly — nothing was weakened). A transition from any of the three down to
`advisory` remains `MODE_RANK[to] < MODE_RANK[from]` (2 < 1 is false the other
way, 1 < 2 is true this way) — still detected, satisfying "a genuine weakening
must still be detected, including from every mode to the advisory one." Not
deleting the rank: it still separates the two behavioural classes the code
actually has (blocking-tied vs `advisory`).

**Test correction required, justified**: `security.test.ts`'s `"T58 D2"` pins
`gateway → ci` as a detected downgrade — a claim the code no longer makes once
`gateway`/`ci` are tied. Per the constraint ("a corrected expectation must be
justified in writing", the precedent T61 already set for `guard.test.ts`'s
`gateway: blocks:false` row), `T58 D2` is corrected to reconfigure to
`advisory` instead of `ci` — a transition that remains a genuine downgrade
under the corrected ranks, preserving the test's actual intent (a real
weakening across a broken-config window is still detected). `T61 D1`'s
docstring and inline comments, which describe `gateway` as "the strictest
rank" / "the only mode a forced enforced ranks below", are corrected to state
the post-T68 fact (no real mode now outranks the forced `enforced` fallback,
so the mode-arm guard is defensive rather than actively load-bearing for any
currently reachable rank pair) — its assertions are unchanged and remain true
independent of rank.

**Known, disclosed side-effect of running the reviewer's own probe again**:
`T62-mode.ts`'s `M3` section is a bare observational dump (no hardcoded
expectation, no verdict field) — its `gateway → ci` / `gateway → enforced`
rows will report `downgradeDetected: false` after this fix, down from `true`
before. This is the intended, correct consequence of the fix, not a
regression; T62-mode.ts is a reviewer artifact I do not own and will not
edit.

## Fix 2 — F-003: the disabled-policy guard

`evaluateSelfProtection`'s disabled-policy loop currently shares the mode
arm's `!config.configUnreadable` guard (added by T61, extending T58's
reasoning). That reasoning holds for the UNUSABLE-PAYLOAD shape
(`loadSecurityConfig` returns `{...mergeSecurityConfig({}), mode:"enforced",
configUnreadable:true}` — `policies` are the built-in defaults, every policy
`enabled: true` per `DEFAULT_SECURITY_CONFIG`, `config.ts:22-28`) but not for
the UNRECOGNIZED-MODE shape (`{...merged, mode:"enforced",
configUnreadable:true}` where `merged = mergeSecurityConfig(parsed)` carries
the operator's REAL, parsed policies, `config.ts:257-267`). For the second
shape, a policy the operator genuinely disabled in that very file produces no
warning and no incident while the mode typo is unrepaired.

**Decision: drop the `!config.configUnreadable` guard on the disabled-policy
loop only, keep `if (previous)`.** This is provably safe for the shape it
must stay silent for: `DEFAULT_SECURITY_CONFIG.policies` has `enabled: true`
for all five policies, so a derived (unusable-payload) config's policies are
`enabled: true` for all five by construction — the loop's own condition
(`previous.policies[name] === true && enabled === false`) can never be
satisfied for that shape, guarded or not (matches the reviewer's own measured
B3: "the guard is a no-op for this shape"). Removing the guard therefore
changes nothing for the unusable-payload shape and correctly restores
detection for the unrecognized-mode shape, where `enabled` really can be
`false` because it came from the operator's own bytes. No second flag or
default-comparison is needed because the derived shape is unconditionally
all-`true`, not merely usually so — recorded here explicitly so a future
reader does not need to re-derive it.

**Comment correction**: the existing comment ("a forced/derived config's
policies... are not an operator's choice either") is false for the
unrecognized-mode shape, per the reviewer. Replace it with the shape-specific
argument above.

**New regressions**: `security.test.ts` gets a `T68` block mirroring the
probe's B0/B1/B2/B3 rows — B0 control (readable config, real disable, still
detected), B1 (broken mode + real disable in the same file → now detected
during the window, not only after repair), B2 (never repaired → still
detected on every run once the mode is broken, since the guard no longer
applies), B3 (unusable payload after a real disable → still silent, the
guard's removal changes nothing here, pinned so a future re-add of the guard
cannot silently un-fix B1 without breaking a test).

## Fix 3 — F-004: stale prose

- `docs/docs/cli-reference.md:2096`: "Model/API backends and gateway mode
  (Phase 4) are not implemented." → gateway's blocking behaviour (write seam,
  flow gate, all four command exit codes) is implemented since T61/T65; only
  its Phase-4 proxy/backend behaviour is not. Rewrite to say exactly that.
- `src/security/templates.ts:62-64` (the pre-push hook's manifest prose) and
  `:124` (the core README's `check()` prose): both enumerate only
  `enforced`/`ci` as blocking. Add `gateway` to both enumerations. This text
  is rendered into `<project>/.metaproject/modules/security.md` and
  `<project>/.metaproject/core/README.md` by `keryx init`/`update`
  (`renderSecurityManifest`/`renderSecurityCoreReadme`), i.e. it ships into
  every user project using this module.

**Migration note for existing projects**: `update` (not `init`) is what
refreshes `security.md`/the core README in an already-scaffolded project
(per `renderSecurityManifest`'s own "Lifecycle" section: "`update` refreshes
service files (this manifest, core README...) without touching
`data/security`"). An existing project's on-disk copy of these two files
still reads the old, incomplete `enforced`/`ci` enumeration until that
project's owner runs `keryx update`; nothing else migrates or needs to
migrate — no schema, config, or state shape changes, only the prose two
generator functions return. Not making `update` mandatory or automatic here;
that decision belongs to each project's owner, same as any other
manifest-text refresh.

Out of ownership, disclosed not fixed: `.metaproject/modules/security.md:48`,
`docs/docs/architecture.md:547,563`, `docs/docs/modules.md:865,874,881`,
`docs/docs/workspace-and-lifecycle.md:339,350`, and
`docs/docs/cli-reference.md:330,754,912,993,1058` (other cli-reference.md
sites beyond :2096), and `src/commands/init.ts:497`'s interactive prompt
string ("...enforced/ci mode only)?") all carry the same stale
`enforced`/`ci`-only framing per F-004's own enumeration, but none of those
files are in this task's ownership list.

## Verification plan

1. Reviewer probes `T62-state.ts`, `T62-mode.ts`: run before (done, this doc)
   and after; report the one expected M3 delta and the B1/B2 delta.
2. `bun src/cli.ts ctx run -- bun test src/security/ src/commands/` before and
   after — must stay green (constraint), counts recorded.
3. New/corrected regressions in `security.test.ts` (RED via temporary revert,
   then GREEN).
4. `bun run typecheck` and `bunx eslint` on every changed file.
5. `T68-implementation.md`, `T68-result.json` (schema-validated), routing
   audit line.
