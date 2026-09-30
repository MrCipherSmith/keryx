# Let an external agent write

`claude-cli` can change files for you, but not in your checkout. The run happens
in a throwaway git worktree, its diff is stored as a pending review, and a change
reaches your repository only as a new local branch that you approved by reading the
diff and typing back part of its hash.

This is the only write path for an external agent that keryx applies itself.
`codex-cli` and `antigravity-cli` refuse `--write` with the reason "write mode is
claude-only in this release". `gemini-acp --write` is a different mechanism whose
patch keryx never applies; see the [ACP client guide](acp-client.md).

Everything on this page needs the external agent capability to be on, as for any
[external child](../harness.md#external-children-a-vendor-cli-as-a-child-agent):
`externalAgents.enabled: true` in your user config, and `claude` installed and
logged in.

## Run it

```bash
keryx agents external run claude-cli --task "Add a --json flag to the status command" --write
```

keryx cuts a worktree from the current commit (it needs a git checkout with at
least one commit; uncommitted changes are not in it) and starts `claude` there with
only the tools `Read Grep Glob Edit Write`: no shell, no network, no MCP server. The
launch flags are `--tools Read Grep Glob Edit Write --permission-mode acceptEdits
--permission-prompts none`, so an edit inside the worktree goes through, a write
outside it is denied, and any other question is refused instead of asked.

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

- No write for `codex-cli` or `antigravity-cli`.
- No model review of the diff. The mandatory review is you, on the diff that is
  shown.
- No auto-approve, no unattended landing, no push and no pull request.
- No shell, network or MCP for the writing agent.
- Not yet verified end to end. The permission flags were probed against `claude`
  2.1.280; a full write run through the installed CLI has not been recorded, so
  treat the first runs as unproven and read every diff.
