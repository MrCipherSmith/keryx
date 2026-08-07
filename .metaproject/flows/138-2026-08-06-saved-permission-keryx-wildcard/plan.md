# Implementation Plan

Status: ready

## Approach

Extend `PREFIX_BANNED` in `src/lib/shell-permissions.ts` and let the existing
machinery do the rest: `validateShellPattern` already consults it, and
`loadShellPermissionsWithAudit` already re-validates on load and reports every
dropped pattern, so a file written by an older keryx is filtered without a new
migration mechanism.

`keryx` gets its own reason string rather than the generic interpreter wording.
The honest sentence is specific: `keryx ctx run -- <anything>` runs an arbitrary
program, so the first token constrains nothing — and the destructive classifier
does not see through the `--`.

## Steps

1. **Add `keryx` to `PREFIX_BANNED`** with a reason naming `keryx ctx run --`.
2. **Add the execution wrappers** in the same category comment they belong to:
   `timeout`, `setsid`, `stdbuf`, `flock`, `unshare`, `strace`, `ltrace`,
   `busybox`, `parallel`, `command`, `chroot`, `expect`, `pwsh`, `powershell`,
   `sshpass`, `runuser`, `setpriv`.
3. **Invert the two frozen tests**, at
   `src/lib/shell-permissions-hardening.test.ts:185` and `:233`, with a comment
   at each stating what was asserted before and why it was wrong. `:233`'s
   expected surviving allowlist loses `keryx *` and its rejected list gains it.
4. **A test per newly banned word**, asserting the refusal AND that a narrowing
   pattern for the same word is still offerable (`keryx flow status*`,
   `timeout 5 bun test*`) — otherwise the fix quietly removes a capability the
   existing entries deliberately keep.
5. **An end-to-end assertion for the actual hole**: with a saved `keryx *`
   written by an older keryx, `isShellCommandAllowed("keryx ctx run -- rm -rf /")`
   must be false after load, and the audit must name the pattern and a reason.
6. **Check the other two lists while here.** `PREFIX_BANNED_READERS` and
   `PREFIX_BANNED_MUTATORS` are the same shape; state whether the corpus implies
   an addition to either, and say so explicitly if it does not.
7. **Docs.** Wherever the saved-permission behaviour is documented, the added
   words appear and the "expedient, not a boundary" framing is preserved. Do not
   upgrade the claim.
8. **Gate + draft PR.** `bun run check` and `bun run check:doc-links`, no test
   skipped or weakened.

## Risks

- **Someone relies on a saved `keryx *`.** They will be prompted again, once,
  and can save a narrower pattern. The audit reports the drop with a reason
  rather than dropping it silently — that path already exists and is the point.
- **Inverting a frozen test as a rider.** It is the whole flow here, not a
  rider; each inversion carries its own explanation at the assertion.
- **Treating this as the boundary.** It is not, and the docs must not start
  saying it is. Anything reachable through a word nobody listed is still
  reachable; that is what flow 137's mechanism is for.
