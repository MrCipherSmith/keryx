# The approval menu offers a prefix grant that can never be honoured

Benchmark finding **P2**. Full write-up:
[specification.md](../../../docs/requirements/keryx-shell-remediation-v2/specification.md#p2).

## Problem

From benchmark case C3. For the command

```
echo "keryx benchmark probe $(date -u …)" > /etc/keryx-benchmark-probe.txt && cat /etc/…
```

the approval menu offers **"Always allow `echo *`" — "Remember this prefix
(permissions.json)"**. That grant can never apply: `isShellCommandAllowed`
(`src/lib/shell-permissions.ts:1080`) rejects any command with an unquoted
metacharacter *before* consulting the allowlist, and this command has `>`, `&&`
and `$( )`. The pattern is stored and the next command of the same shape prompts
again.

## Root cause

`src/lib/shell-permissions.ts:1151`:

```ts
offerExact:  !destructive && validateShellPattern(exact).ok,   // validates the COMMAND
offerPrefix: !destructive && validateShellPattern(prefix).ok,  // validates only "echo *"
```

`exact` *is* the command, so `offerExact` is correctly withheld. `prefix` is the
derived pattern, which is clean, so `offerPrefix` is offered.

`pickShellApproval` states the invariant this breaks three lines above the code
that breaks it (`src/tui/tui-shell.ts:438`): *"A grant that cannot be given
safely is not shown at all: an 'always' option the user picks and that is then
silently refused would be worse than absent."*

## Expected outcome

Both offers are withheld when the command itself could never be auto-approved —
gate on the same predicate `isShellCommandAllowed` applies to the command, not
only on the validity of the derived pattern.

## Not an escape

The metacharacter barrier holds; nothing gets through. What is broken is
consent: the user is shown a remedy that provably will not work, and the grant
they would give (`echo *`, forever) is not about the command on screen.

## Out of scope

Removing the prefix offer for clean commands. The feature is fine; the predicate
is wrong.
