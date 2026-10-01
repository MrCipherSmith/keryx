# P0 W1 external agents live

Status: draft
Source: operator answer "A" (helyx 172181), competitive review P0 item 1

## Problem

keryx can drive Claude Code, Codex and Antigravity as child processes (`keryx agents external run`), but every codec was written against documentation and recorded fixtures, never against a real vendor process. The docs say so (`docs/verification/keryx-shell-tui-test-catalog.md` DELEG-05, `harness.md`). This is the one feature no competitor has, and it is unproven.

## Expected Outcome

For each installed vendor CLI (claude 2.1.280, codex 0.159.0, agy 1.2.12) a real, read-only `keryx agents external run` finishes with a parsed result. Where the real output disagreed with a codec, the codec is fixed. One sanitized transcript per vendor is recorded as a fixture with the binary version, replayed in CI; a live test exists but only runs when an environment variable is set. The "never tested against a real vendor" statements are replaced by versions and dates.

## Outcome criteria

- Three real runs (claude, codex, agy) each return a non-empty parsed answer through `keryx agents external run --json`, and the recorded transcripts replay in CI.
- Gemini CLI is not installed on this machine: it stays reported as unverified, not as tested.

## Out of Scope

- Write mode in a worktree with mandatory review (a separate flow after this one).
- Installing Gemini CLI, and any Gemini/Antigravity OAuth login inside keryx; keryx never reads a vendor credential store (`~/.gemini/antigravity-cli/` included).
- New TUI features: this flow changes no surface, so no TUI work is added.
