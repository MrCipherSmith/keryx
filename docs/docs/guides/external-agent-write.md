# Let an external agent write

`claude-cli` and `codex-cli` can change files for you, but not in your checkout.
The run happens in a throwaway git worktree, its diff is stored as a pending
review, and a change reaches your repository only as a new local branch that you
approved by reading the diff and typing back part of its hash.

These are the only write paths for an external agent that keryx applies itself.
`antigravity-cli` refuses `--write` (see [below](#what-this-does-not-do)).
`gemini-acp --write` is a different mechanism whose patch keryx never applies; see
the [ACP client guide](acp-client.md).

Everything on this page needs the external agent capability to be on, as for any
[external child](../harness.md#external-children-a-vendor-cli-as-a-child-agent):
`externalAgents.enabled: true` in your user config, and the agent's CLI (`claude`
or `codex`) installed and logged in.

## Run it

```bash
keryx agents external run claude-cli --task "Add a --json flag to the status command" --write
keryx agents external run codex-cli  --task "Add a --json flag to the status command" --write
```

keryx cuts a worktree from the current commit (it needs a git checkout with at
least one commit; uncommitted changes are not in it) and starts the agent there.
The capture, review, flagged-path gate and landing below are identical for both
agents. What confines the agent while it runs is different in kind.

### `claude-cli`: a tool allow-list

`claude` runs with only the tools `Read Grep Glob Edit Write`: no shell, no
network, no MCP server. The launch flags are `--tools Read Grep Glob Edit Write
--permission-mode acceptEdits --permission-prompts none`, so an edit inside the
worktree goes through, a write outside it is denied, and any other question is
refused instead of asked.

### `codex-cli`: an operating-system sandbox

`codex` has no tool allow-list. keryx runs it with `-s workspace-write` plus
`-c sandbox_workspace_write.exclude_slash_tmp=true -c
sandbox_workspace_write.exclude_tmpdir_env_var=true -c
sandbox_workspace_write.network_access=false` and `--ignore-rules`. Measured live on
2026-09-30 with `codex` 0.159.2, in a scratch git repository (not in a worktree cut
by keryx under the system temp directory):

- Writes outside the worktree (`/tmp`, `/var/tmp`, `$HOME`, a sibling directory)
  fail with "read-only file system".
- The network looked closed: a DNS lookup failed. Other routes were not tried.
- `.git` is read-only: no commit, no hook write.

Without the two `exclude_*` flags the default `workspace-write` sandbox lets
`codex` write to `/tmp`, which is why keryx always passes them. `--ignore-rules` is
just as mandatory: without it, the exec-policy rules in your own `codex`
configuration can let shell commands run outside the sandbox (writes to `/tmp` and
`$HOME` succeeded in the test); with it they were refused.

!!! warning "codex keeps a sandboxed shell, so it can read what you can read"
    Unlike `claude`, `codex` still has a shell. Inside the sandbox it can **read**
    any file your user account can read, for example keys under `$HOME`. The
    network is closed as far as was measured, but their content can appear in the
    run's output or in the diff. Review the diff and the run output before you
    apply, and do not run a `codex` write task in a checkout or environment where
    that matters.

keryx refuses a `codex` write run before it starts unless the installed `codex` is
0.159.2 or newer but older than 0.160.0. Older, newer, pre-release and unreadable
versions are all refused, and the message names the version found and the range
required. The ceiling is there because `codex` ignores a `-c` key it does not know
without saying so: a release that renamed one of the confinement keys above would
otherwise run unconfined and look fine. A newer `codex` becomes usable when a later
keryx release has measured it. A follow-up turn of a write run re-asserts the same
flags (the resume command line is unit-tested; write runs are started from the CLI
only, so keryx does not resume one itself).

### Capture

When the run ends, however it ends (finished, timed out, crashed or interrupted
with Ctrl+C), keryx captures the worktree's changes before removing it. The diff
covers edited, new (including gitignored), deleted and mode-changed files. It is
secret-redacted, hashed (sha256 of the redacted patch) and stored as a pending
review under the session directory. Nothing reaches your checkout. If the agent
changed nothing, nothing is stored and the report says so.

The report names the run id, the patch hash, the file list, any flagged paths, and
the next command.

## Review it

```bash
keryx agents external review <run-id>
```

The review shows the run, the agent, the base commit, the patch hash, then the
flagged paths first, the file list, and the redacted patch. It changes nothing.
The run id is the session id of the run; a unique prefix works.

Flagged paths are changes under `.git`, `.github`, `.claude`, `.metaproject`,
hook directories (`.husky`, `.githooks`), CI configuration (for example
`.circleci`, `.gitlab-ci.yml`, `Jenkinsfile`, `lefthook.yml`), or files that change
what tools run or how they behave (`.mcp.json`, `.envrc`, `.gitattributes`,
`.gitmodules`, and `.vscode/tasks.json`, `settings.json` and `launch.json`), or
instructions and configuration for other agents (`CLAUDE.md`, `AGENTS.md`, `.cursor`,
`.codex`, `.gemini`). A bare entry named like one of these directories, such as a
symlink called `.claude`, is flagged too. They
are matched without regard to case, so `.Claude/settings.json` is flagged too. They
are the files that can run code later, so read them first.

The review prints the patch and every path with control characters (escape
sequences, a bare carriage return, and so on) shown as visible `\xNN` escapes, and
says so when it did that. The stored patch and its hash are not changed.

## Apply it

```bash
keryx agents external apply <run-id>
keryx agents external apply <run-id> --allow-flagged   # only when you mean it
```

`apply` needs a real terminal on both stdin and stdout. It shows the same review,
then asks you to type the first 12 hex digits of the patch hash (the digits after
`sha256:`, without that prefix). Anything else
cancels and nothing is applied. On a match keryx:

1. creates a second throwaway worktree cut from the run's recorded base commit,
2. applies the stored patch there (checked first),
3. commits it as one commit with plumbing (no hooks, no signing), and
4. publishes it as a NEW local branch `external/<run-id>`.

Your current branch, HEAD, index and working tree are only read, never changed.
A run lands at most once. Nothing is pushed and no pull request is opened; from
there it is an ordinary local branch you can diff, test, merge or delete.

There is no flag or environment variable that answers the prompt for you, and a
caller without a terminal (a script, CI, a pipe) lands nothing: `apply needs a
terminal: nobody can answer for you`. `--allow-flagged` only lifts the flagged-path
refusal; the hash prompt still applies.

### When apply refuses

| Refusal | Why |
|---|---|
| `redacted` | Redaction changed the patch, so landing it would land content the agent did not write. |
| `binary` | A binary file's content is not carried by the text patch. |
| `flagged` | The run changes flagged paths and `--allow-flagged` was not given. |
| `branch-exists` | `external/<run-id>` already exists. |
| `hash-mismatch` | The patch on disk no longer matches the hash recorded for it. (A wrong typed prefix is not a refusal: it cancels and nothing is applied.) |
| `not-pending` | The run was already landed or discarded, or was refused at capture. |
| `apply-failed` | `git apply` rejected the patch against the base commit. No branch is left behind. |

A run whose changed symlink points outside the worktree is refused at capture: no
patch is kept, and it can only be discarded.

## Discard it

```bash
keryx agents external discard <run-id>
```

Records the decision and deletes the stored patch. A landed or already discarded
run cannot be discarded.

## In the TUI

`/external-diff` opens the review modal over the pending runs. While at least one
diff awaits review, the sidebar shows one row, `External diffs: N pending`; clicking
it opens the same modal. The row is absent when nothing is pending.

| Key | Action |
|---|---|
| Up / Down | Select a run |
| `j` / `k`, PageUp / PageDown | Scroll the diff |
| `f` | Allow (or block again) flagged paths for the selected run |
| `a` | Apply: type the first 12 hex digits of the patch hash, then Enter; anything else cancels |
| `d`, then `y` | Discard the selected run |
| Esc | Close |

A run with flagged paths needs `f` before `a` will start. In the readline shell
(`--no-tui`), `/external-diff` only lists the pending runs and points at the
commands above; it never lands anything.

## What this does not do

- No write for `antigravity-cli` (`agy`). A live test showed its file-edit tool
  writes outside the working directory (to `/tmp` and into `.git/hooks`), and its
  headless shell is auto-denied only for commands, not for file edits, so keryx
  keeps refusing `--write` for it. Write for Gemini is not planned.
- No model review of the diff. The mandatory review is you, on the diff that is
  shown.
- No auto-approve, no unattended landing, no push and no pull request from the
  landed branch.
- No network and no MCP for the writing agent. `claude` also gets no shell;
  `codex` keeps a sandboxed shell that can read files your account can read (see
  above).
- Little live history. The `claude` permission flags were probed against `claude`
  2.1.280; the `codex` confinement was measured live on `codex` 0.159.2 in a
  scratch git repository. Neither agent has a long record of write runs, so treat
  the first runs as unproven and read every diff.
