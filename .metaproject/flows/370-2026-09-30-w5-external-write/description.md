# P1 W5 external agent write mode, claude only

Status: ready
Source: operator answers 1A 2A 3A (operator chat channel 173430, 2026-09-30); follow-up to flow 366

## Problem

keryx can drive claude read-only. `--write` exists in the CLI but is refused for claude, and even where implemented (ACP) the patch is saved and never reviewed or landed, so write mode is unusable end to end.

## Expected Outcome

`keryx agents external run claude-cli --task "..." --write` runs claude inside a throwaway git worktree with a write-capable roster (Read Grep Glob Edit Write, no shell, no network, no MCP), captures the resulting diff, shows it (CLI and a TUI review modal), and lands it only after an explicit human approval, as a new local branch commit. The checked-out branch and the main working tree are never modified by the run.

## Outcome criteria

- A real live run on claude 2.1.x edits a file in the worktree, returns a parsed result and a non-empty redacted patch; the main checkout stays byte-identical (git status clean, HEAD unchanged).
- Denying the diff leaves nothing behind (worktree removed, no branch); approving creates branch `external/<run-id>` with one commit.
- codex-cli and antigravity-cli still refuse `--write` with a reason naming this release.

## Out of Scope

codex and agy write mode; any auto-approve or `--yes` flag; applying onto the current branch or main checkout; Bash/network tools for the child; reading any vendor credential store; Gemini; pushing or opening PRs from a landed branch.


## Decisions taken by the operator

- Landing: a new local branch `external/<run-id>` with one commit, made from the recorded base commit. Never the current branch and never the main checkout.
- Mandatory review is the human alone, on the shown diff. A model review pass is a later, optional follow-up, not a gate.
- If claude offers no narrow permission that lets Edit and Write run headless without Bash (only a broad mode such as bypass), stop and report to the operator. Do not widen the permission.

