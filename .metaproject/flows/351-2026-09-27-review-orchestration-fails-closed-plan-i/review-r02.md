# Review Report — flow 347, round 2

## Verdict: APPROVE_WITH_SUGGESTIONS → fix round T17 approved by the user

Scope: fix commits b8d03da0 (T14), 05c7e40d (T15), 588aad5d (T13) over e9c0af9a. Reviewers: review-verifier (opus), review-security-code (opus, with scratch-repo reproductions); both schema-valid on first dispatch.

## Verifications of round-1 findings

- fixed (14): F-001, F-002, F-003, F-004, F-005, F-006, F-007, F-008, F-010, F-012, F-016, F-017, F-018, F-019, F-023 (F-001 re-attacked: forged gitdir to $HOME / other repo, newline injection, relative `gitdir:`, symlinked admin dir, symlinked gitdir file, `core.worktree`, symlink inside root — all refused; legitimate main/sibling/relative/locked/symlinked-parent worktrees accepted)
- partially fixed: F-009 (envelope neutralised only on tool results), F-013 (declined approval still counts as executed — accepted in journal), F-022 (comment fixed; path now wrong in bundled builds → R2-1)
- AC re-check: AC3 met, AC6 met, AC7 met

## Findings

| ID | Sev | Where | Finding |
|---|---|---|---|
| R2-1 | minor (regression from F-022) | `src/gdskills/catalog.ts` `packageRelativePath` | dist is one bundled file, so `here` is `<pkg>/dist` and the computed root is the directory above the package; installed packages report `keryx/src/...`. Reproduced with a bundled build. |
| SEC2-1 / R2-2 | minor | `agent.ts` `buildTaskNotification`, abort replay of parallel spawns | background-job output and replayed child output reach history without envelope neutralisation; task notifications carry no quarantine flag at all |
| SEC2-2 | minor | `quarantine.ts` envelope pattern | zero-width chars, soft hyphen, full-width brackets, Cyrillic `е`, U+2015, U+2212, colon all bypass the denylist |
| R2-3 | minor | `agent.ts` `withBudgetWarning` | every tool result is rewritten, so reading keryx's own sources shows a changed constant; `edit_file` on copied text would not match |
| R2-4 | info (latent) | wrap-up abort → `{}` → spawn maps to `Completed` | unreachable today (child abort only on timeout path) |
| SEC2-3 | info | `resolveSubagentCwd` | check-then-use: a component swapped for a symlink after the check is followed; needs write access to a worktree parent — residual |

## Disposition (user, 2026-09-27)

Option A for the envelope: genuine shell nudges carry a per-session nonce known to the model only through the system instruction; content cannot know it, so look-alikes and channel coverage stop mattering and tool output no longer needs rewriting. T17 = option A + R2-1 + R2-4. F-013 (declined approval) and SEC2-3 accepted as residual.
