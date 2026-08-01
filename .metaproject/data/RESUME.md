# Resume point

Written 2026-08-01. Delete this file when the work below is finished — it exists
so a session that restarts can pick up without re-deriving anything.

## Where the work is

**Roadmap phase 1 = `docs/requirements/keryx-remote-entry/` (v1.2.0).** That
package specifies the whole remote surface; it is being built in slices.

| Slice | What it is | State |
|---|---|---|
| R4a | user-global project registry (`keryx projects`, `init` registers) | **merged** — flow 127, PR #215 |
| R4b | `keryx serve` skeleton: loopback listener, bearer auth, token lifecycle, `/v1/status` + `/v1/projects` | **merged** — flow 128, PR #216, squashed to `05a9a8e3` |
| R4c | turn submission (`task.submit`) + streaming | not started |
| R4d | asynchronous fail-closed approvals | not started |
| R4e | maintenance operations projected from `src/standard/command-registry.ts` | not started |
| R4f | one-time expiring loopback credential handoff | not started |
| R5–R7 | rest of phase 1 | not started |
| R8–R18 | later phases | not started |

`keryx-telegram-transport` (2.2.0) and `keryx-provider-auth` (1.0.0) are
specification-only and come after phase 1. `keryx-context-operations` and
`flow-reviewer` are specification-only with no scheduled slice.

Done on 2026-08-01: the Remote Entry row in `docs/requirements/roadmap.md` now
reads `implemented (R4a–R4b); R4c–R4f open` (roadmap 0.11.0), and the package
README Status block — which asserted that no HTTP server or network listener is
introduced — was corrected with the slice table (README 1.2.0).

## Immediate next step

**Carry-over debt, stated plainly: PR #216 was merged on operator instruction
without the fourth review round this file asked for.** Rounds 1 and 2 each
shipped a defect inside the fix they were named for, so the newest commit
(`3ad92b22`, "bound every reader, and make the writers guard able to fail") is
the one commit in the slice that no adversarial round has executed. Merging did
not discharge that; it moved it onto `main`.

1. Run that round against `main` now, scoped to `5c3139a3..05a9a8e3` — the
   post-completion fix commits. Project-local reviewers under
   `.metaproject/skills/gdskills/review/`, instructed to assume the fixes are
   wrong until executed, and to reproduce the mutation counts claimed in the
   commit messages. Anything found lands as a follow-up PR, not a revert.
2. Start R4c. Note that `docs/requirements/keryx-remote-entry/` has **no**
   `launch-prompts/` directory — R4a and R4b were launched from prompts that
   were never written to the repo, unlike `keryx-sandbox-credential-auto-mask`
   and `keryx-sandbox-harness-hardening`, which both keep one file per slice.
   Write `launch-prompts/R4c-flow-orchestrator.md` before launching, so the
   next slice is reproducible from the repo alone.

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
