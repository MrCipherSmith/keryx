# W5b codex external write mode

Status: formalized
Source: operator decision 2026-09-30 (option A, operator chat channel 174204) after the live codex probe of the same day

## Problem

`keryx agents external run codex-cli --write` is refused ("write mode is claude-only in this release"). Flow 370 shipped write mode for claude only because claude has a tool allow-list (no shell, no network, no MCP). codex has none: it edits through its own tools and a sandboxed shell. The operator wants codex write mode once its confinement is measured, not assumed.

Measured live on 2026-09-30 (codex 0.159.0, `codex exec -s workspace-write --ignore-user-config`, scratch repo):

- default `workspace-write` is NOT confined to the working directory: `/tmp` (hence any sibling below it) is writable;
- with `-c sandbox_workspace_write.exclude_slash_tmp=true -c sandbox_workspace_write.exclude_tmpdir_env_var=true` a write to `/tmp`, `/var/tmp`, `$HOME` and a sibling directory fails with "read-only file system"; only the working directory is writable;
- network is closed (DNS fails); `.git` is read-only (no commit, no hook write);
- the shell can still READ anything the user can read (keys in `$HOME`); it cannot send it out, but the content can reach the run's output.

agy stays refused: its file-edit tool writes outside the working directory (measured the same day).

## Expected Outcome

- `run codex-cli --write` produces a redacted, never-applied patch reviewed and landed exactly like a claude write run (same record, same review, same human-typed hash, same `external/<run-id>` branch, same flagged-path gate).
- The codex write argv always carries the two `/tmp` exclusion flags and closed network; a codex CLI older than the verified version refuses the run instead of guessing.
- The remaining difference from claude (codex has a shell and can read user-readable files) is written down where an operator looks before running: the write guide, the CLI help for `--write`, README limitations row.
- agy, and any future line-stream agent, is still refused with a named reason.

## Outcome criteria

- After release, one real `codex-cli --write` run through the installed CLI yields a diff for review, and denial leaves the main checkout untouched; recorded with the codex version.

## Out of Scope

- agy and Gemini write mode (agy confinement failed the probe; Gemini closed as "not doing").
- Blocking runs whose worktree holds secret-looking files (option B, not chosen).
- Any change to landing, review or approval semantics; auto-approve; pushing or PRs from the landed branch.
- Reading or touching codex credential stores.
