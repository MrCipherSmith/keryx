# Review Report — MrCipherSmith/keryx#499

## Verdict: APPROVE_WITH_SUGGESTIONS

## Summary

One round of review-orchestrator over the MCP publisher-surface rename. Two
findings, both blocking, both fixed and both re-verified by executing the thing
under discussion rather than by re-reading the patch.

The finding worth naming is the second one. `integrate --remove <editor>
--dry-run` performed a real removal. That behaviour pre-existed the branch — but
the branch rewrote the help text and dropped the old "install only" qualifier,
which turned a documented limitation into a documentation lie. A pre-existing
bug that a rename makes untrue is the rename's problem.

The first is the same shape as the defect this repository keeps recording: a
guard that could not establish what it reported. The was-to-is exemption in
`scripts/check-retired-cli-spellings.ts` matched any line containing both the
retired and the replacement spelling, so ordinary prose mentioning both was
exempt from the gate that exists to catch ordinary prose.

Recorded separately because review did not catch it: two lint errors reached CI.
They reached CI because the linter cannot run on this machine — eslint,
@eslint/js and typescript-eslint are declared in package.json and absent from
node_modules. That is an environment gap, not a review gap, and it is open.

## Review Scope

PR #499, branch `docs/keryx-mcp-servers`, 12 commits, merged as d15052d8.
Renames `keryx mcp serve` to `keryx serve-mcp`, `keryx mcp install` to `keryx
integrate <editor>`, `keryx mcp uninstall` to `keryx integrate --remove
<editor>`, and adds `/integrations`. Old spellings kept as thin aliases.

## Findings

### R1-LOGIC-001 — the was-to-is exemption was exploitable by shape

`isWasIsRow` returned true for any line containing a retired spelling and its
replacement anywhere in the line. The reviewer's counterexample —

    | Tip | run `keryx mcp install --runtime cursor` (or the new `keryx integrate cursor`) |

— is prose instructing a reader to run the retired command, and the gate
exempted it. Confirmed by running the gate against that line: 0 undeclared.

Fixed by requiring genuine cell pairing: split the row on `|`, and exempt only
when a cell starting with the retired spelling is directly adjacent to a cell
starting with its replacement. Verified by dropping the reviewer's exact line
into `docs/`, where the gate now reports 1 undeclared.

### R1-LOGIC-002 — `--remove --dry-run` removed for real

`uninstallMcpClient` took no dry-run parameter, so the flag was accepted,
documented and ignored. Fixed by threading `options: { dryRun?: boolean }`
through and previewing instead of writing.

Mutation-proved rather than asserted: reverting the guard fails the named test
on file contents — the file is still present after a `--dry-run` that claimed to
preview — and not on an import or syntax error, which was the failure mode that
made three earlier mutation attempts in this session invalid evidence.

## Verification

Every check ran the working tree, never the installed `keryx`, which is 0.2.84
and does not contain this change. The two tests needing a process spawn
`process.execPath src/cli.ts`.

- full suite: 8389 pass, 2 fail — both pre-existing and reproduced on clean
  HEAD (NUL bytes in gitignored benchmark artifacts; a missing optional
  dependency that PR #488 fixes)
- `tsc`: clean
- retired-spelling gate: 2318 files scanned, 59 retired spellings, 0 undeclared
- CI: 18 success, 1 skipped, 0 failed

## Open, not fixed here

- The linter cannot run locally (dependencies absent from node_modules). Two
  errors reached CI in this PR as a direct result.
- AC8's arithmetic does not close as frozen. Raw occurrences of `keryx mcp
  install` and `keryx mcp uninstall` went UP, because the change itself adds
  deliberate mentions: was-to-is tables, deprecation-notice tests, and the
  guard's own RETIREMENTS map and fixtures. Closure is enforced by the gate
  reporting 0 undeclared, not by subtraction. Recorded on the AC confirmation.
