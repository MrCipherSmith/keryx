# Plan

Task map (the scaffold rows keep their ids):

- T1 (context): probe claude live in a scratch repo for the flag or permission mode that lets Edit and Write run headless without Bash; record a sanitized fixture with the claude version. If only a broad mode exists, stop and report.
- T2 (implement): codec argv and release gate (AC1, AC2); codec-path diff capture, redaction, patch hash, guaranteed worktree cleanup (AC3); review and landing core plus `keryx agents external review|apply|discard` (AC4, AC5).
- T3 (test): tests for AC1-AC5, the TUI modal `/external-diff` and one sidebar row shown only while a diff awaits review (AC6), docs, README, CHANGELOG, version bump (AC7).
- T4 (review): PR, CI, review round with verifier, release, live smoke through the installed CLI (AC8), operator report (AC9).

## Risks and open points

Risks:
1. Headless claude may only run Edit/Write with a permission mode broader than intended (e.g. bypass). Mitigation: worktree cwd is the only writable root, roster excludes Bash; if no narrow mode exists, stop and report instead of widening.
2. The child's own tools write outside what keryx sees: containment is the throwaway worktree only (decision D-08). A prompt-injected file could still make claude write into the worktree; the diff review is the control, so the diff must be complete (include binary/mode changes, deletions, symlinks; refuse symlinks pointing outside).
3. The applied diff may carry secrets or hooks (`.git/hooks`, `.github/workflows`, `.claude/`, `.metaproject/`): flag or refuse changes to those paths by default.
4. Live runs spend subscription quota; keep one trivial task, no retry loop.

Design questions (recommendation):
- Where does an approved diff land? Recommend a new local branch `external/<run-id>` with one commit, made from the recorded base commit in a second worktree; never the current branch. Alternative (apply to the working tree) rejected: it breaks "never the main checkout".
- Is "mandatory review" the human alone or also a model review? Recommend human approval of the shown diff only for this flow; an optional `keryx review` pass on the diff is a follow-up, not a gate.
- Base commit drift: if HEAD moved during the run, still branch from the recorded base and say so; do not rebase automatically.
