# Implementation Plan

Status: implemented

## Approach

Fix each defect where it enters, not where it shows.

- K-013: hoist the grant refresh out of `resolveTuiStartup` into
  `refreshSavedGrants` (`src/lib/oauth/login.ts`), called once by the shell command
  before it chooses a surface; failures come back as warnings for stderr.
- K-015: record, where they are applied, which env keys keryx set from its saved
  config (`noteSavedCredentialEnv` in `src/lib/shell-config.ts`, fed by
  `applySavedApiKeys` and `applyOAuthAccessToEnv`); `resolveShellEnv` withholds
  them unless `KERYX_SHELL_PASS_SAVED_KEYS=1`. The restricted-network mask
  resolution merges the saved values back so the proxy can still inject them.
- K-016: `projectRemovalTrail` renders `trail-absent` as one fixed line and makes
  the project path relative in every other verdict's prose.

## Steps

1. `refreshSavedGrants` + call before `chooseShellSurface`; drop the swallowed
   calls from `resolveTuiStartup`.
2. Saved-credential key tracking + `resolveShellEnv` + mask merge.
3. `TRAIL_ABSENT_SUMMARY` + relative paths in `projectRemovalTrail`.
4. Tests for each; changelog; typecheck, lint, terminal suite; PR.

## Risks

- An operator whose `shell_exec` scripts relied on saved keys loses them —
  mitigated by `KERYX_SHELL_PASS_SAVED_KEYS=1` and a Changed entry.
- Refreshing at start adds one network round-trip only when a grant is expiring.
