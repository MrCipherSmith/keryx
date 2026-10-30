# Team Hub connector and Git delivery

Run the new source checkout/release CLI with Bun. An older installed `keryx` does not have these commands. The standalone entry shares the same handler and avoids installing the CLI globally:

```bash
bun --no-env-file --config=/dev/null /absolute/path/to/keryx/src/hub/client-main.ts --help
```

The examples below use `keryx hub`; substitute the standalone invocation above, without the `hub` word. Always run from the checkout you intend to bind/change.

```bash
export KERYX_HUB_TOKEN='<human or agent bootstrap token>'
keryx hub connect --url http://127.0.0.1:7331 --project '<project ID>'
keryx hub import
keryx hub sync
keryx hub submit --message 'Implement selected specification'
keryx hub pull
keryx hub pull --revision '<revision ID>' --apply
keryx hub fetch --delivery '<published delivery ID>'
```

`--token-env NAME` overrides the credential environment variable on each client command. Tokens stay in the environment; they are never saved in the checkout. The authoritative explicit binding is permission 0600 under `$XDG_CONFIG_HOME/keryx/hub/bindings/` (default `~/.config`), keyed by absolute checkout path. `.metaproject/hub.json` is a credential-free checkout hint. A cloned/copied hint does not authorize sending a credential to its URL: each checkout must explicitly connect. Existing bindings cannot silently change project/URL. Separate worktrees and clones receive distinct checkout IDs. Git common-directory is recorded only as a hint; it never auto-binds a clone. Remote Hub URLs require HTTPS; HTTP is allowed for loopback and SSH-tunnel use. Redirects are refused.

`import` reads Markdown only below `openspec/specs`, `openspec/changes`, and `.metaproject/wiki`, without invoking/installing OpenSpec. Symlinks, paths escaping the checkout, documents over 1 MiB and more than 10,000 documents fail visibly. Requests batch at most 500 documents and approximately 8 MiB of encoded JSON. A later batch can fail after earlier ones succeeded; rerun imports reconcile stable paths and do not invent approvals. Existing canonical content changes become proposals.

`sync` refreshes the shared `$XDG_CACHE_HOME/keryx/hub/<server-project-hash>/context.json` cache (default `~/.cache`). All explicitly connected clones/worktrees for that server/project share it. It preserves existing `.metaproject/index.md` content and adds/replaces only the `keryx:hub` block; first insertion makes an adjacent timestamped backup. It does not rewrite the local wiki tree. Treat the cache as canonical context, not an approval inferred from imported Markdown. Inspect/commit intended tracked index changes before code pull.

`submit` reads all tracked regular files from the working tree, including binary data/executable mode, and sends a full initial snapshot followed by changed/deleted entries. It rejects unresolved index entries, symlinks, submodules, unsafe paths and snapshots exceeding 5,000 files/20 MiB. Stage new paths with Git before submitting; untracked/ignored files are not source files. Missing tracked files represent deletion. Credentials and the checkout binding should stay untracked. API writes carry idempotency keys and use the server's exact revision responses; a network failure requires checking Hub history before repeating a submit because client-side pending operation recovery is not implemented.

`pull` previews selected line content by default, or a named immutable revision with `--revision`. `--apply` checks for staged changes, untracked/ignored collisions, symlink ancestors and active Git operations, then writes a recovery journal before changing files. Git HEAD and index stay unchanged. The journal includes original bytes/modes and intended changes under the checkout's Git `hub-checkpoints/<operation>/journal.json`, and remains after success. A later selected revision may apply over an unchanged previously applied Hub snapshot without an intervening Git commit. A user edit after that snapshot is refused. Submitted-but-unselected work is not treated as the applied baseline.

If interrupted, stop editing and inspect the reported journal. `files` contains each prior file's base64 bytes and mode; `changes` contains every intended write/delete. Restore prior files from `files`, and remove only paths newly created by that operation after verifying their current bytes still match `changes`. Keep the journal until recovery is verified. There is no cross-file filesystem transaction or automatic recovery command in this prototype. Do not blindly restore over subsequent work.

## Server-side publication

A human selects an exact revision on the Hub line and explicitly publishes it to a configured remote/base branch. `keryx hub serve` starts the same Hub server entry as the direct server script, configured by `KERYX_HUB_*` environment variables; it does not change existing `keryx serve` or shell behavior.

The adapter reuses a managed per-project/per-remote bare cache under the Hub data directory, fetches the current base, builds the exact selected tree relative to its declared `gitBaseSha`, and applies that commit using Git's actual three-way cherry-pick. Independent remote edits survive; overlapping conflicts return a visible conflict with no branch push. It publishes only a unique `codex/hub-<project-hash>-<operation-hash>` branch using a normal, non-force push. Base/user branches are never pushed or rewritten. A durable receipt and operation marker reconcile repeated operations, including an interrupted response after a completed push. A changed/disappeared published branch is a visible error, not silent republication.

Git uses argument arrays, a restricted environment, disabled hooks/global configuration and 30-second subprocess limits. Credential-bearing HTTPS URLs and unsupported transport/option/control-character inputs are refused. Local absolute bare repositories are supported for explicit operator configuration and tests. Authentication is noninteractive; configure server-side SSH access externally. Default Git stderr is not exposed, avoiding credential leakage. Cache access serializes per project; simultaneous publication returns a visible failure. A process killed while holding the lock may require an operator to confirm no Git process remains and remove the managed project's `lock` directory before retrying.

Publication returns actual branch, commit and tree IDs. `hub fetch --delivery ID` fetches the managed branch into a separate `refs/keryx-hub/` reference, verifies the exact receipt commit/tree and selected changes/deletions against the revision Git base, and returns a delivered-tree path preview (including independent remote edits). A moved branch or ambiguous mapping is refused. Fetch is safe with local edits because it never changes working files, HEAD or index. This prototype does not create GitHub PRs, merge branches, move local Git HEAD or automatically reanchor dirty/diverged code. Choose whether to merge/rebase/reset through your normal Git workflow after inspecting the verified receipt. The tested Git remotes are temporary local bare repositories only; development never pushes to the user's external remote.

## Executed checks

Focused Bun tests cover live HTTP against the actual SQLite app, two distinct clone bindings, canonical shared sync/import, incremental code updates/deletion, preview/checkpointed apply, successive line pulls and local edit refusal; real Git tests cover independent remote edits, managed branch receipt retry, and three-way conflict with unchanged base. The implementation was first exercised RED with absent modules, then made GREEN.
