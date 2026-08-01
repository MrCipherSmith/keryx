# Resume point

Written 2026-08-01. Delete this file when the work below is finished — it exists
so a session that restarts can pick up without re-deriving anything.

## Where the work is

**Roadmap phase 1 = `docs/requirements/keryx-remote-entry/` (v1.1.0).** That
package specifies the whole remote surface; it is being built in slices.

| Slice | What it is | State |
|---|---|---|
| R4a | user-global project registry (`keryx projects`, `init` registers) | **merged** — flow 127, PR #215 |
| R4b | `keryx serve` skeleton: loopback listener, bearer auth, token lifecycle, `/v1/status` + `/v1/projects` | **flow 128 `done`, PR #216 open, in review** |
| R4c | turn submission (`task.submit`) + streaming | not started |
| R4d | asynchronous fail-closed approvals | not started |
| R4e | maintenance operations projected from `src/standard/command-registry.ts` | not started |
| R4f | one-time expiring loopback credential handoff | not started |
| R5–R7 | rest of phase 1 | not started |
| R8–R18 | later phases | not started |

`keryx-telegram-transport` (2.2.0) and `keryx-provider-auth` (1.0.0) are
specification-only and come after phase 1. `keryx-context-operations` and
`flow-reviewer` are specification-only with no scheduled slice.

**`docs/requirements/roadmap.md` still lists Keryx Remote Entry as
`specification ready (future)`. That is now false — R4a shipped and R4b is in
review. Update that row when #216 merges.**

## Immediate next step

PR #216 (`feat/128-serve-skeleton`) is green on CI and has been through **three**
adversarial review rounds. Round 4 fixes are committed. What remains:

1. Run a **fourth review round** on the newest commit alone. Use the prompt
   shape from the previous rounds: project-local reviewers under
   `.metaproject/skills/gdskills/review/`, instructed to assume the fixes are
   wrong until executed, and to reproduce the mutation counts claimed in the
   commit message.
2. If clean: merge with `gh pr merge 216 --squash --delete-branch`, sync `main`,
   then **verify the flow record survived the squash** — for PR #213 the squash
   captured the first commit's flow state and `main` landed with the flow still
   in-progress.
3. Update the Remote Entry row in `docs/requirements/roadmap.md` and bump its
   version + changelog.
4. Start R4c.

## Standing constraints that are easy to lose

- **ripgrep is not installed on this host.** `keryx ctx rg` exits 127. Use
  `grep` with `# keryx:raw ripgrep not installed on this host` appended so the
  gdctx PreToolUse hook allows it. The same hook rejects raw
  `head`/`tail`/`sed`/`cat`/`find` in pipelines.
- **No AI attribution anywhere** — no `Co-Authored-By`, no "Generated with", in
  commits, PR bodies, issues or comments.
- **Never read an exit code through a pipe.** `process.exitCode = undefined`
  does not reset in Bun; a piped read has already produced a false green here.
- **Security lines that must not be crossed in later slices:** no route may
  accept a secret over the remote surface; the remote policy profile may never
  be weaker than the local one (a widening resolution is a startup refusal); no
  subscription OAuth for Anthropic Claude Pro/Max or ChatGPT Plus/Pro — their
  consumer terms forbid third-party use and the cost lands on the operator.
- The **non-weakening profile check (spec AC-04)** is deliberately deferred out
  of R4b — this slice runs no turn and evaluates no policy decision, and there
  is no single `resolveLocalProfile` to compare against. It belongs with R4c.

## Review history on #216, and why it matters

Three rounds, and rounds 1 and 2 each shipped a defect **inside the fix they
were named for** — the failure mode
`.metaproject/memory/lessons/a-fix-round-needs-its-own-review-…` describes:
fixing the site the finding points at rather than the class.

- Round 1 tightened one writer of five of the shared config directory.
- Round 2 corrected one operator instruction of four, and the correction broke
  the other three.
- Round 3 found both, plus a `--force` "fix" that made a broken instruction work
  by destroying the deployment.

What worked, and should be the default for R4c: **make the guard the class.**
`src/lib/config-dir.permissions.test.ts` drives every writer of the config
directory under `umask 002`; `src/commands/serve.recovery.test.ts` enumerates
every configuration state, runs `serve` / `serve status` / `config show`,
extracts the instruction each prints, and **executes it**, requiring exit 0.
Both were themselves mutation-checked — the second one caught a real defect the
substring version of it could not see.

## Local machine state

- `~/.local/share/keryx/projects.json` was cleaned on 2026-08-01: it held 1039
  dead `/tmp` entries from test runs. Backup at
  `/home/altsay/keryx-projects-backup-2026-08-01.json`. It now holds one entry,
  the real project. `bunfig.toml`'s `[test].preload` stops the suite writing
  there again.
