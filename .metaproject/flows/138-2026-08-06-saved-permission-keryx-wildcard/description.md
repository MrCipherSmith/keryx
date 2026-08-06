# Close the `keryx *` hole in saved shell permissions, and the execution wrappers the list never learned

Status: ready
Source: deferred items 3 and 4 of
`docs/requirements/_launch-prompts/resume-benchmark-remediation.md`; the wrapper
list is corpus C-2/C-3 of `docs/requirements/keryx-unattended-posture/specification.md`.

## Problem

`src/lib/shell-permissions.ts` refuses to *remember* a bare "everything after
this word" grant for words whose first token says nothing about what will run —
`bash *`, `sudo *`, `curl *`, `docker *`, `git *`. The list is called out in its
own header as an EXPEDIENT rather than a boundary. Two entries are missing from
it, and both are reachable today on the **supervised** path.

**`keryx *`.** With that grant saved, `isShellCommandAllowed` auto-approves
`keryx ctx run -- rm -rf /` with no prompt: the destructive classifier inspects
the command line it is given and does not see through `keryx ctx run --` to the
program on the other side. The grant is not hypothetical — this repository's own
`CLAUDE.md` instructs agents to route commands through `keryx ctx run`, so
`keryx *` is exactly the pattern a user of this project would save. Two tests
currently pin the hole open as if it were the intended behaviour:
`src/lib/shell-permissions-hardening.test.ts:185` asserts `validateShellPattern("keryx *").ok === true`,
and `:233` asserts the migration *keeps* `keryx *` when filtering an older file.

**The ~14 missing wrappers.** Review round 3 of PR #253 executed
`timeout 5 sh -c 'cat ~/.ssh/id_rsa'` and fourteen more of the same shape:
`timeout`, `setsid`, `stdbuf`, `flock`, `unshare`, `strace`, `ltrace`,
`busybox`, `parallel`, `command`, `chroot`, `expect`, `pwsh`, `powershell`,
`sshpass`, `runuser`, `setpriv`. Every one is in a category `PREFIX_BANNED`
already covers — generic wrappers that execute their argument — and every one is
absent from it. That corpus was collected against the (now descoped) unattended
allowlist, but `PREFIX_BANNED` is the *supervised* saved-permission path and the
same words are missing there.

## Expected Outcome

- `keryx` and the missing execution wrappers are refused as bare prefix grants,
  each with the category reason the existing entries give.
- A permission file written by an older keryx that already contains `keryx *`
  (or any newly-banned word) is **rejected on load**, reported in the audit, and
  not silently honoured — the migration path already exists and must cover them.
- The two frozen tests are inverted deliberately, with the inversion explained
  where it is made, rather than edited as a rider on something else.
- A narrower pattern stays offerable: `keryx flow status*` still constrains its
  arguments and is not a bare grant, exactly as `bun test*` is today.

## Out of Scope

- The unattended posture — that is **flow 137**, and this hole is not reachable
  from an unattended run (both shells consult the unattended approver first).
- Rewriting containment to stop being a list. `PREFIX_BANNED` is an expedient by
  its own declaration; the boundaries are the metacharacter rule and the
  destructive classifier. This flow completes the expedient and must not claim
  more for it than that.
- Teaching the destructive classifier to see through `keryx ctx run --`. Worth
  doing, changes the classifier's contract, and is not what this fix needs.
