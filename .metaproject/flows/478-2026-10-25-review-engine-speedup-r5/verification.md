# Verification — flow 478 (review-engine-speedup R5: G1–G4)

Acceptance by the `Verification:` fields of the package, run on `cp -a` copies of three vantage-frontend review packages
with the build from this worktree (`bun src/cli.ts review required <copy> ...`). The originals were fingerprinted (path,
size, mtime of every file, sha256 of the sorted list) before and after: unchanged (`pr7932-r1` 107 files, `22fb0c4fd574`;
`pr7914-r1` 19 files, `177cf8df20ef`; `2026-10-21-review-flow-8092` 25 files, `885570e002e9`). The "old" roster is the
saved `--json` output of the base build (`2743032ad`) on the same copy.

## Result per requirement

| Check | Result |
|---|---|
| G1 `review required`, copy of 7932 | old 25 required, new 23; new == old minus `review-clean-code` and `review-style` |
| G1 `review required`, copy of 7914 | old 23, new 21; new == old minus the two roles |
| G1 `review required`, copy of 8092 | old 23, new 21; new == old minus the two roles |
| G1 `excluded` entries (all three) | `optional role, off by default (--style turns it on)` for both roles |
| G1 with `--style` (all three) | required set equals the old roster; no `rolesOff`; `round-roles.json` written in the package |
| G2 project config | `reviewRoles.disabled` drops `review-performance` with `disabled by routing.config.json reviewRoles.disabled (--with-role review-performance turns it on)`; `review-logic` (core) stays on with a warning; unknown names (`review-nope`, `review-not-installed`) are warnings and ignored; `reviewRoles.enabled` turns `review-style` on |
| G3 `--all`, `--gating` | the two roles stay out; one warning each: `--all does not bring back review-clean-code, review-style: they are switched off; pass --style (or --with-role <role>) to run them` |
| G3 `light` | old light set `review-clean-code, review-logic, review-testing-practices`; new `review-logic, review-testing-practices` with both roles in `excluded` as optional; with `--style` the old set returns |
| G4 report line | `role-switches-complete.test.ts` (3): the line `опциональные роли не запускались: review-clean-code, review-style` lands in `report.md` once, a second `complete` leaves one line, none when both roles were asked for, and only the off role is named when one was asked for |

## Findings the text did not predict

1. **No `required.json` in Keryx.** Doc 20 speaks of `required.json`; Keryx writes no such file, it is the saved `--json`
   output of `review required`. The roster the acceptance compares is that output.
2. **Doc 20 line numbers are for the 0.3.131 `dist/cli.js` and cannot be mapped to `src`.** The symbols exist in `src`, in
   different places than the text implies:
   `scopeReviewerByStack` is `src/review/stack.ts:251` (doc: `cli.js:45308`); `LIGHT_CONVENTIONS_PREFERENCE`
   `src/review/coverage.ts:33`; `NOT_ROSTER` `coverage.ts:80`; `BUNDLED_PATH_GATES` `coverage.ts:98`;
   **`BUNDLED_OVERLAP_GROUPS` is `src/review/slice-routing.ts:158`, not `coverage.ts`** (coverage.ts only mentions it in a
   comment); **`ROLE_RULES` is `slice-routing.ts:99`** (a private table, `ROUTABLE_ROLES` derives from it); the required
   flags list is `REQUIRED_FLAGS` in `src/commands/review.ts` (doc: `cli.js:150518`). `excludeReviewers`,
   `disabledReviewers` and `skipReviewers` do not exist in `src` (doc line 13 confirmed): there was no general mechanism to
   extend, so `src/review/role-switches.ts` is new.
3. **`complete` cannot be run on the real packages.** All three are unfinished (`review complete` is refused), same as in
   R6. G4 is covered by the fixture test in `role-switches-complete.test.ts`, which builds a completable package.
4. **The opt-in is sticky.** `--style` is recorded per package in `round-roles.json`, like `round-depth.json`: a later
   `review required` without the flag on the same package still includes the roles. Without that, the round would
   change its roster halfway.
5. **`routing.config.json` in scope A.** If the diff itself changes `routing.config.json`, `reviewRoles.disabled` from it
   is ignored with a warning, so a change cannot switch off its own reviewers.
6. **`light` fallback.** The conventions fallback walks `LIGHT_CONVENTIONS_PREFERENCE` against the roster, so a disabled
   `review-clean-code` is skipped there (g3 light run above).
7. **Bundled skill mirror.** The `review-orchestrator` flag table was edited; the bundled copy and the installed mirror under
   `.metaproject/skills/gdskills/` are byte-identical (a test enforces it, and caught the first edit).

8. **AC1–AC4 were not parsed at the first freeze.** They were written `- AC1 (G1): …`; the flow parser accepts only
   `- ACn: …`, so the freeze counted AC5–AC12 and `ac confirm AC1` said "Unknown criterion". The G tag moved after the colon
   (`- AC1: (G1) …`), wording unchanged, and `keryx flow ac update` re-froze the file (the journal carries the reason).

## Requirements and how they were accepted

| Requirement | Evidence |
|---|---|
| G1 default off, flag restores | three copies (above); `role-switches.test.ts` (20); `review-required-package.test.ts` R5 tests |
| G2 general mechanism | g2 run above; `role-switches.test.ts` (config tolerance, unknown names, core protection, always-on list) |
| G3 `--all`/`--gating`/`light` | g3 runs; `coverage.test.ts`; `review-required-package.test.ts` ("does not bring back") |
| G4 report line | `role-switches-complete.test.ts` (3) |
| `--style`, `--with-role` only on `start`/`required` | `review-required-package.test.ts` (`attach`/`ingest` refuse with "belong to `keryx review start`"); `review-slice-paths.test.ts` ties the flag lists |
| Panel | `review-panel.test.ts` "names the optional roles that are off, and stops once the package asked for them" |
| Docs | `docs/docs/cli-reference.md`, `docs/docs/guides/review-with-a-record.md`, help text of `review start` and `review required`, `CHANGELOG.md` `[Unreleased]`, `review-orchestrator` flag table |
| Not changed | `review-pr-contract`, the two roles' skills, `light`, the packages (no diff) |

Tests: `bun test src/review/role-switches.test.ts src/review/role-switches-complete.test.ts`,
`bun test src/review/coverage.test.ts src/commands/review-required-package.test.ts`,
`bun test src/commands/review-slice-paths.test.ts src/commands/review.test.ts`,
`bun test src/tui/review-panel.test.ts src/tui/review-inspector.test.ts` green; the broad `src/review src/tui src/commands/review`
run fails only on environment cases that fail the same way off main (two `src/tui/ci-triage-source.test.ts` "not opted in"
cases, `resolveProjectRoot`, R2-01 hostile cwd ×2, F-055); `bun run typecheck` clean.

## TUI

The review panel row carries a `rolesOff` field and prints a `roles off:` line while the package has not asked for the
roles; it disappears once `round-roles.json` exists.

## Not measured

Token and time saving of dropping the two roles. Only the roster change is measured; no live round was run on this build.

## Could not be checked

- `review complete` on a real closed package: the three vantage-frontend packages are unfinished; only the fixture covers it.
- A live round with `--style` through `review start` after this build.
