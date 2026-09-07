# T37 spec — stop an unusable manifest or config from silently removing the security posture

Root: `/Users/Goodea/goodea/keryx` (branch `codex/agent-first-core`). Ownership for
this task: `src/security/guard.ts` + `src/security/guard.test.ts`,
`src/security/config.ts`, and only the `runGate`/`runReport`/`readLatestReport`
region of `src/security/service.ts`, plus additive shapes in
`src/security/types.ts`. `src/flow/service.ts` is read-only.

Source: T35 review (`T35-review.md`), findings F-001 (blocker), F-003 (residual,
major), F-004 (minor). Probes read and run, not edited:
`T35-probe-residual.ts`, `T35-probe-flowfold.ts`.

## Defect 1 (F-001, blocker) — `isSecurityEnabled` manifest dereference

`guard.ts:104-107` reads `.metaproject/metaproject.json` via `readJsonFileOr`
and dereferences `manifest.modules?.security?.enabled` without checking that
`manifest` (or `manifest.modules`) is actually an object. A manifest whose
content is the four bytes `null` parses to JS `null`, and `null.modules`
throws. `securityFlowGate` awaits this outside its own `try`, so it throws too
(contradicting its documented "Never throws"), `src/flow/service.ts:663-669`
catches that and records the security gate as `skipped`, and `:672`
(`gates.every((gate) => gate.status !== "fail")`) treats `skipped` as
non-blocking — completion passes with the gate gone.

**Design decision — not the literal reviewer snippet.** The review's own
suggested-fix code returns `false` (module disabled) for a non-object
manifest. That stops the crash but is still a disappearance: a corrupted
manifest and "module never configured" become indistinguishable, and both
resolve to "nothing to check" — exactly the AC8 shape this phase closes. The
T37 dispatch is explicit that the corrected outcome must be **blocking
posture-unavailable**, not a re-labelled disable. So this task treats "no
manifest file at all" (`pathExists` false) and "manifest file present but
unreadable as an object" as two different outcomes:

- absent → `enabled: false`, no flag. Unchanged from today; a project that
  never configured `.metaproject/metaproject.json` has nothing to fail closed
  about.
- present but not a non-null, non-array object (or its `.modules` block is not
  one) → the workspace's posture cannot be established at all. `guardOutput`
  and `securityFlowGate` must treat this exactly like their existing
  mode-load-failure branches: `allowed: false` / `status: "fail"` with the
  existing constant `POSTURE_UNAVAILABLE_REASON`, never a throw.

Implementation: replace the direct dereference in `isSecurityEnabled` with a
private `resolveManifestSecurityState(cwd)` returning
`{ enabled: boolean; manifestUnreadable: boolean }`. `isSecurityEnabled` keeps
its existing public signature (`Promise<boolean>`) and callers outside this
module are unaffected. `guardOutput` and `securityFlowGate` call the richer
helper directly so they can branch on `manifestUnreadable` before ever reading
config/mode.

**Class scope (9 unguarded `readJsonFileOr` + `manifest.modules` sites named by
the reviewer).** Only `guard.ts:104` is inside this task's file ownership and
only it converts the crash into a non-blocking outcome (the flow gate). The
other eight (`src/testing/capability.ts:26`, `src/capability/seam.ts:70`,
`src/mcp/discovery.ts:123`, `src/gdskills/project-skills.ts:664,681`,
`src/gdskills/export.ts:199`, `src/gdskills/export-plugin.ts:189`,
`src/commands/ctx.ts:131`) are read to confirm the review's classification —
each crashes its own caller on a `null` manifest (fail-closed, not the
AC8 open-failure this task targets) — and are left unmodified: they are
outside the ownership list this dispatch grants (`guard.ts`, `config.ts`,
`service.ts`'s named region, `types.ts`), and the dispatch's own escape valve
("If you believe another file must change, stop and reply STATUS: BLOCKED")
is for changes this task's acceptance criteria require, not for a wider
consistency sweep across an unrelated set of modules. Recorded as deliberately
left.

## Defect 2 (F-003, major residual) — `loadSecurityConfig` non-object payload

`config.ts:200-207`. T33 already stopped a non-object
`security.config.json` from throwing, but the fallback is
`mergeSecurityConfig({})`, whose `mode` is `advisory` — so a destroyed config
silently downgrades an `enforced`/`ci` workspace to report-only. The T33
report's stated mitigation ("§14 self-protection catches it as a mode
downgrade in any workspace that has run before") does not hold: measured by
`T35-probe-residual.ts` D1, a workspace with `state.json` recording a prior
`mode: "ci"` produces a byte-identical outcome to a fresh workspace —
`evaluateSelfProtection` emits a warning + incident but never a `finding`, and
`guardOutput` discards warnings.

Fix (the reviewer's named minimal change, adopted as specified): distinguish
*absent* config (`pathExists` false — keep today's defaults/advisory
behaviour exactly) from *present but unusable* (parses to something
`isMergeableConfigPayload` rejects, **or does not parse at all** — the
malformed-JSON fallback moves with it, per the reviewer's note that splitting
the two leaves the cheaper corruption open). The present-but-unusable case
returns the defaults with `mode` forced to `"enforced"` and an additive
`configUnreadable: true` on `SecurityConfig` (types.ts, additive).
`guardOutput` and `securityFlowGate`'s existing mode-load `try` blocks check
`config.configUnreadable` and return through their existing
posture-unavailable branches (same `POSTURE_UNAVAILABLE_REASON` constant,
same `INCOMPLETE_DECISION` / `status: "fail"` shapes) — no new reason string,
no new leak surface.

Distinguishing "does not parse" from "parses to `{}`" needs a sentinel other
than `readJsonFileOr`'s generic fallback value, because `readJsonFileOr`
already collapses a parse failure to whatever fallback is passed. A
module-local `Symbol` fallback lets `loadSecurityConfig` tell "the file did
not parse" apart from "the file legitimately is `{}`" (a normal minimal
config, must still take the advisory-default path, not the unreadable path).

## Defect 3 (F-004, minor) — coverage-consistency fold not shared, not exhaustive

`service.ts` `runGate`'s `pass` arm folds `latest.report.coverage?.status ===
"incomplete"` — a literal-equality check that misses `coverage.status:
"partial"`, a bare-string `coverage` value, or any other non-`"complete"`
shape, and is not applied by `runReport` at all (which returns the stored
`pass` report verbatim), so the two surfaces disagree about the same
artifact.

Fix: extract a shared, exhaustive predicate
`hasIncompleteCoverage(coverage: unknown): boolean` —
`undefined`/`null` (no coverage claim at all) is not incomplete (preserves
T33 D2b: a normal single-content scan that never sets `coverage` still reads
`pass`); any other value that is not a plain object, or is an object whose
`status` is not exactly `"complete"`, is incomplete. `runGate`'s `pass` arm
uses it; `runReport` applies the same fold to the `pass` case (overriding the
returned `gate` to `"incomplete"` when the artifact is self-contradictory),
mirroring the fold `runScanPath` already applies at write time.

## Stale statements

- `guard.ts` header ("advisory mode ONLY reports — it never blocks"): amend to
  say advisory never blocks on a *known* posture, and name the
  posture-unknown exception (in scope, `guard.ts`).
- `src/flow/service.ts`'s security/health catch arms still record `skipped`
  and interpolate raw `error.message`: **out of scope.** `src/flow/service.ts`
  is explicitly read-only in this dispatch's ownership constraints. With F-001
  fixed, `securityFlowGate` is provably total (never throws) — the exact
  property F-005 itself names as removing the last known trigger for the
  security arm — so this dispatch's acceptance criteria do not require
  touching that file. Left as a documented concern, not a code change.

## Regressions to add (guard.test.ts, `T37` prefix)

1. A manifest that parses but is not an object (`null`, and the class
   boundary `[]`/`42`/`"x"`/`true` that must stay non-throwing and
   `enabled:false`) — `isSecurityEnabled` never throws, `guardOutput` blocks
   with the posture-unavailable reason, `securityFlowGate` returns a blocking
   `fail` (not `null`). Fails before (throws / disappears), passes after.
2. A config that parses but is not an object, with a recorded prior `mode:
   "ci"` in `state.json` — `guardOutput` blocks, `securityFlowGate` blocks,
   and the reason is the constant leak-safe string (no sentinel, no path).
   Also cover the non-parsing case (`"{not json"`) taking the same path as
   `null`. Fails before (write still allowed, gate `pass`), passes after.
3. A stored report whose `coverage.status` is neither `"complete"` nor
   `"incomplete"` (e.g. `"partial"`) reads `incomplete` at both `runGate` and
   `runReport`. Fails before (`runGate` already incomplete only for the exact
   string `"incomplete"`; `runReport` always passes it through), passes after
   for both surfaces.

No committed test is weakened or deleted. `T33 D1`-`D5`, `T33 root trigger`,
and the un-prefixed advisory/enforced/ci tests must stay green unchanged.

## Verification plan

- Reviewer probes `T35-probe-residual.ts` / `T35-probe-flowfold.ts`: run
  before (already done, baseline recorded) and after. The probes assert the
  *presence* of each defect, so — matching the established project pattern
  from `T30-probe-failopen.ts` in T33 — a probe assertion that was `ok:true`
  (defect reproducing) flipping to `ok:false` (mechanically "failed") after
  the fix is the fix being confirmed, not a regression. Exact counts and raw
  log paths recorded in `T37-implementation.md`.
- `bun src/cli.ts ctx run -- bun test src/security/guard.test.ts
  src/security/persistence-sinks.test.ts src/security/service.memo.test.ts
  src/commands/security-recursive-scan.test.ts` before/after.
- New regressions RED (before) / GREEN (after).
- `bun run typecheck` and `bunx eslint` on every changed file.
